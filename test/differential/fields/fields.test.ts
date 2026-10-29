// The simple fields (src/fields) against the reference PocketBase v0.41.0
// binary. Not part of `bun test`: run `bun run test:reference`.
//
// On a fresh upstream install, the test creates collections through
// POST /api/collections and records through
// POST /api/collections/{c}/records, and models each request with
// src/fields:
//
//   - settings: each field is read with unmarshalJSON from the same JSON,
//     added to a model collection after the default "id" field (as
//     FieldsList.Add does, with "<type><crc32 of name>" ids) and checked
//     with validateSettings. Accepted collections: the stored
//     `_collections.fields` and the response's `fields` must equal the
//     model's FieldsList form (each field's marshalJSON decoded into a map,
//     "type" added, the list marshaled with sorted keys, as
//     FieldsList.MarshalJSON does), byte for byte. Rejected ones: the error
//     body's `data` must equal the model's errors ({fields: {index: err}})
//     rendered by src/server/error.ts, byte for byte (codes, messages,
//     params).
//   - values: the request body is decoded as upstream decodes it (json v2
//     into map[string]any), set on a model record with the fields' setters
//     (record.Set), the interceptors run for "validate" (the id field's
//     autogenerate), and every field is checked with validateValue. A
//     rejected record: the error `data` must match byte for byte. An
//     accepted one: each column upstream stored (typeof and value, read
//     from data.db after upstream stops) must equal the model's
//     driverValue (or the value's own db Valuer) stored in a table with
//     the fields' columnType, and GET's record body must equal the model
//     record read back from that row (Go's NullString scan, then
//     prepareValue), byte for byte.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  InterceptorActionValidate,
  isDriverValuer,
  isRecordInterceptor,
  type Field,
} from "@/fields/field";
import { fieldFactory } from "@/fields/fields";
import { newBadRequestError } from "@/server/error";
import { anyType, bytesToText, mapOf, marshal, unmarshal } from "@/tools/types/go-json";
import { jsonArrayValue } from "@/tools/types/json-array";
import { Errors, formatFloatV } from "@/validation/error";

import { runUpstream } from "@test/differential/db/fixture";
import {
  invalidSettings,
  validSettings,
  valueCases,
  valueCollections,
  type FieldDef,
} from "@test/differential/fields/cases";
import {
  TestRecord,
  TestCollection,
  newBaseCollection,
  noDBApp,
  interceptorArgs,
} from "@test/support/fields";
import { startUpstream, type UpstreamServer } from "@test/support/upstream";

const email = "fields@example.com";
const password = "1234567890";

let root: string;
let dataDir: string;
let upstream: UpstreamServer | undefined;
let token: string;

const app = noDBApp();

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "iglo-base-fields-ref-"));
  dataDir = join(root, "pb_data");
  const upsert = await runUpstream(
    ["superuser", "upsert", email, password, "--dir", dataDir],
    root,
  );
  expect(upsert.exitCode).toBe(0);
  upstream = await startUpstream({ dataDir });
  const res = await fetch(`${upstream.url}/api/collections/_superusers/auth-with-password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identity: email, password }),
  });
  expect(res.status).toBe(200);
  token = ((await res.json()) as { token: string }).token;
});

afterAll(async () => {
  await upstream?.stop();
  rmSync(root, { recursive: true, force: true });
});

async function request(
  method: string,
  path: string,
  body?: string,
): Promise<{ status: number; text: string }> {
  if (upstream === undefined) {
    throw new Error("upstream is not running");
  }
  const res = await fetch(`${upstream.url}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: token },
    ...(body === undefined ? {} : { body }),
  });
  return { status: res.status, text: await res.text() };
}

// the `data` member of an upstream error body, as its bytes
function errorData(body: string): string {
  expect(body.startsWith(`{"data":`)).toBe(true);
  return body.slice(`{"data":`.length, body.lastIndexOf(`,"message":`));
}

// the model's error body `data` for a validation error
function modelErrorData(err: Error): string {
  return marshal(newBadRequestError("", err).data);
}

// ---------------------------------------------------------------------
// the model collection

function modelField(def: FieldDef): Field {
  const factory = fieldFactory(def.type);
  if (factory === undefined) {
    throw new Error(`unknown field type ${def.type}`);
  }
  const field = factory();
  field.unmarshalJSON(JSON.stringify(def));
  return field;
}

function modelCollection(name: string, defs: FieldDef[]): TestCollection {
  const collection = newBaseCollection(name);
  for (const def of defs) {
    collection.fields.add(modelField(def));
  }
  return collection;
}

// CollectionValidator's checkFieldValidators: {index: err}
function settingsErrors(collection: TestCollection): Errors | null {
  const errs = new Errors();
  for (const [i, field] of [...collection.fields].entries()) {
    const err = field.validateSettings(app, collection);
    if (err !== null) {
      errs.errors[String(i)] = err;
    }
  }
  return errs.size > 0 ? errs : null;
}

// FieldsList.MarshalJSON
function fieldsListJSON(collection: TestCollection): string {
  return marshal(
    [...collection.fields].map((field) => {
      const data = unmarshal(field.marshalJSON(), mapOf(anyType)) as Record<string, unknown>;
      data.type = field.type();
      return data;
    }),
  );
}

// the bytes of the `fields` member of a collection response
function responseFields(body: string): string {
  const start = body.indexOf(`"fields":`) + `"fields":`.length;
  return body.slice(start, body.indexOf(`,"indexes":`, start));
}

// _collections.fields of a collection, read from upstream's data.db
function storedFields(db: Database, name: string): string {
  const row = db.query("SELECT fields FROM _collections WHERE name = ?").get(name) as {
    fields: string;
  };
  return row.fields;
}

interface CreatedCollection {
  model: TestCollection;
  responseFields: string;
}

const createdCollections: CreatedCollection[] = [];

async function createCollection(
  name: string,
  defs: FieldDef[],
): Promise<{ status: number; text: string }> {
  return request("POST", "/api/collections", JSON.stringify({ name, type: "base", fields: defs }));
}

// posts the collection and compares upstream's answer with the model's:
// the error data of a rejected one, the field JSON of an accepted one
async function checkCollection(name: string, defs: FieldDef[]): Promise<number> {
  const model = modelCollection(name, defs);
  const errs = settingsErrors(model);

  const res = await createCollection(name, defs);

  if (errs !== null) {
    expect({
      status: res.status,
      data: res.status === 400 ? errorData(res.text) : res.text,
    }).toEqual({ status: 400, data: modelErrorData(new Errors({ fields: errs })) });
    return res.status;
  }
  expect({ status: res.status, body: res.status === 200 ? "" : res.text }).toEqual({
    status: 200,
    body: "",
  });
  expect(responseFields(res.text)).toBe(fieldsListJSON(model));
  createdCollections.push({ model, responseFields: responseFields(res.text) });
  return res.status;
}

describe("settings: accepted", () => {
  for (const [type, list] of Object.entries(validSettings)) {
    test(type, async () => {
      const defs = list.map((settings, i): FieldDef => ({
        ...settings,
        name: `${type}_${i}`,
        type,
      }));
      expect(await checkCollection(`f_${type}`, defs)).toBe(200);
    });
  }
});

describe("settings: rejected", () => {
  for (const [i, def] of invalidSettings.entries()) {
    test(`${i} ${def.type} ${JSON.stringify(def).slice(0, 80)}`, async () => {
      expect(await checkCollection(`bad_${i}`, [def])).toBe(400);
    });
  }
});

// ---------------------------------------------------------------------
// values

const valueModels = new Map<string, { model: TestCollection; id: string }>();

interface StoredRecord {
  collection: string;
  id: string;
  // the model's stored columns: name -> [typeof, value]
  columns: Record<string, [string, unknown]>;
}

const storedRecords: StoredRecord[] = [];

// the value a record field is bound with: DriverValue, or the value's own
// driver.Valuer (DateTime, JSONRaw, GeoPoint; JSONArray for arrays)
function bindValue(field: Field, record: TestRecord): unknown {
  let v: unknown;
  if (isDriverValuer(field)) {
    const [dv, err] = field.driverValue(record);
    expect(err).toBeNull();
    v = dv;
  } else {
    v = record.getRaw(field.getName());
  }
  if (Array.isArray(v)) {
    return jsonArrayValue(v);
  }
  if (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { value?: unknown }).value === "function"
  ) {
    return (v as { value(): unknown }).value();
  }
  return v;
}

// stores the model record in an in-memory table with the fields' column
// types: name -> [typeof, value]
function storeModel(
  collection: TestCollection,
  record: TestRecord,
): Record<string, [string, unknown]> {
  const fields = [...collection.fields].filter((f) => f.getName() !== "id");
  const db = new Database(":memory:", { safeIntegers: false });
  try {
    db.run(
      `CREATE TABLE t (${fields.map((f) => `"${f.getName()}" ${f.columnType(app)}`).join(", ")})`,
    );
    const values = fields.map((f) => bindValue(f, record)) as (
      | string
      | number
      | boolean
      | null
      | Uint8Array
    )[];
    db.query(`INSERT INTO t VALUES (${fields.map(() => "?").join(", ")})`).run(...values);
    return readColumns(
      db,
      "t",
      fields.map((f) => f.getName()),
      null,
    );
  } finally {
    db.close();
  }
}

function readColumns(
  db: Database,
  table: string,
  names: string[],
  id: string | null,
): Record<string, [string, unknown]> {
  const select = names.map((n) => `typeof("${n}"), "${n}"`).join(", ");
  const stmt = db.prepare(`SELECT ${select} FROM "${table}"${id === null ? "" : ` WHERE id = ?`}`);
  const row = (id === null ? stmt.values() : stmt.values(id))[0] as unknown[];
  const out: Record<string, [string, unknown]> = {};
  for (const [i, n] of names.entries()) {
    out[n] = [row[2 * i] as string, row[2 * i + 1]];
  }
  return out;
}

// database/sql's NullString scan of a column (convertAssign): integers in
// decimal, reals with strconv.FormatFloat(f, 'g', -1, 64), NULL invalid
function nullString([type, value]: [string, unknown]): string | null {
  switch (type) {
    case "null":
      return null;
    case "integer":
      return String(value);
    case "real":
      return formatFloatV(value as number);
    case "blob":
      return bytesToText(value as Uint8Array);
    default:
      return value as string;
  }
}

// the GET body of the model record read back from its stored columns
// (newRecordFromNullStringMap, then the record's JSON export)
function modelRecordBody(
  collection: TestCollection,
  collectionId: string,
  id: string,
  columns: Record<string, [string, unknown]>,
): string {
  const read = new TestRecord(collection);
  const out: Record<string, unknown> = {
    collectionId,
    collectionName: collection.name,
    id,
  };
  for (const field of collection.fields) {
    const name = field.getName();
    if (name === "id") {
      continue;
    }
    const [v, err] = field.prepareValue(read, nullString(columns[name] as [string, unknown]));
    expect(err).toBeNull();
    out[name] = v;
  }
  // the API response writer allows invalid UTF-8 (router Event.JSON)
  return marshal(out, { allowInvalidUTF8: true });
}

describe("values", () => {
  beforeAll(async () => {
    for (const { name, fields } of valueCollections) {
      const model = modelCollection(name, fields);
      expect(settingsErrors(model)).toBeNull();
      const res = await createCollection(name, fields);
      expect(res.status).toBe(200);
      const id = (JSON.parse(res.text) as { id: string }).id;
      valueModels.set(name, { model, id });
    }
  });

  for (const [i, [collectionName, key, valueJSON]] of valueCases.entries()) {
    test(`${i} ${collectionName}.${key} = ${valueJSON.slice(0, 60)}`, async () => {
      const { model, id: collectionId } = valueModels.get(collectionName) as {
        model: TestCollection;
        id: string;
      };
      const bodyText = `{${JSON.stringify(key)}:${valueJSON}}`;

      // the model: record.Load of the decoded body, the "validate"
      // interceptors, then every field's ValidateValue
      const body = unmarshal(bodyText, mapOf(anyType)) as Record<string, unknown>;
      const record = new TestRecord(model);
      record.set(key, body[key]);
      for (const field of model.fields) {
        if (isRecordInterceptor(field)) {
          await field.intercept(
            ...interceptorArgs(app, record),
            InterceptorActionValidate,
            async () => {},
          );
        }
      }
      const errs = new Errors();
      for (const field of model.fields) {
        const err = field.validateValue(app, record);
        if (err !== null) {
          errs.errors[field.getName()] = err;
        }
      }

      const res = await request("POST", `/api/collections/${collectionName}/records`, bodyText);

      if (errs.size > 0) {
        expect({
          status: res.status,
          data: res.status === 400 ? errorData(res.text) : res.text,
        }).toEqual({
          status: 400,
          data: modelErrorData(errs),
        });
        return;
      }
      expect({ status: res.status, body: res.status === 200 ? "" : res.text }).toEqual({
        status: 200,
        body: "",
      });

      const id = (JSON.parse(res.text) as { id: string }).id;
      const columns = storeModel(model, record);
      storedRecords.push({ collection: collectionName, id, columns });

      const got = await request("GET", `/api/collections/${collectionName}/records/${id}`);
      expect(got.status).toBe(200);
      expect(got.text).toBe(modelRecordBody(model, collectionId, id, columns));
    });
  }
});

describe("stored data", () => {
  let db: Database;

  beforeAll(async () => {
    await upstream?.stop();
    upstream = undefined;
    // read-write: a read-only connection cannot create the WAL index (-shm)
    // on macOS; this is a temporary copy that no server uses any more
    db = new Database(join(dataDir, "data.db"));
  });

  afterAll(() => {
    db.close();
  });

  test("_collections.fields of the accepted collections", () => {
    expect(createdCollections.length).toBe(Object.keys(validSettings).length);
    for (const { model, responseFields: fromResponse } of createdCollections) {
      expect({ name: model.name, fields: storedFields(db, model.name) }).toEqual({
        name: model.name,
        fields: fieldsListJSON(model),
      });
      expect(fromResponse).toBe(fieldsListJSON(model));
    }
  });

  test("record columns", () => {
    expect(storedRecords.length).toBeGreaterThan(50);
    for (const { collection, id, columns } of storedRecords) {
      const stored = readColumns(db, collection, Object.keys(columns), id);
      expect({ collection, id, columns: stored }).toEqual({ collection, id, columns });
    }
  });
});

test("the sample is large enough", () => {
  const settingCombos =
    Object.values(validSettings).reduce((n, list) => n + list.length, 0) + invalidSettings.length;
  expect(settingCombos).toBeGreaterThanOrEqual(30);
  expect(valueCases.length).toBeGreaterThanOrEqual(150);
});
