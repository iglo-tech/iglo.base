// Upstream: apis/cron.go, tools/cron/cron.go. `GET /api/crons` byte for byte
// against upstream PocketBase v0.41.0: on a fresh install, on the fixture,
// after a rate limit rule creates and removes `__pbRateLimitersCleanup__`;
// and what the jobs do to rows and WAL files written while the servers run.
// Not part of `bun test`: run `bun run test:reference`.

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { eventually, superuserToken } from "@test/scenarios/cron";
import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";
import { run, startServer, tempDir } from "@test/support/executable";
import { defaultLayout, requireTool } from "@test/support/reference-tools";
import { startUpstream } from "@test/support/upstream";

const timeout = 60_000;

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

interface Server {
  name: string;
  url: string;
  dataDir: string;
  token: string;
}

// the fixture or a new pb_data on both servers
async function withServers(
  { fresh }: { fresh: boolean },
  body: (servers: [Server, Server]) => Promise<void>,
): Promise<void> {
  const root = tempDir();
  roots.push(root);
  const upstreamDir = join(root, "upstream", "pb_data");
  const igloBaseDir = join(root, "iglo-base", "pb_data");
  const email = "cron@example.com";
  const password = "1234567890";

  if (fresh) {
    const upserted = Bun.spawnSync([
      requireTool("pocketbase", defaultLayout),
      "superuser",
      "upsert",
      email,
      password,
      "--dir",
      upstreamDir,
    ]);
    expect(upserted.exitCode).toBe(0);
    const result = await run(["superuser", "upsert", email, password, "--dir", igloBaseDir]);
    expect(result.exitCode).toBe(0);
  } else {
    copyDataDir(fixtureDir, upstreamDir);
    copyDataDir(fixtureDir, igloBaseDir);
  }

  const upstream = await startUpstream({ dataDir: upstreamDir });
  try {
    const igloBase = await startServer([], igloBaseDir);
    try {
      const token = async (url: string): Promise<string> => {
        if (!fresh) {
          return superuserToken;
        }
        const res = await fetch(`${url}/api/collections/_superusers/auth-with-password`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identity: email, password }),
        });
        return ((await res.json()) as { token: string }).token;
      };
      await body([
        {
          name: "upstream",
          url: upstream.url,
          dataDir: upstreamDir,
          token: await token(upstream.url),
        },
        {
          name: "iglo.base",
          url: igloBase.url,
          dataDir: igloBaseDir,
          token: await token(igloBase.url),
        },
      ]);
    } finally {
      await igloBase.stop();
    }
  } finally {
    await upstream.stop();
  }
}

async function list(server: Server): Promise<{ status: number; type: string; bytes: string }> {
  const res = await fetch(`${server.url}/api/crons`, {
    headers: { Authorization: server.token },
  });
  return {
    status: res.status,
    type: res.headers.get("Content-Type") ?? "",
    bytes: await res.text(),
  };
}

async function expectSameList(servers: [Server, Server], ids: string[]): Promise<void> {
  const [upstream, igloBase] = await Promise.all(servers.map(list));
  expect(igloBase).toEqual(upstream!);
  const jobs = JSON.parse(upstream!.bytes) as { id: string }[];
  expect(jobs.map((j) => j.id)).toEqual(ids);
}

function patchSettings(server: Server, settings: unknown): Promise<Response> {
  return fetch(`${server.url}/api/settings`, {
    method: "PATCH",
    headers: { Authorization: server.token, "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
}

function runJob(server: Server, id: string): Promise<Response> {
  return fetch(`${server.url}/api/crons/${id}`, {
    method: "POST",
    headers: { Authorization: server.token },
  });
}

const builtIns = ["__pbDBOptimize__", "__pbMFACleanup__", "__pbOTPCleanup__", "__pbLogsCleanup__"];

describe("GET /api/crons", () => {
  test(
    "a fresh server",
    () => withServers({ fresh: true }, (servers) => expectSameList(servers, builtIns)),
    timeout,
  );

  test(
    "the fixture",
    () => withServers({ fresh: false }, (servers) => expectSameList(servers, builtIns)),
    timeout,
  );

  test(
    "the rate limiters job after a rule's first request, until the next settings save",
    () =>
      withServers({ fresh: true }, async (servers) => {
        const rateLimits = {
          enabled: true,
          rules: [{ label: "/api/health", maxRequests: 100, duration: 60 }],
        };
        for (const server of servers) {
          expect((await patchSettings(server, { rateLimits })).status).toBe(200);
        }
        await expectSameList(servers, builtIns);

        for (const server of servers) {
          expect((await fetch(`${server.url}/api/health`)).status).toBe(200);
        }
        await expectSameList(servers, [...builtIns, "__pbRateLimitersCleanup__"]);

        for (const server of servers) {
          expect((await runJob(server, "__pbRateLimitersCleanup__")).status).toBe(204);
        }

        for (const server of servers) {
          expect((await patchSettings(server, { rateLimits })).status).toBe(200);
        }
        await expectSameList(servers, builtIns);
      }),
    timeout,
  );
});

describe("POST /api/crons/{id}", () => {
  const dayMs = 86_400_000;

  function writeLogs(server: Server, rows: Record<string, Date>): void {
    const db = new Database(join(server.dataDir, "auxiliary.db"));
    db.run("PRAGMA busy_timeout(10000)");
    for (const [id, created] of Object.entries(rows)) {
      db.query("INSERT INTO _logs (id, created) VALUES (?, ?)").run(
        id,
        created.toISOString().replace("T", " "),
      );
    }
    db.close();
  }

  function logIds(server: Server, ids: string[]): string[] {
    const db = new Database(join(server.dataDir, "auxiliary.db"), { readonly: true });
    const rows = db
      .query(`SELECT id FROM _logs WHERE id IN (${ids.map(() => "?").join()}) ORDER BY id`)
      .all(...ids) as { id: string }[];
    db.close();
    return rows.map((r) => r.id);
  }

  test(
    "__pbLogsCleanup__ deletes the logs past logs.maxDays, and every log with 0",
    () =>
      withServers({ fresh: false }, async (servers) => {
        for (const server of servers) {
          // written after the save: upstream's reload clears old logs itself
          expect((await patchSettings(server, { logs: { maxDays: 7 } })).status).toBe(200);
          const now = Date.now();
          writeLogs(server, {
            aged00000000000: new Date(now - 8 * dayMs),
            recent000000000: new Date(now - 6 * dayMs),
          });

          expect((await runJob(server, "__pbLogsCleanup__")).status).toBe(204);
          expect(await eventually(() => !logIds(server, ["aged00000000000"]).length)).toBe(true);
          expect(logIds(server, ["aged00000000000", "recent000000000"])).toEqual([
            "recent000000000",
          ]);

          expect((await patchSettings(server, { logs: { maxDays: 0 } })).status).toBe(200);
          writeLogs(server, { minute000000000: new Date(now - 60_000) });
          expect((await runJob(server, "__pbLogsCleanup__")).status).toBe(204);
          expect(await eventually(() => !logIds(server, ["minute000000000"]).length)).toBe(true);
        }
      }),
    timeout,
  );

  test(
    "__pbDBOptimize__ truncates the data.db WAL",
    () =>
      withServers({ fresh: false }, async (servers) => {
        for (const server of servers) {
          expect((await patchSettings(server, { meta: { appName: "cron" } })).status).toBe(200);
          const wal = join(server.dataDir, "data.db-wal");
          expect(statSync(wal).size).toBeGreaterThan(0);

          expect((await runJob(server, "__pbDBOptimize__")).status).toBe(204);
          expect(await eventually(() => statSync(wal).size === 0)).toBe(true);
        }
      }),
    timeout,
  );
});
