// The Collections API (src/apis/collection.ts, collection-import.ts)
// against the reference PocketBase v0.41.0 binary. Not part of `bun test`:
// run `bun run test:reference`.
//
//   - Sessions (api-cases.ts): every request goes to both servers in the
//     same order, each on its own copy of upstream's fixture; the responses
//     are compared as the scenario harness compares them. After a session
//     the stored state must be the same: the data.db schema (every table,
//     index and view with its SQL), the `_collections` rows (generated
//     values masked: the `_clone_` ids of view fields, the auth token
//     secrets; `created` and `updated` by format), the record ids of every
//     table and the files under pb_data/storage.
//   - Round trip: after a session marked roundTrip, iglo.base is stopped
//     and upstream started on the pb_data iglo.base wrote; its
//     GET /api/collections and the records list of every collection must
//     be byte-identical to iglo.base's answers before it stopped.

import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type ApiCase,
  type Identity,
  type Session,
  sessions,
} from "@test/differential/collections/api-cases";
import { compareResponses, Pairing, readStartingData } from "@test/differential/harness/compare";
import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";
import { superuserToken, usersToken } from "@test/scenarios/record-crud";
import type { ScenarioResponse } from "@test/scenarios/request";
import { send } from "@test/scenarios/runner";
import type { Scenario } from "@test/scenarios/scenario";
import { startServer } from "@test/support/executable";
import { startUpstream } from "@test/support/upstream";

// starting and stopping the servers is slow on some runners
const timeout = 180_000;

interface Server {
  url: string;
  stop(): Promise<unknown>;
}

const roots: string[] = [];
const running = new Set<Server>();

afterAll(async () => {
  await Promise.allSettled([...running].map((s) => s.stop()));
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixtureCopy(): string {
  const root = mkdtempSync(join(tmpdir(), "iglo-base-collections-api-"));
  roots.push(root);
  const dataDir = join(root, "pb_data");
  copyDataDir(fixtureDir, dataDir);
  return dataDir;
}

function copyOf(dataDir: string): string {
  const copy = fixtureCopy();
  rmSync(copy, { recursive: true });
  copyDataDir(dataDir, copy);
  return copy;
}

async function track<T extends Server>(server: Promise<T>): Promise<T> {
  const s = await server;
  running.add(s);
  return s;
}

async function stop(server: Server): Promise<void> {
  running.delete(server);
  await server.stop();
}

const tokens: Record<Identity, string> = {
  guest: "",
  users: usersToken,
  superuser: superuserToken,
};

function request(c: ApiCase): Scenario {
  const headers: Record<string, string> = { ...c.headers };
  if (tokens[c.as] !== "") {
    headers["Authorization"] = tokens[c.as];
  }
  return { name: c.name, method: c.method, url: c.url, headers, body: c.body, expectedStatus: 0 };
}

async function sendTo(url: string, req: Scenario): Promise<ScenarioResponse> {
  const res = await send(url, req);
  if ("error" in res) {
    throw new Error(`${req.name}: ${res.error}`);
  }
  return res;
}

// -------------------------------------------------------------------
// stored state

const dateFormat = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}Z$/;

function withDb<T>(dataDir: string, fn: (db: Database) => T): T {
  const db = new Database(join(dataDir, "data.db"), { readonly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

interface StoredState {
  schema: unknown[];
  collections: Record<string, unknown>[];
  timestamps: string[];
  records: Record<string, string[]>;
  files: string[];
}

function mask(text: unknown): unknown {
  return typeof text === "string"
    ? text
        .replace(/_clone_[A-Za-z0-9]{4}/g, "_clone_*")
        .replace(/("secret":)"[A-Za-z0-9]{50}"/g, '$1"*"')
    : text;
}

function storedState(dataDir: string): StoredState {
  return withDb(dataDir, (db) => {
    const schema = db
      .query(
        "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .all();
    const rows = db.query("SELECT * FROM _collections ORDER BY name").all() as Record<
      string,
      unknown
    >[];
    const timestamps: string[] = [];
    const collections = rows.map((row) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) {
        if (k === "created" || k === "updated") {
          timestamps.push(`${String(row["name"])}.${k}: ${dateFormat.test(String(v)) ? "ok" : v}`);
        } else {
          out[k] = mask(v);
        }
      }
      return out;
    });
    const records: Record<string, string[]> = {};
    for (const row of rows) {
      if (row["type"] === "view") {
        continue;
      }
      const name = String(row["name"]);
      records[name] = (
        db.query(`SELECT id FROM "${name.replaceAll('"', '""')}" ORDER BY id`).all() as {
          id: string;
        }[]
      ).map((r) => r.id);
    }
    return { schema, collections, timestamps, records, files: listFiles(join(dataDir, "storage")) };
  });
}

function listFiles(dir: string, prefix = ""): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir).toSorted();
  } catch {
    return [];
  }
  return entries.flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory()
      ? listFiles(path, `${prefix}${name}/`)
      : [`${prefix}${name}`];
  });
}

// -------------------------------------------------------------------
// round trip

// GET /api/collections and every collection's records list
async function readBack(url: string, dataDir: string): Promise<[string, ScenarioResponse][]> {
  const names = withDb(dataDir, (db) =>
    (db.query("SELECT name FROM _collections ORDER BY name").all() as { name: string }[]).map(
      (r) => r.name,
    ),
  );
  const urls = [
    "/api/collections?perPage=500",
    ...names.map((n) => `/api/collections/${encodeURIComponent(n)}/records?perPage=500&sort=id`),
  ];
  const out: [string, ScenarioResponse][] = [];
  for (const u of urls) {
    out.push([u, await sendTo(url, request({ name: u, as: "superuser", method: "GET", url: u }))]);
  }
  return out;
}

function bodyText(res: ScenarioResponse): string {
  return new TextDecoder().decode(res.body);
}

// -------------------------------------------------------------------

async function runSession(session: Session): Promise<string[]> {
  const source = fixtureCopy();
  session.prepare?.(source);
  const start = readStartingData(source);
  const upstreamDir = copyOf(source);
  const igloDir = copyOf(source);
  const [upstream, iglo] = await Promise.all([
    track(startUpstream({ dataDir: upstreamDir })),
    track(startServer([], igloDir)),
  ]);

  const differences: string[] = [];
  const pairing = new Pairing();
  for (const c of session.cases) {
    const req = request(c);
    const up = await sendTo(upstream.url, req);
    const ig = await sendTo(iglo.url, req);
    for (const d of compareResponses(up, ig, { start, request: req }, pairing)) {
      differences.push(`${c.name}: ${d}`);
    }
  }

  // the storage cleanup after a delete runs in the background
  await Bun.sleep(300);

  const upState = storedState(upstreamDir);
  const igState = storedState(igloDir);
  for (const key of Object.keys(upState) as (keyof StoredState)[]) {
    const a = JSON.stringify(upState[key], null, 1);
    const b = JSON.stringify(igState[key], null, 1);
    if (a !== b) {
      differences.push(`stored ${key}:\n  upstream  ${a}\n  iglo.base ${b}`);
    }
  }

  await stop(upstream);

  if (session.roundTrip) {
    const written = await readBack(iglo.url, igloDir);
    await stop(iglo);
    const reader = await track(startUpstream({ dataDir: igloDir }));
    const read = await readBack(reader.url, igloDir);
    await stop(reader);
    for (const [i, [u, w]] of written.entries()) {
      const r = read[i]?.[1];
      if (r === undefined || r.status !== w.status || bodyText(r) !== bodyText(w)) {
        differences.push(
          `round trip ${u}:\n  iglo.base ${w.status} ${bodyText(w)}\n  upstream  ${r?.status} ${r === undefined ? "" : bodyText(r)}`,
        );
      }
    }
  } else {
    await stop(iglo);
  }

  return differences;
}

describe("collections API sessions", () => {
  for (const session of sessions) {
    test(
      session.name,
      async () => {
        expect(await runSession(session)).toEqual([]);
      },
      timeout,
    );
  }
});
