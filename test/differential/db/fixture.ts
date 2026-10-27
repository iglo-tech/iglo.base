// Helpers for the database tests on upstream's tests/data fixture (from
// the source checkout `bun run upstream:prepare` makes) and the reference
// PocketBase v0.41.0 binary. The fixture itself is never opened: every test
// works on its own copy.

import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spawnChild, waitUntilReady } from "@test/support/child";
import { freePort } from "@test/support/executable";
import { defaultLayout, requireTool } from "@test/support/reference-tools";

export const fixtureDir = join(defaultLayout.sourceDir, "tests", "data");

// superusers, test@example.com (upstream apis/*_test.go)
export const superuserToken =
  "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6InN5d2JoZWNuaDQ2cmhtMCIsInR5cGUiOiJhdXRoIiwiY29sbGVjdGlvbklkIjoicGJjXzMxNDI2MzU4MjMiLCJleHAiOjI1MjQ2MDQ0NjEsInJlZnJlc2hhYmxlIjp0cnVlfQ.UXgO3j-0BumcugrFjbd7j0M4MQvbrLggLlcu_YNGjoY";

// SHA-256 of the fixture's database files, to check they are never written
export function fixtureChecksums(): Record<string, string> {
  const sums: Record<string, string> = {};
  for (const name of ["data.db", "auxiliary.db"]) {
    sums[name] = createHash("sha256")
      .update(readFileSync(join(fixtureDir, name)))
      .digest("hex");
  }
  return sums;
}

export interface FixtureCopy {
  root: string;
  dataDir: string;
  remove(): void;
}

// a copy of tests/data as <root>/pb_data
export function copyFixture(): FixtureCopy {
  requireTool("pocketbase");
  const root = mkdtempSync(join(tmpdir(), "iglo-base-fixture-"));
  const dataDir = join(root, "pb_data");
  cpSync(fixtureDir, dataDir, { recursive: true });
  return { root, dataDir, remove: () => rmSync(root, { recursive: true, force: true }) };
}

export interface UpstreamRun {
  exitCode: number;
  output: string;
}

// runs the reference binary with the given arguments in cwd
export async function runUpstream(args: string[], cwd: string): Promise<UpstreamRun> {
  const proc = Bun.spawn([requireTool("pocketbase"), ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, output: stdout + stderr };
}

export interface UpstreamServer {
  url: string;
  stop(): Promise<void>;
}

// starts the reference binary's serve on an existing pb_data directory
export async function serveUpstream(copy: FixtureCopy): Promise<UpstreamServer> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawnChild(
    [requireTool("pocketbase"), "serve", "--http", `127.0.0.1:${port}`, "--dir", copy.dataDir],
    { cwd: copy.root },
  );
  try {
    await waitUntilReady(child, "upstream pocketbase", async () => {
      const res = await fetch(`${url}/api/health`);
      return res.ok;
    });
  } catch (error) {
    await child.stop();
    throw error;
  }
  return { url, stop: () => child.stop() };
}

// runs a query through upstream's superuser SQL API (apis/sql.go) and
// returns its rows (values as text)
export async function upstreamSQL(server: UpstreamServer, query: string): Promise<unknown[][]> {
  const res = await fetch(`${server.url}/api/sql`, {
    method: "POST",
    headers: { Authorization: superuserToken, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const body = (await res.json()) as { rows?: unknown[][] };
  if (res.status !== 200 || !body.rows) {
    throw new Error(`POST /api/sql ${query}: ${res.status} ${JSON.stringify(body)}`);
  }
  return body.rows;
}
