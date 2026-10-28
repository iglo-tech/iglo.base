// The relation and password fields (src/fields) against the reference
// PocketBase v0.41.0 binary. Not part of `bun test`: run
// `bun run test:reference`.
//
// The same comparisons as fields.test.ts, with a model app on upstream's
// live pb_data (TestApp.openDir): the relation field looks collections up
// and counts the related records through src/db, as upstream does.
//
//   - settings: collections created through POST /api/collections (and
//     one collectionId change through PATCH) give the same field JSON or
//     the same error `data` as the model, byte for byte;
//   - values: records created through POST
//     /api/collections/{c}/records give the same error `data`, stored
//     relation columns and GET bodies as the model. Password columns hold
//     random salts: upstream's stored hash must have the model's form
//     ("$2a$", the field's cost) and verify the submitted password with
//     PasswordFieldValue.validate;
//   - hashes: with upstream stopped, auth records get hashes written by
//     iglo.base and variants of upstream's hashes; after a restart,
//     POST /api/collections/{c}/auth-with-password must succeed exactly
//     when PasswordFieldValue.validate accepts the password.

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
import { PasswordField, PasswordFieldValue } from "@/fields/password";
import { newBadRequestError } from "@/server/error";
import { anyType, mapOf, marshal, unmarshal } from "@/tools/types/go-json";
import { jsonArrayValue } from "@/tools/types/json-array";
import { Errors } from "@/validation/error";

import { runUpstream } from "@test/differential/db/fixture";
import type { FieldDef } from "@test/differential/fields/cases";
import {
  invalidSettings,
  targetIds,
  userId,
  validSettings,
  valueCases,
  valueCollections,
} from "@test/differential/fields/relation-password-cases";
import { TestApp, TestCollection, TestRecord, newBaseCollection } from "@test/support/fields";
import { startUpstream, type UpstreamServer } from "@test/support/upstream";

const email = "fields@example.com";
const password = "1234567890";

let root: string;
let dataDir: string;
let upstream: UpstreamServer | undefined;
let token: string;
let app: TestApp | undefined;

// "$T", "$V", "$U" -> collection ids
const placeholders = new Map<string, string>();

function model(): TestApp {
  if (app === undefined) {
    throw new Error("the model app is closed");
  }
  return app;
}

async function request(
  method: string,
  path: string,
  body?: string,
  auth = true,
): Promise<{ status: number; text: string }> {
  if (upstream === undefined) {
    throw new Error("upstream is not running");
  }
  const res = await fetch(`${upstream.url}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(auth ? { authorization: token } : {}),
    },
    ...(body === undefined ? {} : { body }),
  });
  return { status: res.status, text: await res.text() };
}

async function authenticate(): Promise<void> {
  const res = await request(
    "POST",
    "/api/collections/_superusers/auth-with-password",
    JSON.stringify({ identity: email, password }),
    false,
  );
  expect(res.status).toBe(200);
  token = (JSON.parse(res.text) as { token: string }).token;
}

async function create(path: string, body: unknown): Promise<string> {
  const res = await request("POST", path, JSON.stringify(body));
  expect({ status: res.status, body: res.status === 200 ? "" : res.text }).toEqual({
    status: 200,
    body: "",
  });
  return (JSON.parse(res.text) as { id: string }).id;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "iglo-base-fields-rel-ref-"));
  dataDir = join(root, "pb_data");
  const upsert = await runUpstream(
    ["superuser", "upsert", email, password, "--dir", dataDir],
    root,
  );
  expect(upsert.exitCode).toBe(0);
  upstream = await startUpstream({ dataDir });
  await authenticate();

  const targets = await create("/api/collections", {
    name: "targets",
    type: "base",
    fields: [{ name: "title", type: "text" }],
  });
  for (const id of targetIds) {
    await create("/api/collections/targets/records", { id, title: id });
  }
  const view = await create("/api/collections", {
    name: "targets_view",
    type: "view",
    viewQuery: "SELECT id, title FROM targets",
  });
  await create("/api/collections/users/records", {
    id: userId,
    email: "user@example.com",
    password: "user-password",
    passwordConfirm: "user-password",
  });
  const users = (
    JSON.parse((await request("GET", "/api/collections/users")).text) as { id: string }
  ).id;
  placeholders.set("$T", targets).set("$V", view).set("$U", users);

  app = TestApp.openDir(dataDir);
});

afterAll(async () => {
  app?.cleanup();
  await upstream?.stop();
  rmSync(root, { recursive: true, force: true });
});

function resolve(def: FieldDef): FieldDef {
  const collectionId = def.collectionId;
  if (typeof collectionId === "string" && placeholders.has(collectionId)) {
    return { ...def, collectionId: placeholders.get(collectionId) };
  }
  return def;
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
// settings

function modelField(def: unknown): Field {
  const data = def as { type: string };
  const factory = fieldFactory(data.type);
  if (factory === undefined) {
    throw new Error(`unknown field type ${data.type}`);
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
    const err = field.validateSettings(model(), collection);
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

// compares upstream's answer to a collection request with the model's
async function checkCollection(
  method: string,
  path: string,
  body: Record<string, unknown>,
  collection: TestCollection,
): Promise<number> {
  const errs = settingsErrors(collection);
  const res = await request(method, path, JSON.stringify(body));

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

const createdCollections: TestCollection[] = [];

describe("settings", () => {
  for (const [i, def] of validSettings.entries()) {
    test(`accepted ${i} ${JSON.stringify(def)}`, async () => {
      const name = `ok_${i}`;
      const defs = [resolve(def)];
      expect(
        await checkCollection(
          "POST",
          "/api/collections",
          { name, type: "base", fields: defs },
          modelCollection(name, defs),
        ),
      ).toBe(200);
    });
  }

  for (const [i, def] of invalidSettings.entries()) {
    test(`rejected ${i} ${JSON.stringify(def)}`, async () => {
      const name = `bad_${i}`;
      const defs = [resolve(def)];
      expect(
        await checkCollection(
          "POST",
          "/api/collections",
          { name, type: "base", fields: defs },
          modelCollection(name, defs),
        ),
      ).toBe(400);
    });
  }

  test("a collectionId change is rejected", async () => {
    // ok_0 holds a relation to "targets"
    const saved = model().findCollectionByNameOrId("ok_0");
    const fields = (
      JSON.parse(responseFields((await request("GET", "/api/collections/ok_0")).text)) as {
        name: string;
        collectionId?: string;
      }[]
    ).map((f) => (f.name === "r" ? { ...f, collectionId: placeholders.get("$U") } : f));

    const changed = new TestCollection(saved.type, saved.name, saved.id);
    for (const def of fields) {
      changed.fields.add(modelField(def));
    }
    changed.markAsNotNew();

    expect(await checkCollection("PATCH", "/api/collections/ok_0", { fields }, changed)).toBe(400);
  });
});

// ---------------------------------------------------------------------
// values

const valueModels = new Map<string, { model: TestCollection; id: string }>();

interface StoredRecord {
  collection: TestCollection;
  id: string;
  // the model's stored relation columns: name -> [typeof, value]
  columns: Record<string, [string, unknown]>;
  // the submitted plain passwords: name -> [plain, the model's hash]
  passwords: Record<string, [string, string]>;
}

const storedRecords: StoredRecord[] = [];

// the value a record field is bound with: DriverValue (JSONArray for
// arrays)
function bindValue(field: Field, record: TestRecord): unknown {
  let v: unknown = record.getRaw(field.getName());
  if (isDriverValuer(field)) {
    const [dv, err] = field.driverValue(record);
    expect(err).toBeNull();
    v = dv;
  }
  return Array.isArray(v) ? jsonArrayValue(v) : v;
}

// stores the model record's non-password columns in an in-memory table
// with the fields' column types: name -> [typeof, value]
function storeModel(
  collection: TestCollection,
  record: TestRecord,
): Record<string, [string, unknown]> {
  const fields = [...collection.fields].filter(
    (f) => f.getName() !== "id" && !(f instanceof PasswordField),
  );
  if (fields.length === 0) {
    return {};
  }
  const db = new Database(":memory:", { safeIntegers: false });
  try {
    db.run(
      `CREATE TABLE t (${fields.map((f) => `"${f.getName()}" ${f.columnType(model())}`).join(", ")})`,
    );
    const values = fields.map((f) => bindValue(f, record)) as (string | number | null)[];
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
  if (names.length === 0) {
    return {};
  }
  const select = names.map((n) => `typeof("${n}"), "${n}"`).join(", ");
  const stmt = db.prepare(`SELECT ${select} FROM "${table}"${id === null ? "" : ` WHERE id = ?`}`);
  const row = (id === null ? stmt.values() : stmt.values(id))[0] as unknown[];
  const out: Record<string, [string, unknown]> = {};
  for (const [i, n] of names.entries()) {
    out[n] = [row[2 * i] as string, row[2 * i + 1]];
  }
  return out;
}

// the GET body of the model record read back from its stored columns
// (text columns only here: prepareValue of the stored text, then the
// record's JSON export through the fields' getters)
function modelRecordBody(
  collection: TestCollection,
  collectionId: string,
  id: string,
  stored: Record<string, string>,
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
    const [v, err] = field.prepareValue(read, stored[name]);
    expect(err).toBeNull();
    read.setRaw(name, v);
    out[name] = read.get(name);
  }
  return marshal(out, { allowInvalidUTF8: true });
}

// "$2a$" with the field's cost (DefaultCost when zero)
function hashForm(field: PasswordField): RegExp {
  const cost = String(field.cost <= 0 ? 10 : field.cost).padStart(2, "0");
  return new RegExp(String.raw`^\$2a\$${cost}\$[./A-Za-z0-9]{53}$`);
}

describe("values", () => {
  beforeAll(async () => {
    for (const { name, fields } of valueCollections) {
      const defs = fields.map(resolve);
      const collection = modelCollection(name, defs);
      expect(settingsErrors(collection)).toBeNull();
      const id = await create("/api/collections", { name, type: "base", fields: defs });
      valueModels.set(name, { model: collection, id });
    }
  });

  for (const [i, [collectionName, key, valueJSON]] of valueCases.entries()) {
    test(`${i} ${collectionName}.${key} = ${valueJSON.slice(0, 60)}`, async () => {
      const { model: collection, id: collectionId } = valueModels.get(collectionName) as {
        model: TestCollection;
        id: string;
      };
      const bodyText = `{${JSON.stringify(key)}:${valueJSON}}`;

      // the model: record.Load of the decoded body, the "validate"
      // interceptors, then every field's ValidateValue
      const body = unmarshal(bodyText, mapOf(anyType)) as Record<string, unknown>;
      const record = new TestRecord(collection);
      record.set(key, body[key]);
      for (const field of collection.fields) {
        if (isRecordInterceptor(field)) {
          await field.intercept(model(), record, InterceptorActionValidate, async () => {});
        }
      }
      const errs = new Errors();
      for (const field of collection.fields) {
        const err = field.validateValue(model(), record);
        if (err !== null) {
          errs.errors[field.getName()] = err;
        }
      }

      const res = await request("POST", `/api/collections/${collectionName}/records`, bodyText);

      if (errs.size > 0) {
        expect({
          status: res.status,
          data: res.status === 400 ? errorData(res.text) : res.text,
        }).toEqual({ status: 400, data: modelErrorData(errs) });
        return;
      }
      expect({ status: res.status, body: res.status === 200 ? "" : res.text }).toEqual({
        status: 200,
        body: "",
      });

      const id = (JSON.parse(res.text) as { id: string }).id;
      const columns = storeModel(collection, record);
      const passwords: Record<string, [string, string]> = {};
      const stored: Record<string, string> = {};
      for (const field of collection.fields) {
        const name = field.getName();
        if (field instanceof PasswordField) {
          const [hash] = field.driverValue(record) as [string, Error | null];
          passwords[name] = [record.getString(name), hash];
          stored[name] = hash;
        } else if (name !== "id") {
          stored[name] = String((columns[name] as [string, unknown])[1]);
        }
      }
      storedRecords.push({ collection, id, columns, passwords });

      const got = await request("GET", `/api/collections/${collectionName}/records/${id}`);
      expect(got.status).toBe(200);
      expect(got.text).toBe(modelRecordBody(collection, collectionId, id, stored));
    });
  }
});

// ---------------------------------------------------------------------
// stored data and hashes across both servers

// the auth records whose hashes are replaced: [email, hash, password]
interface AuthCase {
  email: string;
  hash: string;
  password: string;
}

describe("stored data", () => {
  const authCases: AuthCase[] = [];
  let db: Database;

  // "known" users with an upstream hash of their password, created before
  // upstream stops
  const known = "known-password-1";
  const knownUsers = 16;

  beforeAll(async () => {
    for (let i = 0; i < knownUsers; i++) {
      await create("/api/collections/users/records", {
        email: `known${i}@example.com`,
        password: known,
        passwordConfirm: known,
      });
    }

    app?.cleanup();
    app = undefined;
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
    expect(createdCollections.length).toBe(validSettings.length);
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
    expect(storedRecords.length).toBeGreaterThan(30);
    for (const { collection, id, columns, passwords } of storedRecords) {
      const stored = readColumns(db, collection.name, Object.keys(columns), id);
      expect({ collection: collection.name, id, columns: stored }).toEqual({
        collection: collection.name,
        id,
        columns,
      });

      for (const [name, [plain, modelHash]] of Object.entries(passwords)) {
        const field = collection.fields.getByName(name) as PasswordField;
        const [type, upstreamHash] = readColumns(db, collection.name, [name], id)[name] as [
          string,
          string,
        ];
        expect(type).toBe("text");
        if (plain === "") {
          expect({ name, upstreamHash, modelHash }).toEqual({
            name,
            upstreamHash: "",
            modelHash: "",
          });
          continue;
        }
        // the same form, and both verify the password with iglo.base
        expect(upstreamHash).toMatch(hashForm(field));
        expect(modelHash).toMatch(hashForm(field));
        expect(new PasswordFieldValue({ hash: upstreamHash }).validate(plain)).toBe(true);
        expect(new PasswordFieldValue({ hash: upstreamHash }).validate("x" + plain)).toBe(false);
        expect(new PasswordFieldValue({ hash: modelHash }).validate(plain)).toBe(true);
      }
    }
  });

  test("upstream's hashes verify with PasswordFieldValue.validate", () => {
    const rows = db.query("SELECT email, password FROM users WHERE email LIKE 'known%'").all() as {
      email: string;
      password: string;
    }[];
    expect(rows.length).toBe(knownUsers);
    for (const { password: hash } of rows) {
      expect(hash).toMatch(/^\$2a\$10\$/);
      const value = new PasswordFieldValue({ hash });
      expect(value.validate(known)).toBe(true);
      expect(value.validate("known-password-2")).toBe(false);
    }
  });

  test("hashes written to upstream's data", () => {
    const users = db.query("SELECT fields FROM _collections WHERE name = 'users'").get() as {
      fields: string;
    };
    const usersCollection = new TestCollection("auth", "users", "users");
    for (const def of JSON.parse(users.fields) as { type: string }[]) {
      if (fieldFactory(def.type) !== undefined) {
        usersCollection.fields.add(modelField(def));
      }
    }
    const passwordField = usersCollection.fields.getByName("password") as PasswordField;

    const rows = db
      .query("SELECT email, password FROM users WHERE email LIKE 'known%' ORDER BY email")
      .all() as { email: string; password: string }[];
    const upstreamHash = (rows[0] as { password: string }).password;
    const salt = upstreamHash.slice(7, 29);
    const hash = upstreamHash.slice(29);
    const alphabet = "./ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    // the last salt character with other bits past the 16 salt bytes
    const lastSalt = alphabet[alphabet.indexOf(salt[21] as string) ^ 1] as string;
    // the last hash character with other bits past the 23 hash bytes
    const lastHash = alphabet[alphabet.indexOf(hash[30] as string) ^ 1] as string;

    // hashes from iglo.base's setter (the users field's cost: DefaultCost)
    const igloHash = (plain: string, field: PasswordField = passwordField): string => {
      const record = new TestRecord(usersCollection);
      field.findSetter(field.getName())?.(record, plain);
      const [h, err] = field.driverValue(record);
      expect(err).toBeNull();
      return h as string;
    };
    const p72 = "x".repeat(72);
    const variants: [string, string][] = [
      [igloHash("iglo-password-1"), "iglo-password-1"],
      [igloHash("iglo-pässwörd-2"), "iglo-pässwörd-2"],
      [
        igloHash("iglo-password-3", new PasswordField({ name: "password", cost: 4 })),
        "iglo-password-3",
      ],
      [
        igloHash("iglo-password-4", new PasswordField({ name: "password", cost: 12 })),
        "iglo-password-4",
      ],
      [igloHash(p72), p72 + "-ignored-after-72-bytes"],
      ["$2b$10$" + salt + hash, known],
      ["$2y$10$" + salt + hash, known],
      ["$2x$10$" + salt + hash, known],
      ["$2$10$" + salt + hash, known],
      ["$1a$10$" + salt + hash, known],
      ["$3a$10$" + salt + hash, known],
      ["$2a$11$" + salt + hash, known],
      ["$2a$10$" + salt + hash + "trailing", known],
      ["$2a$10$" + salt + hash.slice(0, 30) + lastHash, known],
      ["$2a$10$" + salt.slice(0, 21) + lastSalt + hash, known],
      ["$2a$10$" + salt + hash, known.toUpperCase()],
    ];
    expect(variants.length).toBe(knownUsers);

    const update = db.prepare("UPDATE users SET password = ? WHERE email = ?");
    for (const [i, [h, plain]] of variants.entries()) {
      const { email: userEmail } = rows[i] as { email: string };
      update.run(h, userEmail);
      authCases.push({ email: userEmail, hash: h, password: plain });
    }
    // the hashes iglo.base wrote must be accepted
    for (const { hash: h, password: plain } of authCases.slice(0, 5)) {
      expect(new PasswordFieldValue({ hash: h }).validate(plain)).toBe(true);
    }
  });

  test("upstream authenticates exactly where PasswordFieldValue.validate accepts", async () => {
    expect(authCases.length).toBe(knownUsers);
    db.close();
    db = new Database(":memory:");
    upstream = await startUpstream({ dataDir });

    const results: { email: string; hash: string; upstream: number; iglo: boolean }[] = [];
    for (const c of authCases) {
      const res = await request(
        "POST",
        "/api/collections/users/auth-with-password",
        JSON.stringify({ identity: c.email, password: c.password }),
        false,
      );
      results.push({
        email: c.email,
        hash: c.hash,
        upstream: res.status,
        iglo: new PasswordFieldValue({ hash: c.hash }).validate(c.password),
      });
    }
    expect(results.map((r) => ({ ...r, upstream: r.upstream === 200 }))).toEqual(
      results.map((r) => ({ ...r, upstream: r.iglo })),
    );
    // both kinds of answers are covered
    expect(results.filter((r) => r.iglo).length).toBeGreaterThan(8);
    expect(results.filter((r) => !r.iglo).length).toBeGreaterThan(2);
    expect(results.every((r) => r.upstream === 200 || r.upstream === 400)).toBe(true);
  });
});

test("the sample is large enough", () => {
  expect(validSettings.length + invalidSettings.length + 1).toBeGreaterThanOrEqual(15);
  expect(valueCases.length).toBeGreaterThanOrEqual(60);
});
