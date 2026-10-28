// The Record model (src/records) against the reference PocketBase v0.41.0
// binary. Not part of `bun test`: run `bun run test:reference`.
//
// On a fresh upstream install, the test creates an auth collection and a
// base collection with every field type through POST /api/collections,
// then creates and updates records through upstream's records API with
// edge values (cases.ts), and keeps each record's final GET body as a
// superuser and as a guest. After upstream stops, each record's row is
// read from data.db with src/db and turned into a Record with
// newRecordFromNullStringMap, and:
//
//   - MarshalJSON must equal the guest GET body, byte for byte;
//   - with the flags upstream's record API sets for a superuser
//     (autoResolveRecordsFlags: Unhide of every field and
//     IgnoreEmailVisibility), MarshalJSON must equal the superuser GET
//     body;
//   - DBExport's values, converted to their driver values and stored in a
//     table with the fields' column types, must equal the stored columns
//     (typeof and value).
//
// A numbers collection (a json and a number field) gets its values through
// the API and, for INTEGER values the API cannot store, through SQL on
// upstream's data.db; a view over it has expression columns that keep whole
// REAL values REAL. Views are not saved, so their DBExport is not compared.
//
// Upstream marshals maps with json.Deterministic, so no member order needs
// normalizing.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Collection } from "@/collections/collection-model";
import { fieldApp, findCollectionByNameOrId } from "@/collections/collection-query";
import { HashExp } from "@/db/dbx/expression";
import {
  type Record as RecordModel,
  newRecordFromNullStringMap,
  nullStringMapFromRow,
} from "@/records/record-model";
import { jsonArrayValue } from "@/tools/types/json-array";

import { openDataDir, type TestCollectionsApp } from "@test/collections/app";
import { runUpstream } from "@test/differential/db/fixture";
import {
  allCollection,
  allFields,
  allPayloads,
  allUpdates,
  numsCollection,
  numsFields,
  numsPayloads,
  numsSQLRows,
  numsViewCollection,
  numsViewQuery,
  usersCollection,
  usersFields,
  userPayloads,
  userUpdates,
  type Payload,
} from "@test/differential/records/cases";
import { startUpstream, type UpstreamServer } from "@test/support/upstream";

const email = "records@example.com";
const password = "1234567890";

let root: string;
let dataDir: string;
let upstream: UpstreamServer | undefined;
let token: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "iglo-base-records-ref-"));
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
}, 60_000);

afterAll(async () => {
  await upstream?.stop();
  rmSync(root, { recursive: true, force: true });
});

interface Response {
  status: number;
  text: string;
}

async function request(
  method: string,
  path: string,
  body?: string | FormData,
  auth = true,
): Promise<Response> {
  if (upstream === undefined) {
    throw new Error("upstream is not running");
  }
  const headers: { [name: string]: string } = {};
  if (typeof body === "string") {
    headers["content-type"] = "application/json";
  }
  if (auth) {
    headers.authorization = token;
  }
  const res = await fetch(`${upstream.url}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
  });
  return { status: res.status, text: await res.text() };
}

// the request body of a payload: JSON, or multipart with the JSON members
// under @jsonPayload when it has files
function payloadBody(p: Payload): string | FormData {
  const json = `{${Object.entries(p.json)
    .map(([k, v]) => `${JSON.stringify(k)}:${v}`)
    .join(",")}}`;
  if (p.files === undefined || p.files.length === 0) {
    return json;
  }
  const form = new FormData();
  form.append("@jsonPayload", json);
  for (const [key, name, content] of p.files) {
    form.append(key, new Blob([content], { type: "text/plain" }), name);
  }
  return form;
}

async function saveRecord(collection: string, p: Payload, id?: string): Promise<string> {
  const res =
    id === undefined
      ? await request("POST", `/api/collections/${collection}/records`, payloadBody(p))
      : await request("PATCH", `/api/collections/${collection}/records/${id}`, payloadBody(p));
  expect({ status: res.status, body: res.status === 200 ? "" : res.text }).toEqual({
    status: 200,
    body: "",
  });
  return (JSON.parse(res.text) as { id: string }).id;
}

async function createCollection(body: object): Promise<string> {
  const res = await request("POST", "/api/collections", JSON.stringify(body));
  expect({ status: res.status, body: res.status === 200 ? "" : res.text }).toEqual({
    status: 200,
    body: "",
  });
  return (JSON.parse(res.text) as { id: string }).id;
}

interface Saved {
  collection: string;
  id: string;
  superuserBody: string;
  guestBody: string;
}

const saved: Saved[] = [];
let saves = 0;

describe("upstream", () => {
  const userIds: string[] = [];
  const allIds: string[] = [];

  test("collections and records", async () => {
    const usersId = await createCollection({
      name: usersCollection,
      type: "auth",
      listRule: "",
      viewRule: "",
      fields: usersFields,
    });
    await createCollection({
      name: allCollection,
      type: "base",
      listRule: "",
      viewRule: "",
      fields: allFields(usersId),
    });

    for (const p of userPayloads()) {
      userIds.push(await saveRecord(usersCollection, p));
      saves++;
    }
    for (const p of allPayloads(userIds)) {
      allIds.push(await saveRecord(allCollection, p));
      saves++;
    }
    for (const [i, p] of userUpdates()) {
      await saveRecord(usersCollection, p, userIds[i]);
      saves++;
    }
    for (const [i, p] of allUpdates(userIds)) {
      const id = allIds[i] as string;
      const json = { ...p.json };
      for (const [k, v] of Object.entries(json)) {
        if (v.includes("$firstDoc")) {
          const current = await request("GET", `/api/collections/${allCollection}/records/${id}`);
          const docs = (JSON.parse(current.text) as { docs: string[] }).docs;
          json[k] = v.replace("$firstDoc", docs[0] as string);
        }
      }
      await saveRecord(allCollection, { ...p, json }, id);
      saves++;
    }

    await createCollection({
      name: numsCollection,
      type: "base",
      listRule: "",
      viewRule: "",
      fields: numsFields,
    });
    const numIds: string[] = [];
    for (const p of numsPayloads()) {
      numIds.push(await saveRecord(numsCollection, p));
      saves++;
    }
    const live = new Database(join(dataDir, "data.db"));
    try {
      live.run("PRAGMA busy_timeout = 10000");
      for (const [id, j, n] of numsSQLRows) {
        live.run(`INSERT INTO "${numsCollection}" (id, j, n) VALUES ('${id}', ${j}, ${n})`);
        numIds.push(id);
      }
    } finally {
      live.close();
    }
    await createCollection({
      name: numsViewCollection,
      type: "view",
      listRule: "",
      viewRule: "",
      viewQuery: numsViewQuery,
    });

    for (const [collection, ids] of [
      [usersCollection, userIds],
      [allCollection, allIds],
      [numsCollection, numIds],
      [numsViewCollection, numIds],
    ] as const) {
      for (const id of ids) {
        const path = `/api/collections/${collection}/records/${id}`;
        const superuser = await request("GET", path);
        const guest = await request("GET", path, undefined, false);
        expect(superuser.status).toBe(200);
        expect(guest.status).toBe(200);
        saved.push({ collection, id, superuserBody: superuser.text, guestBody: guest.text });
      }
    }
  }, 120_000);
});

describe("records read from data.db", () => {
  let app: TestCollectionsApp;
  let db: Database;
  const collections = new Map<string, Collection>();

  beforeAll(async () => {
    await upstream?.stop();
    upstream = undefined;
    // read-write: a read-only connection cannot create the WAL index (-shm)
    // on macOS; this is a temporary copy that no server uses any more
    db = new Database(join(dataDir, "data.db"), { safeIntegers: true });
    app = openDataDir(dataDir);
    for (const name of [usersCollection, allCollection, numsCollection, numsViewCollection]) {
      collections.set(name, findCollectionByNameOrId(app, name));
    }
  });

  afterAll(() => {
    db.close();
    app.cleanup();
  });

  function readRecord(collectionName: string, id: string): RecordModel {
    const collection = collections.get(collectionName) as Collection;
    const row = app.databases
      .concurrentDB()
      .select(`${collection.name}.*`)
      .from(collection.name)
      .where(new HashExp({ id }))
      .limit(1)
      .build()
      .withExactIntegers()
      .one();
    return newRecordFromNullStringMap(collection, nullStringMapFromRow(row));
  }

  test("the sample is large enough", () => {
    expect(saves).toBeGreaterThanOrEqual(60);
    expect(saved.length).toBeGreaterThanOrEqual(60);

    // hidden fields and emailVisibility on and off are covered
    const users = saved.filter((s) => s.collection === usersCollection);
    const all = saved.filter((s) => s.collection === allCollection);
    expect(users.filter((s) => s.guestBody.includes(`"email":`)).length).toBeGreaterThan(3);
    expect(users.filter((s) => !s.guestBody.includes(`"email":`)).length).toBeGreaterThan(3);
    expect(users.every((s) => s.superuserBody.includes(`"email":`))).toBe(true);
    expect(
      users.filter((s) => s.superuserBody.includes(`"secret":"secret`)).length,
    ).toBeGreaterThan(3);
    expect(all.filter((s) => s.superuserBody.includes(`"note":"hidden`)).length).toBeGreaterThan(3);
    expect(
      saved.every((s) => !s.guestBody.includes(`"secret":`) && !s.guestBody.includes(`"note":`)),
    ).toBe(true);
    expect(all.filter((s) => s.guestBody.includes(`"docs":["`)).length).toBeGreaterThan(3);
    expect(saved.filter((s) => s.collection === numsViewCollection).length).toBeGreaterThan(20);
  });

  test("the numbers are stored as INTEGER and REAL", () => {
    const stored = classes(db, `SELECT typeof(j), j FROM "${numsCollection}"`);
    expect(stored).toContain("integer 1234567");
    expect(stored).toContain("integer 9223372036854775807");
    expect(stored).toContain("real 1e+21");
    expect(classes(db, `SELECT typeof(n), n FROM "${numsCollection}"`)).toContain(
      "integer 1000000",
    );
    expect(classes(db, `SELECT typeof(a), a FROM "${numsViewCollection}" LIMIT 1`)).toEqual([
      "real 5",
    ]);
  });

  test("MarshalJSON equals the guest GET body", () => {
    for (const s of saved) {
      const record = readRecord(s.collection, s.id);
      expect({ id: s.id, body: record.marshalJSON() }).toEqual({ id: s.id, body: s.guestBody });
    }
  });

  test("MarshalJSON with the superuser flags equals the superuser GET body", () => {
    for (const s of saved) {
      const record = readRecord(s.collection, s.id);
      record.unhide(...record.collection().fields.fieldNames());
      record.ignoreEmailVisibility(true);
      expect({ id: s.id, body: record.marshalJSON() }).toEqual({
        id: s.id,
        body: s.superuserBody,
      });
    }
  });

  test("DBExport values equal the stored columns", () => {
    for (const s of saved.filter((v) => v.collection !== numsViewCollection)) {
      const collection = collections.get(s.collection) as Collection;
      const record = readRecord(s.collection, s.id);
      const exported = record.dbExport();
      const names = collection.fields.fieldNames();
      expect(Object.keys(exported).toSorted()).toEqual(names.toSorted());

      const stored = readColumns(db, `"${collection.name}"`, names, s.id);
      const model = storeExported(collection, app, exported);
      expect({ id: s.id, columns: model }).toEqual({ id: s.id, columns: stored });
    }
  });
});

// "<typeof> <value>" of each row of a two-column select
function classes(db: Database, sql: string): string[] {
  return db
    .prepare(sql)
    .values()
    .map(([t, v]) => `${String(t)} ${String(v)}`);
}

// the driver value a DBExport value is bound with: the value's own
// driver.Valuer (DateTime, JSONRaw, GeoPoint; JSONArray for arrays)
function driverValue(v: unknown): unknown {
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

// stores the exported values in an in-memory table with the fields'
// column types: name -> [typeof, value]
function storeExported(
  collection: Collection,
  app: TestCollectionsApp,
  exported: { [key: string]: unknown },
): { [name: string]: [string, unknown] } {
  const fields = [...collection.fields];
  const names = fields.map((f) => f.getName());
  const mem = new Database(":memory:", { safeIntegers: true });
  try {
    mem.run(
      `CREATE TABLE t (${fields.map((f) => `"${f.getName()}" ${f.columnType(fieldApp(app))}`).join(", ")})`,
    );
    const values = names.map((n) => driverValue(exported[n])) as (
      | string
      | number
      | bigint
      | boolean
      | null
      | Uint8Array
    )[];
    mem.query(`INSERT INTO t VALUES (${names.map(() => "?").join(", ")})`).run(...values);
    return readColumns(mem, "t", names, null);
  } finally {
    mem.close();
  }
}

function readColumns(
  db: Database,
  table: string,
  names: string[],
  id: string | null,
): { [name: string]: [string, unknown] } {
  const select = names.map((n) => `typeof("${n}"), "${n}"`).join(", ");
  const stmt = db.prepare(`SELECT ${select} FROM ${table}${id === null ? "" : ` WHERE id = ?`}`);
  const row = (id === null ? stmt.values() : stmt.values(id))[0] as unknown[];
  const out: { [name: string]: [string, unknown] } = {};
  for (const [i, n] of names.entries()) {
    out[n] = [row[2 * i] as string, row[2 * i + 1]];
  }
  return out;
}
