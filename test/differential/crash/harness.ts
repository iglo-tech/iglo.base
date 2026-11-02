// Crash and restart harness (M5.9). A server runs on a copy of the fixture, a
// test sends it a SIGKILL at a moment it can see from outside (a file that
// appears, a number of bytes sent, a response received), and `verifyAfterKill`
// then checks what is left: both servers must open it, agree on the records,
// and the data must pass SQLite's integrity check.
// Not part of `bun test`: run `bun run test:reference`.

import { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { expect } from "bun:test";

import { superuserToken } from "@test/scenarios/cron";
import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";
import { startServer, tempDir } from "@test/support/executable";
import { startUpstream } from "@test/support/upstream";
import { testS3Credentials, type Versitygw } from "@test/support/versitygw";

export type Kind = "upstream" | "iglo";

export const asSuperuser = { Authorization: superuserToken };
export const jsonHeaders = { ...asSuperuser, "Content-Type": "application/json" };

export interface Target {
  kind: Kind;
  url: string;
  dataDir: string;
  // SIGKILL; resolves once the process is gone
  kill(): Promise<void>;
  // the normal stop, SIGTERM
  stop(): Promise<void>;
}

export const demo1 = "demo1";

// A copy of the fixture, as <root>/pb_data.
export function freshDataDir(): { root: string; dataDir: string } {
  const root = tempDir();
  const dataDir = join(root, "pb_data");
  copyDataDir(fixtureDir, dataDir);
  return { root, dataDir };
}

export async function launch(kind: Kind, dataDir: string): Promise<Target> {
  if (kind === "upstream") {
    const s = await startUpstream({ dataDir });
    return {
      kind,
      url: s.url,
      dataDir,
      kill: () => s.kill(),
      stop: () => s.stop(),
    };
  }
  const s = await startServer([], dataDir);
  return {
    kind,
    url: s.url,
    dataDir,
    async kill() {
      process.kill(s.pid, "SIGKILL");
      await s.stop();
    },
    async stop() {
      await s.stop();
    },
  };
}

export async function api(
  target: { url: string },
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${target.url}${path}`, {
    method,
    headers: jsonHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function patchSettings(target: { url: string }, body: unknown): Promise<void> {
  const res = await api(target, "PATCH", "/api/settings", body);
  expect(`${res.status} ${await res.text()}`).toStartWith("200");
}

export async function enableBatch(target: { url: string }): Promise<void> {
  await patchSettings(target, { batch: { enabled: true, maxRequests: 5000, timeout: 60 } });
}

export function s3Settings(gw: Versitygw): Record<string, unknown> {
  return {
    enabled: true,
    bucket: gw.bucket,
    region: testS3Credentials.region,
    endpoint: gw.endpoint,
    accessKey: testS3Credentials.accessKeyId,
    secret: testS3Credentials.secretAccessKey,
    forcePathStyle: true,
  };
}

// Polls check() every few milliseconds until it returns a value.
export async function waitFor<T>(
  what: string,
  check: () => T | undefined | false | Promise<T | undefined | false>,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await check();
    if (v !== undefined && v !== false) {
      return v;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await Bun.sleep(2);
  }
}

// The paths (relative to dir) of every file and directory below it.
export function walk(dir: string): string[] {
  const out: string[] = [];
  const visit = (d: string): void => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      out.push(relative(dir, p));
      if (e.isDirectory()) {
        visit(p);
      }
    }
  };
  visit(dir);
  return out.sort();
}

// the first path below dir whose relative name matches
export function find(dir: string, pattern: RegExp): string | undefined {
  return walk(dir).find((p) => pattern.test(p));
}

const fixturePaths = new Set(walk(fixtureDir));
const databaseFile = /^(data|auxiliary)\.db(-wal|-shm)?$/;

// Paths in a pb_data that the fixture does not have, databases aside.
export function extras(dataDir: string): string[] {
  return walk(dataDir).filter((p) => !fixturePaths.has(p) && !databaseFile.test(p));
}

function schemaNames(path: string): string[] {
  const db = new Database(path, { readonly: true });
  try {
    return (
      db.query("SELECT type || ' ' || name AS n FROM sqlite_schema ORDER BY 1").all() as Array<{
        n: string;
      }>
    )
      .map((r) => r.n)
      .filter((n) => !n.includes("sqlite_stat"));
  } finally {
    db.close();
  }
}

// the integrity check and the schema (no table, index or trigger of its own),
// `_params` keys and `_migrations` files, on a copy of the killed data
export function checkDatabases(dataDir: string): void {
  const probe = join(tempDir(), "pb_data");
  cpSync(dataDir, probe, { recursive: true });
  const fixture = join(tempDir(), "pb_data");
  copyDataDir(fixtureDir, fixture);
  for (const name of ["data.db", "auxiliary.db"]) {
    const db = new Database(join(probe, name));
    try {
      expect(db.query("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
    } finally {
      db.close();
    }
    expect(schemaNames(join(probe, name))).toEqual(schemaNames(join(fixture, name)));
  }
  const keys = (path: string): unknown => {
    const db = new Database(path, { readonly: true });
    try {
      return [
        db.query("SELECT id FROM _params ORDER BY 1").all(),
        db.query("SELECT file FROM _migrations ORDER BY 1").all(),
      ];
    } finally {
      db.close();
    }
  };
  expect(keys(join(probe, "data.db"))).toEqual(keys(join(fixture, "data.db")));
}

const fixtureIds = new Set<string>(
  (() => {
    const db = new Database(join(fixtureDir, "data.db"), { readonly: true, safeIntegers: false });
    try {
      return (db.query("SELECT id FROM demo1").all() as Array<{ id: string }>).map((r) => r.id);
    } finally {
      db.close();
    }
  })(),
);

export interface Record_ {
  id: string;
  [key: string]: unknown;
}

export async function listRecords(target: { url: string }, collection = demo1): Promise<Record_[]> {
  const items: Record_[] = [];
  for (let page = 1; ; page++) {
    const res = await api(
      target,
      "GET",
      `/api/collections/${collection}/records?perPage=500&sort=id&page=${page}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Record_[]; totalItems: number };
    items.push(...body.items);
    if (items.length >= body.totalItems) {
      return items;
    }
  }
}

// every file name a record lists can be downloaded, non-empty
export async function checkFiles(
  target: { url: string },
  records: Record_[],
  skipFixture = false,
): Promise<number> {
  const tokenRes = await fetch(`${target.url}/api/files/token`, {
    method: "POST",
    headers: asSuperuser,
  });
  const { token } = (await tokenRes.json()) as { token: string };
  let count = 0;
  for (const r of records) {
    // the fixture's files are on the disk only
    if (skipFixture && fixtureIds.has(r.id)) {
      continue;
    }
    for (const field of ["file_one", "file_many"]) {
      const v = r[field];
      for (const name of Array.isArray(v) ? v : v ? [v] : []) {
        const res = await fetch(
          `${target.url}/api/files/${r["collectionId"]}/${r.id}/${name}?token=${token}`,
        );
        expect(`${r.id}/${name}: ${res.status}`).toBe(`${r.id}/${name}: 200`);
        expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
        count++;
      }
    }
  }
  return count;
}

export interface Outcome {
  records: Record_[];
  files: number;
  // paths present after the start that the fixture does not have
  leftovers: string[];
  // what options.inspect read
  inspected: unknown;
}

// After the kill: checks the databases, then starts iglo.base on the data and
// upstream on a copy taken before that start, and reads the records back from
// both. The two must answer the same. Returns iglo.base's outcome.
export interface VerifyOptions {
  // files are in S3: the files of the fixture's records are not
  skipFixtureFiles?: boolean;
  // more reads on each running server; the two answers must be equal
  inspect?: (target: Target) => Promise<unknown>;
}

export async function verifyAfterKill(
  dataDir: string,
  options: VerifyOptions = {},
): Promise<Outcome> {
  const skipFixtureFiles = options.skipFixtureFiles ?? false;
  checkDatabases(dataDir);
  const copy = join(tempDir(), "pb_data");
  cpSync(dataDir, copy, { recursive: true });

  const iglo = await launch("iglo", dataDir);
  let igloRecords: Record_[];
  let files: number;
  let igloInspected: unknown;
  try {
    igloRecords = await listRecords(iglo);
    igloInspected = await options.inspect?.(iglo);
    files = await checkFiles(iglo, igloRecords, skipFixtureFiles);
  } finally {
    await iglo.stop();
  }

  const upstream = await launch("upstream", copy);
  let upstreamRecords: Record_[];
  let upstreamInspected: unknown;
  try {
    upstreamRecords = await listRecords(upstream);
    upstreamInspected = await options.inspect?.(upstream);
    await checkFiles(upstream, upstreamRecords, skipFixtureFiles);
  } finally {
    await upstream.stop();
  }

  expect(igloRecords).toEqual(upstreamRecords);
  expect(igloInspected).toEqual(upstreamInspected);
  // both are stopped now: the data that either left must be openable again
  checkDatabases(dataDir);
  checkDatabases(copy);

  const leftovers = extras(dataDir);
  return { records: igloRecords, files, leftovers, inspected: igloInspected };
}

// Files below storage/ that no record names.
export function orphans(dataDir: string, records: Record_[]): string[] {
  const named = new Set<string>();
  for (const r of records) {
    for (const field of ["file_one", "file_many"]) {
      const v = r[field];
      for (const name of Array.isArray(v) ? v : v ? [v] : []) {
        named.add(`storage/${r["collectionId"]}/${r.id}/${name}`);
      }
    }
  }
  const fixtureStorage = fixturePaths;
  return walk(dataDir).filter((p) => {
    if (!p.startsWith("storage/") || fixtureStorage.has(p)) {
      return false;
    }
    const full = join(dataDir, p);
    if (statSync(full).isDirectory()) {
      return false;
    }
    return !named.has(p) && !named.has(p.replace(/\.attrs$/, "")) && !/\/thumbs_/.test(p);
  });
}

// the unnamed temp file of a spooled upload, or a started backup or restore
export function tempEntries(dataDir: string): string[] {
  const dir = join(dataDir, ".pb_temp_to_delete");
  return existsSync(dir) ? walk(dir) : [];
}

export function readText(path: string): string {
  return readFileSync(path, "utf8");
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}
