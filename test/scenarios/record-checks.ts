// `after` checks for the record write scenarios: the database state a
// scenario leaves, read back through the answering server's records API as
// a superuser, and (for password hashes, which no read endpoint returns)
// from its pb_data with SQLite. Each check throws to fail.

import { Database } from "bun:sqlite";
import { join } from "node:path";

import { superuserToken } from "@test/scenarios/record-crud";
import type { AfterContext } from "@test/scenarios/scenario";
import type { Json, JsonObject } from "@test/support/json";

type After = (ctx: AfterContext) => Promise<void>;

// a value a record field or a SQLite column holds: JSON, or the blob and
// integer values SQLite returns
type Value = Json | bigint | Uint8Array;
type Row = { [key: string]: Value };

interface ApiResult {
  status: number;
  json: JsonObject;
}

export async function superuserGet(url: string, path: string): Promise<ApiResult> {
  const res = await fetch(url + path, { headers: { Authorization: superuserToken } });
  const text = await res.text();
  return { status: res.status, json: text === "" ? {} : (JSON.parse(text) as ApiResult["json"]) };
}

function expectFields(what: string, record: Row, fields: Row): void {
  for (const [k, v] of Object.entries(fields)) {
    if (JSON.stringify(record[k]) !== JSON.stringify(v)) {
      throw new Error(
        `${what}: expected ${k} = ${JSON.stringify(v)}, got ${JSON.stringify(record[k])}`,
      );
    }
  }
}

// the record exists, with these field values
export function recordHas(collection: string, id: string, fields: Row = {}): After {
  return async ({ url }) => {
    const res = await superuserGet(url, `/api/collections/${collection}/records/${id}`);
    if (res.status !== 200) {
      throw new Error(`${collection}/${id}: expected the record, got ${res.status}`);
    }
    expectFields(`${collection}/${id}`, res.json, fields);
  };
}

// the record does not exist
export function recordMissing(collection: string, id: string): After {
  return async ({ url }) => {
    const res = await superuserGet(url, `/api/collections/${collection}/records/${id}`);
    if (res.status !== 404) {
      throw new Error(`${collection}/${id}: expected no record, got ${res.status}`);
    }
  };
}

// the record of the response body was stored as returned: every field of
// the response, plus these values (for fields the response hides)
export function responseRecordStored(collection: string, fields: Row = {}): After {
  return async (ctx) => {
    const returned = JSON.parse(new TextDecoder().decode(ctx.body)) as JsonObject;
    const id = String(returned["id"]);
    const res = await superuserGet(ctx.url, `/api/collections/${collection}/records/${id}`);
    if (res.status !== 200) {
      throw new Error(`${collection}/${id}: expected the created record, got ${res.status}`);
    }
    const { expand: _expand, ...plain } = returned;
    expectFields(`${collection}/${id}`, res.json, { ...plain, ...fields });
  };
}

// the collection holds n records
export function recordCount(collection: string, n: number): After {
  return async ({ url }) => {
    const res = await superuserGet(url, `/api/collections/${collection}/records?perPage=1`);
    if (res.json["totalItems"] !== n) {
      throw new Error(
        `${collection}: expected ${n} records, got ${String(res.json["totalItems"])}`,
      );
    }
  };
}

// rows of a query on the server's data.db (read only)
export function queryRows(dataDir: string, sql: string, ...args: Array<string>): Array<unknown> {
  const db = new Database(join(dataDir, "data.db"), { readonly: true });
  try {
    return db.query(sql).all(...args);
  } finally {
    db.close();
  }
}

// the record's stored password hash matches (record.ValidatePassword)
export function passwordIs(collection: string, id: string, password: string): After {
  return async ({ dataDir }) => {
    const rows = queryRows(
      dataDir,
      `SELECT password FROM "${collection}" WHERE id = ?`,
      id,
    ) as Array<{
      password: string;
    }>;
    const hash = rows[0]?.password ?? "";
    if (hash === "" || !(await Bun.password.verify(password, hash))) {
      throw new Error(`${collection}/${id}: the password was not changed`);
    }
  };
}

// the number of _authOrigins rows of the record
export function authOriginsCount(collectionId: string, recordId: string, n: number): After {
  return ({ dataDir }) => {
    const rows = queryRows(
      dataDir,
      `SELECT id FROM _authOrigins WHERE collectionRef = ? AND recordRef = ?`,
      collectionId,
      recordId,
    );
    if (rows.length !== n) {
      return Promise.reject(new Error(`expected ${n} auth origins, got ${rows.length}`));
    }
    return Promise.resolve();
  };
}

// the number of _externalAuths rows of the record
export function externalAuthsCount(collectionId: string, recordId: string, n: number): After {
  return ({ dataDir }) => {
    const rows = queryRows(
      dataDir,
      `SELECT id FROM _externalAuths WHERE collectionRef = ? AND recordRef = ?`,
      collectionId,
      recordId,
    );
    if (rows.length !== n) {
      return Promise.reject(new Error(`expected ${n} external auths, got ${rows.length}`));
    }
    return Promise.resolve();
  };
}

// the record's storage directory is empty or missing (upstream's
// ensureDeletedFiles)
export function filesDeleted(collectionId: string, recordId: string): After {
  return async ({ dataDir }) => {
    const { readdirSync } = await import("node:fs");
    let entries: Array<string> = [];
    try {
      entries = readdirSync(join(dataDir, "storage", collectionId, recordId));
    } catch {
      // a missing directory has no files
    }
    if (entries.length !== 0) {
      throw new Error(
        `expected empty/deleted dir, found: ${entries.length} (${entries.join(", ")})`,
      );
    }
  };
}

// runs the checks in order
export function checks(...list: Array<After>): After {
  return async (ctx) => {
    for (const check of list) {
      await check(ctx);
    }
  };
}

// the stored password hash of the record of the response body matches
export function responsePasswordIs(collection: string, password: string): After {
  return async (ctx) => {
    const returned = JSON.parse(new TextDecoder().decode(ctx.body)) as JsonObject;
    await passwordIs(collection, String(returned["id"]), password)(ctx);
  };
}

// the stored row has these column values (for records whose change
// invalidates the superuser token the API checks use)
export function rowHas(table: string, id: string, columns: Row): After {
  return ({ dataDir }) => {
    const rows = queryRows(dataDir, `SELECT * FROM "${table}" WHERE id = ?`, id) as Array<Row>;
    if (rows.length !== 1) {
      return Promise.reject(new Error(`${table}/${id}: expected the row, got ${rows.length}`));
    }
    try {
      expectFields(`${table}/${id}`, rows[0] as Row, columns);
    } catch (error) {
      return Promise.reject(error);
    }
    return Promise.resolve();
  };
}
