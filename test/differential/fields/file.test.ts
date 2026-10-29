// The file field (src/fields/file.ts, src/tools/filesystem/file.ts,
// src/validators/file.ts) against the reference PocketBase v0.41.0
// binary. Not part of `bun test`: run `bun run test:reference`.
//
//   - settings: collections created through POST /api/collections, one at
//     a time (upstream reloads its collection cache after each save), give
//     the same field JSON or the same error `data` as the model, byte for
//     byte; raw field JSON texts with large or invalid ints too;
//   - uploads: multipart requests to POST and PATCH
//     /api/collections/{c}/records. The model reads the same request bytes
//     with Bun's formData(), builds Files with NewFileFromMultipart and
//     follows upstream's record_crud.go (recordDataFromRequest:
//     ReplaceModifiers, the uploaded files merged under their keys,
//     ReplaceModifiers again, then RecordUpsert.Load and every field's
//     ValidateValue). Error `data` must be identical; for an accepted
//     request the stored names must equal the model's except for the
//     10-character random parts (the model's random source writes unique
//     markers there, which match [a-z0-9]{10});
//   - stored data: with upstream stopped, the record columns (typeof and
//     value) and `_collections.fields` are compared with the model's.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FieldNameId, isDriverValuer, isSetterFinder, type Field } from "@/fields/field";
import { FileField } from "@/fields/file";
import { fieldFactory } from "@/fields/fields";
import { newBadRequestError } from "@/server/error";
import { NewFileFromMultipart, type File, type RandomSource } from "@/tools/filesystem/file";
import { toUniqueStringSlice } from "@/tools/list/list";
import { anyType, mapOf, marshal, textToBytes, unmarshal } from "@/tools/types/go-json";
import { jsonArrayValue } from "@/tools/types/json-array";
import { Errors } from "@/validation/error";

import { runUpstream } from "@test/differential/db/fixture";
import type { FieldDef } from "@test/differential/fields/cases";
import {
  invalidSettings,
  rawSettings,
  uploadCases,
  validSettings,
  valueCollections,
  type Content,
  type Part,
  type UploadCase,
} from "@test/differential/fields/file-cases";
import { TestCollection, TestRecord, newBaseCollection, noDBApp } from "@test/support/fields";
import { startUpstream, type UpstreamServer } from "@test/support/upstream";

const email = "fields@example.com";
const password = "1234567890";

let root: string;
let dataDir: string;
let upstream: UpstreamServer | undefined;
let token: string;

// the file field needs no database
const app = noDBApp();

async function request(
  method: string,
  path: string,
  body?: string | Uint8Array,
  contentType = "application/json",
  auth = true,
): Promise<{ status: number; text: string }> {
  if (upstream === undefined) {
    throw new Error("upstream is not running");
  }
  const res = await fetch(`${upstream.url}${path}`, {
    method,
    headers: {
      "content-type": contentType,
      ...(auth ? { authorization: token } : {}),
    },
    ...(body === undefined ? {} : { body }),
  });
  return { status: res.status, text: await res.text() };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "iglo-base-fields-file-ref-"));
  dataDir = join(root, "pb_data");
  const upsert = await runUpstream(
    ["superuser", "upsert", email, password, "--dir", dataDir],
    root,
  );
  expect(upsert.exitCode).toBe(0);
  upstream = await startUpstream({ dataDir });
  const res = await request(
    "POST",
    "/api/collections/_superusers/auth-with-password",
    JSON.stringify({ identity: email, password }),
    "application/json",
    false,
  );
  expect(res.status).toBe(200);
  token = (JSON.parse(res.text) as { token: string }).token;
});

afterAll(async () => {
  await upstream?.stop();
  rmSync(root, { recursive: true, force: true });
});

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
// settings

function modelField(text: string): Field {
  const { type } = unmarshal(text, mapOf(anyType)) as { type: string };
  const factory = fieldFactory(type);
  if (factory === undefined) {
    throw new Error(`unknown field type ${type}`);
  }
  const field = factory();
  field.unmarshalJSON(text);
  return field;
}

function modelCollection(name: string, defs: FieldDef[]): TestCollection {
  const collection = newBaseCollection(name);
  for (const def of defs) {
    collection.fields.add(modelField(JSON.stringify(def)));
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

const createdCollections: TestCollection[] = [];

// compares upstream's answer to a collection request with the model's
async function checkCollection(body: string, collection: TestCollection): Promise<number> {
  const errs = settingsErrors(collection);
  const res = await request("POST", "/api/collections", body);

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
  expect(responseFields(res.text)).toBe(fieldsListJSON(collection));
  createdCollections.push(collection);
  return res.status;
}

describe("settings", () => {
  for (const [i, def] of validSettings.entries()) {
    test(`accepted ${i} ${JSON.stringify(def)}`, async () => {
      const name = `ok_${i}`;
      const body = JSON.stringify({ name, type: "base", fields: [def] });
      expect(await checkCollection(body, modelCollection(name, [def]))).toBe(200);
    });
  }

  for (const [i, def] of invalidSettings.entries()) {
    test(`rejected ${i} ${JSON.stringify(def)}`, async () => {
      const name = `bad_${i}`;
      const body = JSON.stringify({ name, type: "base", fields: [def] });
      expect(await checkCollection(body, modelCollection(name, [def]))).toBe(400);
    });
  }

  for (const [i, raw] of rawSettings.entries()) {
    test(`raw ${i} ${raw}`, async () => {
      const name = `raw_${i}`;
      const body = `{"name":"${name}","type":"base","fields":[${raw}]}`;

      let collection: TestCollection;
      try {
        collection = newBaseCollection(name);
        collection.fields.add(modelField(raw));
      } catch (err) {
        // BindBody fails: upstream answers before validating
        const res = await request("POST", "/api/collections", body);
        expect({ status: res.status, body: res.text }).toEqual({
          status: 400,
          body: marshal(
            newBadRequestError(
              "Failed to load the submitted data due to invalid formatting.",
              err,
            ).toJSON(),
          ),
        });
        return;
      }
      await checkCollection(body, collection);
    });
  }
});

// ---------------------------------------------------------------------
// uploads

const encoder = new TextEncoder();

function contentBytes(content: Content): Uint8Array {
  if (typeof content === "string") {
    return encoder.encode(content);
  }
  if (content instanceof Uint8Array) {
    return content;
  }
  return new Uint8Array(content.size).fill(0x61); // "aaa…": text/plain
}

// the multipart body of the parts (Bun's FormData encoding)
async function multipart(parts: Part[]): Promise<{ contentType: string; body: Uint8Array }> {
  const form = new FormData();
  for (const part of parts) {
    if (part.length === 2) {
      form.append(part[0], part[1]);
    } else {
      form.append(part[0], new globalThis.File([contentBytes(part[2])], part[1]));
    }
  }
  const req = new Request("http://localhost/", { method: "POST", body: form });
  return {
    contentType: req.headers.get("content-type") as string,
    body: new Uint8Array(await req.arrayBuffer()),
  };
}

// unique 10-letter markers in place of the random name parts: uppercase,
// which normalized names never contain outside their extension
const markers: string[] = [];
const markerRandom: RandomSource = (length) => {
  let n = markers.length;
  let marker = "";
  for (let i = 0; i < length; i++) {
    marker = String.fromCharCode(65 + (n % 26)) + marker;
    n = Math.floor(n / 26);
  }
  markers.push(marker);
  return marker;
};

// a regexp for upstream's text of a model text with markers
function namePattern(modelText: string): RegExp {
  let pattern = modelText.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  for (const marker of markers) {
    if (pattern.includes(marker)) {
      pattern = pattern.replaceAll(marker, "[a-z0-9]{10}");
    }
  }
  return new RegExp(`^${pattern}$`);
}

// Record.SetIfFieldExists
function setIfFieldExists(record: TestRecord, key: string, value: unknown): Field | null {
  for (const field of record.collection.fields) {
    if (isSetterFinder(field)) {
      const setter = field.findSetter(key);
      if (setter !== null) {
        setter(record, value);
        return field;
      }
    }
    if (key === field.getName()) {
      record.setRaw(key, field.prepareValue(record, value)[0]);
      return field;
    }
  }
  return null;
}

// Record.Fresh: a copy with the latest data
function fresh(record: TestRecord): TestRecord {
  const copy = new TestRecord(record.collection);
  copy.id = record.id;
  for (const field of record.collection.fields) {
    if (field.getName() !== FieldNameId) {
      copy.setRaw(field.getName(), record.getRaw(field.getName()));
    }
  }
  return copy;
}

// Record.ReplaceModifiers: the keys in length order (upstream's order of
// keys of the same length is random; the cases avoid relying on it)
function replaceModifiers(record: TestRecord, data: Map<string, unknown>): Map<string, unknown> {
  if (data.size === 0) {
    return data;
  }
  const dataCopy = new Map(data);
  const recordCopy = fresh(record);
  const keys = [...data.keys()].toSorted((a, b) => a.length - b.length);
  for (const k of keys) {
    const field = setIfFieldExists(recordCopy, k, data.get(k));
    if (field !== null) {
      dataCopy.delete(k);
      dataCopy.set(field.getName(), recordCopy.get(field.getName()));
    }
  }
  return dataCopy;
}

// router.inferValue: "true"/"false" become bools and plain decimal
// numbers floats (the file field casts them back to the same text)
function inferValue(raw: string): unknown {
  if (raw === "true" || raw === "false") {
    return raw === "true";
  }
  if (/^-?[0-9]+(\.[0-9]+)?$/.test(raw) && String(Number(raw)) === raw) {
    return Number(raw);
  }
  return raw;
}

// the model of upstream's record create or update: the record after
// recordDataFromRequest and RecordUpsert.Load, and its validation errors
async function modelSubmit(
  record: TestRecord,
  contentType: string,
  body: Uint8Array,
): Promise<Errors> {
  const form = await new Request("http://localhost/", {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  }).formData();

  // RequestInfo.Body (the text values) and the file parts per key
  const values = new Map<string, string[]>();
  const files = new Map<string, globalThis.File[]>();
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") {
      values.set(key, [...(values.get(key) ?? []), value]);
    } else {
      files.set(key, [...(files.get(key) ?? []), value]);
    }
  }
  const info = new Map<string, unknown>();
  for (const [key, list] of values) {
    info.set(key, list.length === 1 ? inferValue(list[0] as string) : list.map(inferValue));
  }

  // recordDataFromRequest
  let result = replaceModifiers(record, info);
  const uploadedFiles = new Map<string, File[]>();
  for (const field of record.collection.fields) {
    if (!(field instanceof FileField)) {
      continue;
    }
    const baseKey = field.getName();
    for (const k of [baseKey, "+" + baseKey, baseKey + "+"]) {
      const parts = files.get(k) ?? [];
      if (parts.length > 0) {
        const list: File[] = [];
        for (const part of parts) {
          list.push(await NewFileFromMultipart(part, { random: markerRandom }));
        }
        uploadedFiles.set(k, list);
      }
    }
  }
  if (uploadedFiles.size > 0) {
    for (const [k, list] of uploadedFiles) {
      const uploaded: unknown[] = [];
      if (info.get(k) !== undefined && !k.startsWith("+") && !k.endsWith("+") && !k.endsWith("-")) {
        uploaded.push(...toUniqueStringSlice(info.get(k)));
      }
      uploaded.push(...list);
      result.set(k, uploaded);
    }
    result = replaceModifiers(record, result);
  }

  // RecordUpsert.Load
  for (const [k, v] of result) {
    setIfFieldExists(record, k, v);
  }

  // the record validation: every field's ValidateValue
  const errs = new Errors();
  for (const field of record.collection.fields) {
    if (field.getName() === FieldNameId) {
      continue;
    }
    const err = field.validateValue(app, record);
    if (err !== null) {
      errs.errors[field.getName()] = err;
    }
  }
  return errs;
}

// the value a record field is bound with: DriverValue (JSONArray for
// arrays)
function bindValue(field: Field, record: TestRecord): string | number | null {
  let v: unknown = record.getRaw(field.getName());
  if (isDriverValuer(field)) {
    const [dv, err] = field.driverValue(record);
    expect(err).toBeNull();
    v = dv;
  }
  return (Array.isArray(v) ? jsonArrayValue(v) : v) as string | number | null;
}

// the model record's stored file columns (typeof and value), from an
// in-memory table with the fields' column types
function storeModel(
  collection: TestCollection,
  record: TestRecord,
): Record<string, [string, unknown]> {
  const fields = [...collection.fields].filter((f) => f.getName() !== FieldNameId);
  const db = new Database(":memory:");
  try {
    db.run(
      `CREATE TABLE t (${fields.map((f) => `"${f.getName()}" ${f.columnType(app)}`).join(", ")})`,
    );
    db.query(`INSERT INTO t VALUES (${fields.map(() => "?").join(", ")})`).run(
      ...fields.map((f) => bindValue(f, record)),
    );
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

// the model's columns must match upstream's, with the random parts
function expectColumns(
  label: string,
  got: Record<string, [string, unknown]>,
  want: Record<string, [string, unknown]>,
): void {
  expect(Object.keys(got).toSorted()).toEqual(Object.keys(want).toSorted());
  for (const [name, [type, value]] of Object.entries(want)) {
    const [gotType, gotValue] = got[name] as [string, unknown];
    expect({ label, name, type: gotType }).toEqual({ label, name, type });
    const ok = namePattern(String(value)).test(String(gotValue));
    expect({ label, name, value: ok ? value : gotValue }).toEqual({ label, name, value });
  }
}

const valueModels = new Map<string, TestCollection>();

interface StoredRecord {
  collection: TestCollection;
  id: string;
  columns: Record<string, [string, unknown]>;
}

const storedRecords: StoredRecord[] = [];
let requests = 0;
let storageRejections = 0;

// the new uploads of the record's file fields
function uploads(record: TestRecord): File[] {
  const out: File[] = [];
  for (const field of record.collection.fields) {
    if (field instanceof FileField) {
      out.push(...(field.findGetter(field.getName() + ":unsaved")?.(record) as File[]));
    }
  }
  return out;
}

function validUTF8(b: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(b);
    return true;
  } catch {
    return false;
  }
}

// sends parts to upstream and compares the answer with the model's
async function submit(
  label: string,
  collection: TestCollection,
  record: TestRecord,
  parts: Part[],
): Promise<Record<string, unknown> | null> {
  const { contentType, body } = await multipart(parts);
  const errs = await modelSubmit(record, contentType, body);

  const path = record.isNew()
    ? `/api/collections/${collection.name}/records`
    : `/api/collections/${collection.name}/records/${record.id}`;
  const res = await request(record.isNew() ? "POST" : "PATCH", path, body, contentType);
  requests++;

  if (errs.size > 0) {
    // the messages of MIME type errors hold the generated names
    const want = modelErrorData(errs);
    const got = res.status === 400 ? errorData(res.text) : res.text;
    expect({
      label,
      status: res.status,
      data: namePattern(want).test(got) ? want : got,
    }).toEqual({ label, status: 400, data: want });
    return null;
  }

  // upstream's storage keeps the first 255 bytes of the original
  // name as blob metadata, which must be valid UTF-8: the upload fails
  // after the validation and upstream answers with a plain 400
  if (uploads(record).some((f) => !validUTF8(textToBytes(f.originalName).subarray(0, 255)))) {
    expect({ label, status: res.status, body: res.text }).toEqual({
      label,
      status: 400,
      body: marshal(
        newBadRequestError(
          record.isNew() ? "Failed to create record" : "Failed to update record.",
          null,
        ).toJSON(),
      ),
    });
    storageRejections++;
    return null;
  }
  expect({ label, status: res.status, body: res.status === 200 ? "" : res.text }).toEqual({
    label,
    status: 200,
    body: "",
  });

  const saved = JSON.parse(res.text) as Record<string, unknown>;
  const columns = storeModel(collection, record);
  // the response values are the stored names
  const responseColumns: Record<string, [string, unknown]> = {};
  for (const [name, [type]] of Object.entries(columns)) {
    const v = saved[name];
    responseColumns[name] = [type, Array.isArray(v) ? JSON.stringify(v) : v];
  }
  expectColumns(label, responseColumns, columns);
  // an update replaces the record's earlier columns
  const id = saved.id as string;
  const earlier = storedRecords.findIndex((r) => r.collection === collection && r.id === id);
  if (earlier >= 0) {
    storedRecords.splice(earlier, 1);
  }
  storedRecords.push({ collection, id, columns });
  return saved;
}

// the record upstream saved, as loaded from the database
function savedRecord(collection: TestCollection, saved: Record<string, unknown>): TestRecord {
  const record = new TestRecord(collection);
  record.id = saved.id as string;
  for (const field of collection.fields) {
    if (field.getName() !== FieldNameId) {
      record.setRaw(field.getName(), field.prepareValue(record, saved[field.getName()])[0]);
    }
  }
  record.postScan();
  return record;
}

// "$i" -> the i-th stored name of the key's field
function resolveParts(parts: Part[], saved: Record<string, unknown>): Part[] {
  return parts.map((part) => {
    if (part.length !== 2 || !/^\$\d+$/.test(part[1])) {
      return part;
    }
    const fieldName = part[0].replace(/^\+|[+-]$/g, "");
    const names = toUniqueStringSlice(saved[fieldName]);
    return [part[0], names[Number(part[1].slice(1))] as string];
  });
}

function partsLabel(parts: Part[]): string {
  return parts
    .map((p) => (p.length === 2 ? `${p[0]}=${p[1]}` : `${p[0]}@${p[1]}`))
    .join(" ")
    .slice(0, 80);
}

function caseLabel(c: UploadCase): string {
  return c.before === undefined
    ? `${c.collection} ${partsLabel(c.parts)}`
    : `${c.collection} [${partsLabel(c.before)}] -> ${partsLabel(c.parts)}`;
}

describe("uploads", () => {
  beforeAll(async () => {
    for (const { name, fields } of valueCollections) {
      const collection = modelCollection(name, fields);
      expect(settingsErrors(collection)).toBeNull();
      // one at a time: upstream reloads its collection cache after a save
      const res = await request(
        "POST",
        "/api/collections",
        JSON.stringify({ name, type: "base", fields }),
      );
      expect({ status: res.status, body: res.status === 200 ? "" : res.text }).toEqual({
        status: 200,
        body: "",
      });
      valueModels.set(name, collection);
    }
  });

  for (const [i, c] of uploadCases.entries()) {
    test(`${i} ${caseLabel(c)}`, async () => {
      const collection = valueModels.get(c.collection) as TestCollection;
      let record = new TestRecord(collection);
      let parts = c.parts;
      if (c.before !== undefined) {
        const saved = await submit(`${i} before`, collection, record, c.before);
        expect(saved).not.toBeNull();
        record = savedRecord(collection, saved as Record<string, unknown>);
        parts = resolveParts(c.parts, saved as Record<string, unknown>);
      }
      await submit(String(i), collection, record, parts);
    });
  }
});

// ---------------------------------------------------------------------
// stored data

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
    expect(createdCollections.length).toBeGreaterThanOrEqual(validSettings.length);
    for (const collection of createdCollections) {
      const row = db
        .query("SELECT fields FROM _collections WHERE name = ?")
        .get(collection.name) as { fields: string };
      expect({ name: collection.name, fields: row.fields }).toEqual({
        name: collection.name,
        fields: fieldsListJSON(collection),
      });
    }
  });

  test("record columns", () => {
    expect(storedRecords.length).toBeGreaterThan(40);
    for (const [i, { collection, id, columns }] of storedRecords.entries()) {
      const stored = readColumns(db, collection.name, Object.keys(columns), id);
      expectColumns(`${i} ${collection.name} ${id}`, stored, columns);
    }
  });
});

test("the sample is large enough", () => {
  expect(validSettings.length + invalidSettings.length + rawSettings.length).toBeGreaterThanOrEqual(
    15,
  );
  expect(requests).toBeGreaterThanOrEqual(60);
  expect(storageRejections).toBe(2);
});
