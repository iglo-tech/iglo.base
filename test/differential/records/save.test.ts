// Record save, validate and delete (src/records/record-save.ts, the
// superusers checks, the auth refs and truncateCollection) against the
// reference PocketBase v0.41.0 binary. Not part of `bun test`: run
// `bun run test:reference`.
//
// One fresh upstream install (`superuser upsert`) is copied for both
// sides. The collections of save-cases.ts are created on both (upstream
// through POST /api/collections, iglo.base through saveCollection), then
// the steps run on both: upstream through its records API as a superuser
// (and DELETE /api/collections/{c}/truncate), iglo.base through
// saveRecord, deleteRecord and truncateCollection with what upstream's
// handlers do around them (apis/record_crud.go, forms/record_upsert.go,
// apis/collection.go collectionTruncate): the record from NewRecord or
// FindRecordById, the body decoded as Go does, ReplaceModifiers, the form's
// Load, and the error mapped to the handler's error body.
//
// After each step both sides must give the same outcome (status, and the
// error body with object members sorted) and the same rows in every
// compared table, with each column's typeof() and value. Normalized: ids
// the server generated (aliased in creation order), and the created,
// updated, tokenKey and password hash columns, compared as new, same or
// changed against the previous step's row. _authOrigins rows of the
// superusers are left out (upstream adds one when the test logs in).
//
// At the end, upstream serves iglo.base's pb_data: its integrity check
// passes, and its GET bodies of every record equal those of upstream's own
// pb_data (ids aliased, created/updated, tokenKey and hashes normalized).
//
// A "chain" step is its creates one by one, compared once at the end. A
// "batch" step is upstream's POST /api/batch (enabled in upstream's
// settings for the test) and iglo.base's creates in one transaction
// (saveRecordSync in runInAppTransaction); only its success is modeled.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { newCollection } from "@/collections/collection-model";
import {
  findCachedCollectionByNameOrId,
  findCollectionByNameOrId,
  reloadCachedCollections,
  runInAppTransaction,
  truncateCollection,
} from "@/collections/collection-query";
import { saveCollection } from "@/collections/collection-save";
import { FieldNameExpand } from "@/fields/field";
import { type DataMap, type Record, newRecord } from "@/records/record-model";
import { findRecordById } from "@/records/record-query";
import { deleteRecord, saveRecord, saveRecordSync } from "@/records/record-save";
import { ApiError, newBadRequestError, newNotFoundError } from "@/server/error";
import { decodeValue, toAny } from "@/server/json-decode";

import { openDataDir, type TestCollectionsApp } from "@test/collections/app";
import { runUpstream } from "@test/differential/db/fixture";
import {
  type Step,
  collections,
  steps,
  tables,
  volatileColumns,
} from "@test/differential/records/save-cases";
import { startUpstream, type UpstreamServer } from "@test/support/upstream";

// the hooks start and stop upstream
const hookTimeout = 120_000;

const email = "records-save@example.com";
const password = "1234567890";

let root: string | undefined;
let upstreamDir: string;
let igloDir: string;
let upstream: UpstreamServer | undefined;
let token = "";
let app: TestCollectionsApp | undefined;
let mainSuperuserId = "";
let superusersCollectionId = "";

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

async function login(s: UpstreamServer): Promise<string> {
  const res = await fetch(`${s.url}/api/collections/_superusers/auth-with-password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identity: email, password }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

async function request(
  s: UpstreamServer,
  method: string,
  path: string,
  body?: string,
): Promise<{ status: number; text: string }> {
  const res = await fetch(`${s.url}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: token },
    ...(body === undefined ? {} : { body }),
  });
  return { status: res.status, text: await res.text() };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "iglo-base-records-save-ref-"));
  upstreamDir = join(root, "upstream", "pb_data");
  igloDir = join(root, "iglo", "pb_data");
  const upsert = await runUpstream(
    ["superuser", "upsert", email, password, "--dir", upstreamDir],
    root,
  );
  expect(upsert.exitCode).toBe(0);
  cpSync(upstreamDir, igloDir, { recursive: true });

  const fresh = new Database(join(igloDir, "data.db"), { readonly: true });
  try {
    mainSuperuserId = String(
      (fresh.query("SELECT id FROM _superusers").get() as { id: string }).id,
    );
    superusersCollectionId = String(
      (
        fresh.query("SELECT id FROM _collections WHERE name = '_superusers'").get() as {
          id: string;
        }
      ).id,
    );
  } finally {
    fresh.close();
  }

  upstream = await startUpstream({ dataDir: upstreamDir });
  token = await login(upstream);
  const settings = await request(
    upstream,
    "PATCH",
    "/api/settings",
    JSON.stringify({ batch: { enabled: true } }),
  );
  expect(settings.status).toBe(200);

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
// outcomes

interface Outcome {
  status: number;
  body: string;
  // the id of a created record
  id?: string;
}

// obj[key] = value as an own property, also for the key "__proto__"
function setOwn<T>(obj: { [key: string]: T }, key: string, value: T): void {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

// JSON text with the object members sorted (Go writes maps in random order)
function sortedJSON(text: string): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      return v.map(sort);
    }
    if (v !== null && typeof v === "object") {
      const out: { [key: string]: unknown } = {};
      for (const key of Object.keys(v).toSorted()) {
        setOwn(out, key, sort((v as { [key: string]: unknown })[key]));
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(JSON.parse(text)));
}

function apiError(err: ApiError): Outcome {
  return { status: err.status, body: sortedJSON(JSON.stringify(err)) };
}

// apis/record_helpers.go firstApiError: the ApiError in the error chain
function firstApiError(err: unknown): ApiError | null {
  if (err instanceof ApiError) {
    return err;
  }
  if (err instanceof AggregateError) {
    for (const e of err.errors) {
      const found = firstApiError(e);
      if (found !== null) {
        return found;
      }
    }
  }
  if (err instanceof Error && err.cause !== undefined) {
    return firstApiError(err.cause);
  }
  return null;
}

// ---------------------------------------------------------------------
// upstream

async function upstreamStep(step: Step, resolve: (id: string) => string): Promise<Outcome> {
  let res: { status: number; text: string };
  switch (step.kind) {
    case "create":
      res = await request(
        server(),
        "POST",
        `/api/collections/${step.collection}/records`,
        JSON.stringify(step.body),
      );
      break;
    case "update":
      res = await request(
        server(),
        "PATCH",
        `/api/collections/${step.collection}/records/${resolve(step.id)}`,
        JSON.stringify(step.body),
      );
      break;
    case "delete":
      res = await request(
        server(),
        "DELETE",
        `/api/collections/${step.collection}/records/${resolve(step.id)}`,
      );
      break;
    case "truncate":
      res = await request(server(), "DELETE", `/api/collections/${step.collection}/truncate`);
      break;
    case "chain":
      for (const [i, id] of step.ids.entries()) {
        res = await request(
          server(),
          "POST",
          `/api/collections/${step.collection}/records`,
          JSON.stringify({ id, [step.field]: i === 0 ? "" : step.ids[i - 1] }),
        );
        if (res.status !== 200) {
          return { status: res.status, body: sortedJSON(res.text) };
        }
      }
      return { status: 200, body: "" };
    case "batch":
      res = await request(
        server(),
        "POST",
        "/api/batch",
        JSON.stringify({
          requests: step.creates.map((c) => ({
            method: "POST",
            url: `/api/collections/${c.collection}/records`,
            body: c.body,
          })),
        }),
      );
      return { status: res.status, body: res.status === 200 ? "" : sortedJSON(res.text) };
  }
  if (res.status === 200 || res.status === 204) {
    const outcome: Outcome = { status: res.status, body: "" };
    if (step.kind === "create") {
      outcome.id = (JSON.parse(res.text) as { id: string }).id;
    }
    return outcome;
  }
  return { status: res.status, body: sortedJSON(res.text) };
}

// ---------------------------------------------------------------------
// the model of upstream's handlers

// the request body as RequestInfo.Body holds it
function requestBody(body: { [key: string]: unknown }): DataMap {
  return toAny(decodeValue(JSON.stringify(body))) as DataMap;
}

// forms.RecordUpsert.Load with superuser access
function formLoad(record: Record, data: DataMap): void {
  const excludeFields = [FieldNameExpand];
  if (record.collection().isAuth()) {
    // the form's password fields are checked by the form (the steps send
    // matching passwordConfirm values) and not loaded
    expect(data.password === undefined || data.password === data.passwordConfirm).toBe(true);
    excludeFields.push("passwordConfirm", "oldPassword");
  }
  for (const [k, v] of Object.entries(data)) {
    if (excludeFields.includes(k)) {
      continue;
    }
    record.setIfFieldExists(k, v);
  }
}

async function modelStep(step: Step, resolve: (id: string) => string): Promise<Outcome> {
  if (step.kind === "chain") {
    for (const [i, id] of step.ids.entries()) {
      const outcome = await modelStep(
        {
          kind: "create",
          collection: step.collection,
          body: { id, [step.field]: i === 0 ? "" : step.ids[i - 1] },
        },
        resolve,
      );
      if (outcome.status !== 200) {
        return outcome;
      }
    }
    return { status: 200, body: "" };
  }

  if (step.kind === "batch") {
    runInAppTransaction(model(), (txApp) => {
      for (const c of step.creates) {
        const record = newRecord(findCachedCollectionByNameOrId(txApp, c.collection));
        formLoad(record, record.replaceModifiers(requestBody(c.body)));
        saveRecordSync(txApp, record);
      }
    });
    return { status: 200, body: "" };
  }

  let collection;
  try {
    collection = findCachedCollectionByNameOrId(model(), step.collection);
  } catch (err) {
    return apiError(
      step.kind === "truncate"
        ? newNotFoundError("", err)
        : newNotFoundError("Missing collection context.", err),
    );
  }

  if (step.kind === "truncate") {
    if (collection.isView()) {
      return apiError(
        newBadRequestError(
          "View collections cannot be truncated since they don't store their own records.",
          null,
        ),
      );
    }
    try {
      truncateCollection(model(), collection);
    } catch (err) {
      return apiError(
        newBadRequestError(
          "Failed to truncate collection (most likely due to required cascade delete record references).",
          err,
        ),
      );
    }
    return { status: 204, body: "" };
  }

  if (collection.isView()) {
    return apiError(newBadRequestError("Unsupported collection type.", null));
  }

  if (step.kind === "create") {
    const record = newRecord(collection);
    formLoad(record, record.replaceModifiers(requestBody(step.body)));
    try {
      await saveRecord(model(), record);
    } catch (err) {
      return apiError(firstApiError(err) ?? newBadRequestError("Failed to create record", err));
    }
    return { status: 200, body: "", id: record.id };
  }

  let record: Record;
  try {
    record = findRecordById(model(), collection, resolve(step.id));
  } catch (err) {
    return apiError(newNotFoundError("", err));
  }

  if (step.kind === "update") {
    formLoad(record, record.replaceModifiers(requestBody(step.body)));
    try {
      await saveRecord(model(), record);
    } catch (err) {
      return apiError(firstApiError(err) ?? newBadRequestError("Failed to update record.", err));
    }
    return { status: 200, body: "" };
  }

  try {
    await deleteRecord(model(), record);
  } catch (err) {
    return apiError(
      firstApiError(err) ??
        newBadRequestError(
          "Failed to delete record. Make sure that the record is not part of a required relation reference.",
          err,
        ),
    );
  }
  return { status: 204, body: "" };
}

// ---------------------------------------------------------------------
// table snapshots

type Cell = [string, unknown];
type Row = { [column: string]: Cell };
type Snapshot = Map<string, Map<string, Row>>; // table -> id -> row

function snapshot(db: Database): Snapshot {
  const result: Snapshot = new Map();
  for (const table of tables) {
    const columns = (db.query(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map(
      (c) => c.name,
    );
    const select = columns.map((c) => `typeof("${c}"), "${c}"`).join(", ");
    const rows = new Map<string, Row>();
    for (const values of db.query(`SELECT ${select} FROM "${table}"`).values()) {
      const row: Row = {};
      for (const [i, c] of columns.entries()) {
        let v = values[2 * i + 1];
        if (v instanceof Uint8Array) {
          v = "0x" + Buffer.from(v).toString("hex");
        } else if (typeof v === "bigint") {
          v = `${v}n`;
        }
        setOwn(row, c, [String(values[2 * i]), v]);
      }
      if (table === "_authOrigins" && row.collectionRef?.[1] === superusersCollectionId) {
        continue;
      }
      rows.set(String(row.id?.[1]), row);
    }
    result.set(table, rows);
  }
  return result;
}

// the snapshot with generated ids aliased and the volatile columns as
// new/same/changed against the previous snapshot
function normalize(
  current: Snapshot,
  previous: Snapshot | null,
  aliases: Map<string, string>,
): { [table: string]: Row[] } {
  const alias = (v: unknown): unknown => {
    if (typeof v !== "string") {
      return v;
    }
    let s = v;
    for (const [id, name] of aliases) {
      s = s.replaceAll(id, name);
    }
    return s;
  };

  const out: { [table: string]: Row[] } = {};
  for (const [table, rows] of current) {
    const prevRows = previous?.get(table);
    const list: Row[] = [];
    for (const [id, row] of rows) {
      const prevRow = prevRows?.get(id);
      const norm: Row = {};
      for (const [c, [type, v]] of Object.entries(row)) {
        if (volatileColumns.includes(c)) {
          const state = prevRow === undefined ? "new" : prevRow[c]?.[1] === v ? "same" : "changed";
          setOwn(norm, c, [type, v === "" ? "<empty>" : state]);
        } else {
          setOwn(norm, c, [type, alias(v)]);
        }
      }
      list.push(norm);
    }
    list.sort((a, b) => String(a.id?.[1]).localeCompare(String(b.id?.[1])));
    out[table] = list;
  }
  return out;
}

// ---------------------------------------------------------------------
// the GET bodies of every record

async function getBodies(
  s: UpstreamServer,
  snap: Snapshot,
  aliases: Map<string, string>,
): Promise<{ [key: string]: unknown }> {
  const result: { [key: string]: unknown } = {};
  for (const table of tables) {
    for (const id of snap.get(table)?.keys() ?? []) {
      const res = await request(s, "GET", `/api/collections/${table}/records/${id}`);
      expect(res.status).toBe(200);
      let text = res.text;
      for (const [real, name] of aliases) {
        text = text.replaceAll(real, name);
      }
      const body = JSON.parse(text) as { [key: string]: unknown };
      for (const key of ["created", "updated"]) {
        if (key in body) {
          expect(body[key]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}Z$/);
          body[key] = "<date>";
        }
      }
      for (const key of ["tokenKey", "password", "secret"]) {
        if (key in body) {
          body[key] = typeof body[key];
        }
      }
      result[`${table}/${body.id as string}`] = body;
    }
  }
  return result;
}

// ---------------------------------------------------------------------

describe("record save and delete", () => {
  let upstreamDB: Database;
  let igloDB: Database;
  let upstreamPrev: Snapshot | null = null;
  let igloPrev: Snapshot | null = null;
  const upstreamAliases = new Map<string, string>();
  const igloAliases = new Map<string, string>();
  const outcomes: { upstream: Outcome; iglo: Outcome }[] = [];

  beforeAll(() => {
    upstreamDB = new Database(join(upstreamDir, "data.db"), { safeIntegers: true });
    igloDB = new Database(join(igloDir, "data.db"), { safeIntegers: true });
    upstreamDB.run("PRAGMA busy_timeout = 10000");
    igloDB.run("PRAGMA busy_timeout = 10000");
  });

  afterAll(() => {
    upstreamDB.close();
    igloDB.close();
  });

  test("collections", async () => {
    for (const c of collections) {
      const body = JSON.stringify(c.body);
      const res = await request(server(), "POST", "/api/collections", body);
      expect({ status: res.status, body: res.status === 200 ? "" : res.text }).toEqual({
        status: 200,
        body: "",
      });

      const collection = newCollection(c.body.type as string, c.body.name as string);
      collection.unmarshalJSON(body);
      saveCollection(model(), collection);

      if (c.patch !== undefined) {
        const patch = JSON.stringify(c.patch);
        const res2 = await request(
          server(),
          "PATCH",
          `/api/collections/${c.body.id as string}`,
          patch,
        );
        expect({ status: res2.status, body: res2.status === 200 ? "" : res2.text }).toEqual({
          status: 200,
          body: "",
        });

        const existing = findCollectionByNameOrId(model(), c.body.id as string);
        existing.unmarshalJSON(patch);
        saveCollection(model(), existing);
      }
    }

    upstreamPrev = snapshot(upstreamDB);
    igloPrev = snapshot(igloDB);
    expect(normalize(igloPrev, null, igloAliases)).toEqual(
      normalize(upstreamPrev, null, upstreamAliases),
    );
  }, 60_000);

  test("steps", async () => {
    for (const [i, step] of steps.entries()) {
      const resolveUpstream = (id: string) => (id === "$main" ? mainSuperuserId : id);
      const resolveIglo = resolveUpstream;

      const up = await upstreamStep(step, resolveUpstream);
      const ig = await modelStep(step, resolveIglo);
      outcomes.push({ upstream: up, iglo: ig });

      const label = `step ${i}: ${JSON.stringify(step)}`;
      expect({ label, status: ig.status, body: ig.body }).toEqual({
        label,
        status: up.status,
        body: up.body,
      });

      // a server generated id gets the next alias
      if (step.kind === "create" && step.body.id === undefined && up.id !== undefined) {
        const name = `<gen${upstreamAliases.size}>`;
        upstreamAliases.set(up.id, name);
        igloAliases.set(ig.id as string, name);
      }

      const upSnap = snapshot(upstreamDB);
      const igSnap = snapshot(igloDB);
      expect({ label, tables: normalize(igSnap, igloPrev, igloAliases) }).toEqual({
        label,
        tables: normalize(upSnap, upstreamPrev, upstreamAliases),
      });
      upstreamPrev = upSnap;
      igloPrev = igSnap;
    }
  }, 180_000);

  test("the sample is large enough", () => {
    expect(steps.length).toBeGreaterThanOrEqual(60);
    const statuses = outcomes.map((o) => o.upstream.status);
    const count = (status: number) => statuses.filter((s) => s === status).length;
    expect(count(200)).toBeGreaterThan(30); // creates and updates
    expect(count(204)).toBeGreaterThan(10); // deletes and truncates
    expect(count(400)).toBeGreaterThan(15); // validation and delete failures
    expect(upstreamAliases.size).toBeGreaterThan(1);
  });

  test(
    "upstream reads iglo.base's records with the same GET bodies",
    async () => {
      const upstreamBodies = await getBodies(server(), upstreamPrev as Snapshot, upstreamAliases);

      await server().stop();
      upstream = undefined;
      model().cleanup();
      app = undefined;
      igloDB.close();

      const check = new Database(join(igloDir, "data.db"), { readonly: true });
      try {
        expect(check.query("PRAGMA integrity_check").values()).toEqual([["ok"]]);
      } finally {
        check.close();
      }

      upstream = await startUpstream({ dataDir: igloDir });
      token = await login(upstream);
      const igloBodies = await getBodies(server(), igloPrev as Snapshot, igloAliases);

      expect(Object.keys(igloBodies).length).toBeGreaterThan(10);
      expect(igloBodies).toEqual(upstreamBodies);

      // reopened for afterAll
      igloDB = new Database(":memory:");
    },
    hookTimeout,
  );
});
