// Collection save, delete and import (src/collections/collection-save.ts,
// collection-import.ts, view.ts, collection-record-table-sync.ts) against
// the reference PocketBase v0.41.0 binary. Not part of `bun test`: run
// `bun run test:reference`.
//
// One fresh upstream install (`superuser upsert`) is copied for both
// sides, as M1.2's system migrations are not ported. The steps of
// save-cases.ts run on both: upstream through its /api/collections and
// /api/collections/import endpoints (rows through POST /api/sql),
// iglo.base through saveCollection, deleteCollection and
// importCollections on its own copy, with what upstream's handlers do
// around them (apis/collection.go, apis/collection_import.go): the
// collection from NewCollection or FindCollectionByNameOrId with the body
// unmarshaled into it, and the error mapped to the handler's 400 body.
//
// After each step both sides must give the same outcome (status and body;
// error bodies with object members sorted, as upstream writes Go maps in
// random order; a created or updated collection's JSON), the same
// `sqlite_schema` rows (type, name, tbl_name, sql), the same
// `_collections` rows and the same record rows of the test tables.
// Normalized: created and updated, the random ids of view fields copied
// from a collection ("_clone_" + 4 characters) and the auth token
// secrets, which are random; whether each secret is new, kept or changed
// is compared.
//
// At the end, upstream is started on iglo.base's pb_data: it opens it
// without errors, its integrity check passes, and its GET /api/collections
// returns the same bodies as for its own sequence.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Collection, newCollection } from "@/collections/collection-model";
import { importCollections } from "@/collections/collection-import";
import {
  findCachedCollectionByNameOrId,
  findCollectionByNameOrId,
  findCollectionReferences,
  reloadCachedCollections,
} from "@/collections/collection-query";
import { deleteCollection, saveCollection } from "@/collections/collection-save";
import { decodeString, unmarshalGoStruct } from "@/collections/go-json-struct";
import { newBadRequestError, newNotFoundError } from "@/server/error";
import { anyType, mapOf, sliceOf, unmarshal } from "@/tools/types/go-json";
import { Errors, NewError } from "@/validation/error";

import { openDataDir, type TestCollectionsApp } from "@test/collections/app";
import { runUpstream } from "@test/differential/db/fixture";
import { type Ctx, type Step, steps } from "@test/differential/collections/save-cases";
import { startUpstream, type UpstreamServer } from "@test/support/upstream";

// the hooks start and stop upstream, which is slow on the macOS runners
const hookTimeout = 120_000;

const email = "save@example.com";
const password = "1234567890";

// the record tables whose rows are compared
const recordTables = ["posts", "articles", "comments", "members", "people", "imported"];

let root: string | undefined;
let upstreamDir: string;
let igloDir: string;
let upstream: UpstreamServer | undefined;
let token = "";
let app: TestCollectionsApp | undefined;

async function request(
  target: UpstreamServer,
  method: string,
  path: string,
  body?: string,
): Promise<{ status: number; text: string }> {
  const res = await fetch(`${target.url}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: token },
    ...(body === undefined ? {} : { body }),
  });
  return { status: res.status, text: await res.text() };
}

function server(): UpstreamServer {
  if (upstream === undefined) {
    throw new Error("upstream is not running");
  }
  return upstream;
}

function model(): TestCollectionsApp {
  if (app === undefined) {
    throw new Error("the model app is closed");
  }
  return app;
}

// rows through upstream's POST /api/sql
async function upstreamSQL(query: string): Promise<unknown[][]> {
  const res = await request(server(), "POST", "/api/sql", JSON.stringify({ query }));
  if (res.status !== 200) {
    throw new Error(`POST /api/sql ${query}: ${res.status} ${res.text}`);
  }
  return (JSON.parse(res.text) as { rows: unknown[][] }).rows;
}

// the rows as upstream's /api/sql returns them (values as text)
function modelSQL(query: string): unknown[][] {
  return model()
    .databases.concurrentDB()
    .newQuery(query)
    .all<Record<string, unknown>>()
    .map((row) => Object.values(row).map((v) => (v === null ? null : String(v))));
}

async function upstreamCollections(s: UpstreamServer): Promise<Record<string, unknown>[]> {
  const res = await request(s, "GET", "/api/collections?perPage=500&sort=name");
  expect(res.status).toBe(200);
  return (JSON.parse(res.text) as { items: Record<string, unknown>[] }).items;
}

async function readCtx(): Promise<Ctx> {
  const items = await upstreamCollections(server());
  const byName = new Map(items.map((c) => [c.name as string, c]));
  const get = (name: string) => {
    const c = byName.get(name);
    if (c === undefined) {
      throw new Error(`no collection ${name}`);
    }
    return structuredClone(c);
  };
  return {
    id: (name) => get(name).id as string,
    fields: (name) => get(name).fields as Record<string, unknown>[],
    collection: get,
    all: () => structuredClone(items),
  };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "iglo-base-collections-save-ref-"));
  upstreamDir = join(root, "upstream", "pb_data");
  igloDir = join(root, "iglo", "pb_data");
  const upsert = await runUpstream(
    ["superuser", "upsert", email, password, "--dir", upstreamDir],
    root,
  );
  expect(upsert.exitCode).toBe(0);
  cpSync(upstreamDir, igloDir, { recursive: true });

  upstream = await startUpstream({ dataDir: upstreamDir });
  const res = await fetch(`${upstream.url}/api/collections/_superusers/auth-with-password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identity: email, password }),
  });
  expect(res.status).toBe(200);
  token = ((await res.json()) as { token: string }).token;

  app = openDataDir(igloDir);
  // the bootstrap cache load
  reloadCachedCollections(app);
}, hookTimeout);

afterAll(async () => {
  app?.cleanup();
  await upstream?.stop();
  if (root !== undefined) {
    rmSync(root, { recursive: true, force: true });
  }
}, hookTimeout);

// ---------------------------------------------------------------------
// the model of upstream's handlers

interface Outcome {
  status: number;
  body: string;
}

function apiError(err: ReturnType<typeof newBadRequestError>): Outcome {
  return { status: err.status, body: sortedJSON(JSON.stringify(err)) };
}

// apis/collection.go collectionCreate and collectionUpdate
function modelSave(target: string | undefined, body: string): Outcome {
  let collection: Collection;
  if (target === undefined) {
    // populate the minimal required factory collection data (if any)
    const factoryExtract = { type: "", name: "" };
    unmarshalGoStruct(
      body,
      {
        type: (raw) => (factoryExtract.type = decodeString(raw)),
        name: (raw) => (factoryExtract.name = decodeString(raw)),
      },
      () => {},
    );

    // create scaffold
    collection = newCollection(factoryExtract.type, factoryExtract.name);
  } else {
    try {
      collection = findCollectionByNameOrId(model(), target);
    } catch (err) {
      return apiError(newNotFoundError("", err));
    }
  }

  // merge the scaffold with the submitted request data
  collection.unmarshalJSON(body);

  try {
    saveCollection(model(), collection);
  } catch (err) {
    const action = target === undefined ? "create" : "update";
    // validation failure
    if (err instanceof Errors) {
      return apiError(newBadRequestError(`Failed to ${action} collection.`, err));
    }
    // other generic db error
    return apiError(
      newBadRequestError(
        `Failed to ${action} collection. Raw error: \n${err instanceof Error ? err.message : String(err)}`,
        null,
      ),
    );
  }

  return { status: 200, body: normalizedCollectionJSON(collection.marshalJSON()) };
}

// apis/collection.go collectionDelete
function modelDelete(target: string): Outcome {
  let collection: Collection;
  try {
    collection = findCachedCollectionByNameOrId(model(), target);
  } catch (err) {
    return apiError(newNotFoundError("", err));
  }

  try {
    deleteCollection(model(), collection);
  } catch (err) {
    let msg = "Failed to delete collection";

    // check fo references
    let refs = new Map<Collection, unknown>();
    try {
      refs = findCollectionReferences(model(), collection, collection.id);
    } catch {
      // ignored, as upstream does
    }
    if (refs.size > 0) {
      msg +=
        " probably due to existing reference in " + [...refs.keys()].map((r) => r.name).join(", ");
    }

    return apiError(newBadRequestError(msg, err));
  }

  return { status: 204, body: "" };
}

// apis/collection_import.go collectionsImport
function modelImport(body: string): Outcome {
  const form = unmarshal(body, mapOf(anyType)) as {
    collections: unknown;
    deleteMissing?: boolean;
  };
  const data = (unmarshal(JSON.stringify(form.collections), sliceOf(mapOf(anyType))) ??
    []) as Record<string, unknown>[];

  try {
    importCollections(model(), data, form.deleteMissing === true);
  } catch (err) {
    // validation failure
    if (err instanceof Errors) {
      return apiError(newBadRequestError("Failed to import collections.", err));
    }

    // generic/db failure
    return apiError(
      newBadRequestError(
        "Failed to import collections.",
        new Errors({
          collections: NewError(
            "validation_collections_import_failure",
            "Failed to import the collections configuration. Raw error:\n" +
              (err instanceof Error ? err.message : String(err)),
          ),
        }),
      ),
    );
  }

  return { status: 204, body: "" };
}

// ---------------------------------------------------------------------
// normalization

// a JSON value with its object members sorted (Go's map order is random)
function sortedJSON(text: string): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      return v.map(sort);
    }
    if (typeof v === "object" && v !== null) {
      const out: Record<string, unknown> = Object.create(null);
      for (const key of Object.keys(v).toSorted()) {
        out[key] = sort((v as Record<string, unknown>)[key]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(JSON.parse(text)));
}

// a view field copied from a collection gets a random "_clone_" id
// (core/view.go parseQueryToFields)
function withoutCloneIds(text: string): string {
  return text.replace(/"_clone_[A-Za-z0-9]{4}"/g, `"_clone_<random>"`);
}

// a collection's JSON with created, updated and the clone ids replaced
function normalizedCollectionJSON(text: string): string {
  const c = JSON.parse(withoutCloneIds(text)) as Record<string, unknown>;
  c.created = "<created>";
  c.updated = "<updated>";
  return sortedJSON(JSON.stringify(c));
}

// the secrets of an options JSON, by their path
function secretsOf(options: unknown, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof options === "object" && options !== null) {
    for (const [key, value] of Object.entries(options)) {
      const path = prefix + "." + key;
      if (key === "secret" && typeof value === "string") {
        out.set(path, value);
      } else {
        for (const [p, v] of secretsOf(value, path)) {
          out.set(p, v);
        }
      }
    }
  }
  return out;
}

function replaceSecrets(options: unknown, marks: Map<string, string>, prefix = ""): unknown {
  if (Array.isArray(options)) {
    return options.map((v, i) => replaceSecrets(v, marks, `${prefix}.${i}`));
  }
  if (typeof options === "object" && options !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(options)) {
      const path = prefix + "." + key;
      out[key] =
        key === "secret" && typeof value === "string"
          ? (marks.get(path) ?? "<secret>")
          : replaceSecrets(value, marks, path);
    }
    return out;
  }
  return options;
}

interface Side {
  name: string;
  sql(query: string): Promise<unknown[][]> | unknown[][];
  // the secrets of the previous snapshot, by collection id and path
  secrets: Map<string, string>;
}

interface Snapshot {
  schema: unknown[][];
  collections: unknown[][];
  records: Record<string, unknown[][]>;
}

const collectionColumns = [
  "rowid",
  "id",
  "system",
  "type",
  "name",
  "fields",
  "indexes",
  "listRule",
  "viewRule",
  "createRule",
  "updateRule",
  "deleteRule",
  "options",
  "created",
  "updated",
];

async function snapshot(side: Side): Promise<Snapshot> {
  const schema = await side.sql(
    "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY name, type",
  );

  const rows = await side.sql(
    `SELECT ${collectionColumns.map((c) => `[${c}]`).join(", ")}, ${collectionColumns
      .map((c) => `typeof([${c}])`)
      .join(", ")} FROM _collections ORDER BY rowid`,
  );
  const secrets = new Map<string, string>();
  const collections = rows.map((row) => {
    const r = [...row];
    const id = String(r[1]);
    const optionsIndex = collectionColumns.indexOf("options");
    const options = JSON.parse(String(r[optionsIndex])) as unknown;
    const marks = new Map<string, string>();
    for (const [path, value] of secretsOf(options)) {
      const key = `${id}${path}`;
      secrets.set(key, value);
      const previous = side.secrets.get(key);
      marks.set(
        path,
        previous === undefined ? "<new>" : previous === value ? "<kept>" : "<changed>",
      );
    }
    r[optionsIndex] = JSON.stringify(replaceSecrets(options, marks));
    const fieldsIndex = collectionColumns.indexOf("fields");
    r[fieldsIndex] = withoutCloneIds(String(r[fieldsIndex]));
    r[collectionColumns.indexOf("created")] = "<created>";
    r[collectionColumns.indexOf("updated")] = "<updated>";
    return r;
  });
  side.secrets = secrets;

  const tables = new Set(schema.filter((r) => r[0] === "table").map((r) => String(r[1])));
  const records: Record<string, unknown[][]> = {};
  for (const table of recordTables) {
    if (tables.has(table)) {
      records[table] = await side.sql(`SELECT * FROM [${table}] ORDER BY id`);
    }
  }

  return { schema, collections, records };
}

// ---------------------------------------------------------------------

const upstreamSide: Side = { name: "upstream", sql: upstreamSQL, secrets: new Map() };
const modelSide: Side = { name: "iglo.base", sql: modelSQL, secrets: new Map() };

async function upstreamOutcome(step: Step, body: string): Promise<Outcome> {
  let res: { status: number; text: string };
  switch (step.kind) {
    case "create":
      res = await request(server(), "POST", "/api/collections", body);
      break;
    case "update":
      res = await request(server(), "PATCH", `/api/collections/${step.target}`, body);
      break;
    case "delete":
      res = await request(server(), "DELETE", `/api/collections/${step.target}`);
      break;
    case "import":
      res = await request(server(), "PUT", "/api/collections/import", body);
      break;
    case "sql":
      throw new Error("not an API step");
  }
  if (res.status === 200) {
    return { status: 200, body: normalizedCollectionJSON(res.text) };
  }
  return { status: res.status, body: res.text === "" ? "" : sortedJSON(res.text) };
}

function modelOutcome(step: Step, body: string): Outcome {
  switch (step.kind) {
    case "create":
      return modelSave(undefined, body);
    case "update":
      return modelSave(step.target, body);
    case "delete":
      return modelDelete(step.target);
    case "import":
      return modelImport(body);
    case "sql":
      throw new Error("not an API step");
  }
}

const results = { ok: 0, failed: 0 };

describe("collection save sequence against upstream", () => {
  test("the starting state is the same", async () => {
    expect(await snapshot(modelSide)).toEqual(await snapshot(upstreamSide));
  });

  for (const step of steps) {
    test(step.name, async () => {
      if (step.kind === "sql") {
        for (const query of step.sql) {
          await upstreamSQL(query);
          model().databases.nonconcurrentDB().newQuery(query).execute();
        }
      } else {
        const ctx = await readCtx();
        const body = step.kind === "delete" ? "" : JSON.stringify(step.body(ctx));

        const expected = await upstreamOutcome(step, body);
        const got = modelOutcome(step, body);
        // DryRunView generates a fresh temporary name on each side.
        if (step.name === "reject malformed JSON in view sample") {
          expected.body = expected.body.replace(/temp_view_[a-zA-Z0-9]{5}/g, "temp_view_RANDOM");
          got.body = got.body.replace(/temp_view_[a-zA-Z0-9]{5}/g, "temp_view_RANDOM");
        }

        // upstream's outcome is the step's expectation
        const ok = expected.status < 300;
        expect({ step: step.name, ok, body: ok ? "" : expected.body }).toEqual({
          step: step.name,
          ok: step.ok,
          body: ok ? "" : expected.body,
        });
        if (ok) {
          results.ok++;
        } else {
          results.failed++;
        }

        expect({ step: step.name, payload: body, ...got }).toEqual({
          step: step.name,
          payload: body,
          ...expected,
        });
      }

      const want = await snapshot(upstreamSide);
      const have = await snapshot(modelSide);
      expect(have.schema).toEqual(want.schema);
      expect(have.collections).toEqual(want.collections);
      expect(have.records).toEqual(want.records);
    });
  }

  test("at least 40 steps ran, with failing ones", () => {
    expect(results.ok + results.failed).toBeGreaterThanOrEqual(40);
    expect(results.failed).toBeGreaterThanOrEqual(10);
  });

  test(
    "upstream opens the pb_data changed by iglo.base",
    async () => {
      const want = await upstreamCollections(server());

      model().cleanup();
      app = undefined;

      const other = await startUpstream({ dataDir: igloDir });
      try {
        const res = await fetch(`${other.url}/api/collections/_superusers/auth-with-password`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ identity: email, password }),
        });
        expect(res.status).toBe(200);
        const otherToken = ((await res.json()) as { token: string }).token;
        const previous = token;
        token = otherToken;
        try {
          const integrity = await request(
            other,
            "POST",
            "/api/sql",
            JSON.stringify({ query: "PRAGMA integrity_check" }),
          );
          expect(integrity.status).toBe(200);
          expect((JSON.parse(integrity.text) as { rows: unknown[][] }).rows).toEqual([["ok"]]);

          const have = await upstreamCollections(other);
          const normalize = (items: Record<string, unknown>[]) =>
            items.map((c) => normalizedCollectionJSON(JSON.stringify(c)));
          expect(normalize(have)).toEqual(normalize(want));
        } finally {
          token = previous;
        }
      } finally {
        await other.stop();
      }
    },
    hookTimeout,
  );
});
