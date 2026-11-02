// Upstream: apis/middlewares.go (activityLogger), core/log_model.go,
// tools/logger, apis/logs.go. The same requests against upstream PocketBase
// v0.41.0 and iglo.base: the `_logs` rows, as stored text, and each server
// reading the rows the other wrote. Not part of `bun test`: run
// `bun run test:reference`.

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { eventually, superuserToken } from "@test/scenarios/cron";
import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";
import { setLogsSettings } from "@test/scenarios/logs";
import { startServer, tempDir } from "@test/support/executable";
import { startUpstream } from "@test/support/upstream";

const timeout = 60_000;

const userToken =
  "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6IjRxMXhsY2xtZmxva3UzMyIsInR5cGUiOiJhdXRoIiwiY29sbGVjdGlvbklkIjoiX3BiX3VzZXJzX2F1dGhfIiwiZXhwIjoyNTI0NjA0NDYxLCJyZWZyZXNoYWJsZSI6dHJ1ZX0.ZT3F0Z3iM-xbGgSG3LEKiEzHrPHr8t8IuHLZGGNuxLo";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

interface Row {
  level: number;
  message: string;
  data: string;
  created: string;
}

interface Request {
  method?: string;
  path: string;
  token?: string;
  headers?: Record<string, string>;
  body?: string;
}

const json = { "content-type": "application/json" };

const requests: Request[] = [
  // successes
  { path: "/api/health?a=1" },
  { path: "/api/health?a=%20b&c=d+e", headers: { Referer: "http://example.com/x" } },
  { path: "/api/collections?perPage=1", token: superuserToken },
  { path: "/api/collections/demo1/records?perPage=1", token: userToken },
  { path: "/api/collections/demo1/records?perPage=1" },
  { path: "/api/settings", token: superuserToken },
  // skipped on success
  { path: "/api/logs", token: superuserToken },
  { path: "/api/logs/stats", token: superuserToken },
  { path: "/api/realtime?nope=1&timeout=0", method: "HEAD" },
  { path: "/api/oauth2-redirect?state=missing&code=secret" },
  // failures
  { path: "/api/logs" },
  { path: "/api/logs", token: userToken },
  { path: "/api/logs/stats?filter=(", token: superuserToken },
  { path: "/api/logs/nope", token: superuserToken },
  { path: "/api/collections" },
  { path: "/api/collections", token: userToken },
  { path: "/api/collections/nope/records" },
  { path: "/api/collections/demo1/records/nope", token: userToken },
  { path: "/api/files/nope/nope/nope.txt" },
  { path: "/missing/x%20y?a=%zz", headers: { "User-Agent": "client/1.0" } },
  {
    method: "POST",
    path: "/api/collections",
    token: superuserToken,
    headers: json,
    body: JSON.stringify({
      name: "x y",
      type: "base",
      fields: [
        { name: "a b", type: "text" },
        { name: "c", type: "text", min: -1 },
      ],
    }),
  },
  {
    method: "POST",
    path: "/api/collections/users/records",
    headers: json,
    body: JSON.stringify({ email: "bad", password: "1", passwordConfirm: "2" }),
  },
  {
    method: "POST",
    path: "/api/collections/users/auth-with-password",
    headers: json,
    body: JSON.stringify({ identity: "test@example.com", password: "wrong" }),
  },
  {
    method: "POST",
    path: "/api/collections/users/auth-with-password",
    headers: json,
    body: JSON.stringify({ identity: "test@example.com", password: "1234567890" }),
  },
  { method: "DELETE", path: "/api/collections/demo1/records/nope", token: superuserToken },
  { method: "POST", path: "/api/batch", token: superuserToken, headers: json, body: "{}" },
  { path: `/api/health?long=${"x".repeat(4000)}`, headers: { Referer: "r".repeat(3000) } },
];

async function send(url: string, r: Request): Promise<void> {
  const res = await fetch(url + r.path, {
    method: r.method ?? "GET",
    redirect: "manual",
    headers: { ...r.headers, ...(r.token ? { Authorization: r.token } : {}) },
    body: r.body,
  });
  await res.arrayBuffer();
}

function readRows(dataDir: string): Row[] {
  const db = new Database(join(dataDir, "auxiliary.db"), { readonly: true });
  try {
    return db
      .query("SELECT level, message, data, created FROM _logs WHERE message != 'fixture'")
      .all() as Row[];
  } finally {
    db.close();
  }
}

// the time and id of a row differ; everything else is compared as stored
function normalized(rows: Row[]): string[] {
  return rows
    .filter((row) => row.message !== "GET /api/health") // the harness's ready checks
    .map((row) => {
      expect(row.created).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(row.data).toMatch(/"execTime":\d+(\.\d+)?(e-?\d+)?,/);
      const data = row.data.replace(/"execTime":[^,]+,/, '"execTime":0,');
      return `${row.level} ${row.message} ${data}`;
    })
    .toSorted();
}

function fixtureCopy(logs: Record<string, unknown>): string {
  const root = tempDir();
  roots.push(root);
  const dataDir = join(root, "pb_data");
  copyDataDir(fixtureDir, dataDir);
  setLogsSettings(dataDir, logs);
  // the fixture's old row is cleared by the first start
  const db = new Database(join(dataDir, "auxiliary.db"));
  db.run("DELETE FROM _logs");
  db.close();
  return dataDir;
}

async function logsBody(url: string): Promise<string> {
  const res = await fetch(`${url}/api/logs?perPage=500&sort=created,message`, {
    headers: { Authorization: superuserToken },
  });
  expect(res.status).toBe(200);
  return res.text();
}

const settings = [
  { name: "logIP and logAuthId", logs: { maxDays: 7, logIP: true, logAuthId: true, minLevel: 0 } },
  { name: "neither", logs: { maxDays: 7, logIP: false, logAuthId: false, minLevel: 0 } },
  { name: "warnings and up", logs: { maxDays: 7, logIP: true, logAuthId: false, minLevel: 4 } },
];

describe("request logs", () => {
  for (const { name, logs } of settings) {
    test(
      `the same rows as upstream (${name})`,
      async () => {
        const upstreamDir = fixtureCopy(logs);
        const igloBaseDir = fixtureCopy(logs);

        const upstream = await startUpstream({ dataDir: upstreamDir });
        for (const r of requests) {
          await send(upstream.url, r);
        }
        await upstream.stop();

        const igloBase = await startServer([], igloBaseDir);
        for (const r of requests) {
          await send(igloBase.url, r);
        }
        await igloBase.stop();

        const expected = normalized(readRows(upstreamDir));
        expect(expected.length).toBeGreaterThan(0);
        expect(normalized(readRows(igloBaseDir))).toEqual(expected);
      },
      timeout,
    );
  }

  test(
    "each server reads the rows the other wrote",
    async () => {
      const logs = settings[0]!.logs;
      const upstreamDir = fixtureCopy(logs);
      const igloBaseDir = fixtureCopy(logs);

      for (const start of [
        () => startUpstream({ dataDir: upstreamDir }),
        () => startServer([], igloBaseDir),
      ]) {
        const server = await start();
        for (const r of requests.slice(0, 12)) {
          await send(server.url, r);
        }
        await server.stop();
      }

      // the rows of dataDir in a new pb_data: a reader's own logs go to its copy
      const copyOf = (dataDir: string): string => {
        const other = fixtureCopy(logs);
        const db = new Database(join(dataDir, "auxiliary.db"));
        for (const suffix of ["", "-wal", "-shm"]) {
          rmSync(join(other, `auxiliary.db${suffix}`), { force: true });
        }
        db.run(`VACUUM INTO '${join(other, "auxiliary.db")}'`);
        db.close();
        return other;
      };

      const swapped = async (dataDir: string): Promise<[string, string]> => {
        const reader1 = await startUpstream({ dataDir: copyOf(dataDir) });
        const first = await logsBody(reader1.url);
        await reader1.stop();
        const reader2 = await startServer([], copyOf(dataDir));
        const second = await logsBody(reader2.url);
        await reader2.stop();
        return [first, second];
      };

      for (const dataDir of [upstreamDir, igloBaseDir]) {
        const [byUpstream, byIgloBase] = await swapped(dataDir);
        expect(byIgloBase).toBe(byUpstream);
        expect((JSON.parse(byUpstream) as { totalItems: number }).totalItems).toBeGreaterThan(0);
      }
    },
    timeout,
  );

  test(
    "a quiet server writes the queue on its tick, and stats and filters agree",
    async () => {
      const logs = settings[0]!.logs;
      const servers = [
        await startUpstream({ dataDir: fixtureCopy(logs) }),
        await startServer([], fixtureCopy(logs)),
      ];
      const stats: string[] = [];
      for (const server of servers) {
        await send(server.url, { path: "/api/logs/nope", token: superuserToken });
        expect(
          await eventually(async () => {
            const res = await fetch(`${server.url}/api/logs?filter=data.status=404`, {
              headers: { Authorization: superuserToken },
            });
            return ((await res.json()) as { totalItems: number }).totalItems === 1;
          }),
        ).toBe(true);
        const res = await fetch(`${server.url}/api/logs/stats?filter=data.status>=400`, {
          headers: { Authorization: superuserToken },
        });
        stats.push(((await res.json()) as { total: number }[]).map((s) => s.total).join());
        await server.stop();
      }
      expect(stats[1]).toBe(stats[0]!);
    },
    timeout,
  );

  test(
    "logs.maxDays 0 writes nothing on either server",
    async () => {
      const logs = { maxDays: 0, logIP: true, logAuthId: false, minLevel: 0 };
      for (const start of [
        (dataDir: string) => startUpstream({ dataDir }),
        (dataDir: string) => startServer([], dataDir),
      ]) {
        const dataDir = fixtureCopy(logs);
        const server = await start(dataDir);
        await send(server.url, { path: "/api/health" });
        await send(server.url, { path: "/api/logs/nope", token: superuserToken });
        await server.stop();
        expect(readRows(dataDir)).toEqual([]);
      }
    },
    timeout,
  );
});
