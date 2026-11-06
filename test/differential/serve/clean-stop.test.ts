// Upstream: core/base.go (ResetBootstrapState closes the connections),
// apis/serve.go (the graceful shutdown). After a clean stop (SIGTERM) the
// last connection to each database closes and SQLite removes the -wal and
// -shm files, so the data directory holds the same database files in
// upstream PocketBase v0.41.0 and iglo.base (M5.9 backlog). Not part of
// `bun test`: run `bun run test:reference`.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { startPair, type Pair } from "@test/differential/serve/pair";

let pair: Pair;

beforeAll(async () => {
  pair = await startPair();
});

afterAll(() => {
  rmSync(pair.root, { recursive: true, force: true });
});

// the database files and their companions (upstream also writes types.d.ts)
function databaseFiles(dataDir: string): string[] {
  return readdirSync(dataDir)
    .filter((name) => /\.db($|-)/.test(name))
    .sort();
}

test("a clean stop leaves no -wal or -shm file", async () => {
  // reads (the read pool), a write and a logged request
  for (const server of [pair.upstream, pair.igloBase]) {
    for (let i = 0; i < 4; i++) {
      await fetch(`${server.url}/api/collections/demo1/records`);
    }
    await fetch(`${server.url}/api/collections/demo1/records`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    await fetch(`${server.url}/api/health`);
  }
  await Promise.all([pair.upstream.stop(), pair.igloBase.stop()]);

  const upstream = databaseFiles(join(pair.root, "upstream", "pb_data"));
  const igloBase = databaseFiles(join(pair.root, "iglo-base", "pb_data"));
  expect(upstream).toEqual(["auxiliary.db", "data.db"]);
  expect(igloBase).toEqual(upstream);
}, 60_000);
