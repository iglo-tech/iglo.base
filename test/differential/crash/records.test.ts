// Crash and restart (M5.9): SIGKILL during record writes. A write that was
// answered is there afterwards; a batch is all or nothing; both servers open
// the data. Not part of `bun test`: run `bun run test:reference`.

import { afterAll, describe, expect, test } from "bun:test";
import { rmSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  api,
  demo1,
  enableBatch,
  freshDataDir,
  jsonHeaders,
  launch,
  verifyAfterKill,
  waitFor,
} from "@test/differential/crash/harness";

const timeout = 120_000;
const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fresh(): string {
  const { root, dataDir } = freshDataDir();
  roots.push(root);
  return dataDir;
}

const padding = "x".repeat(1500);

function batchBody(marker: string, count: number): string {
  return JSON.stringify({
    requests: Array.from({ length: count }, (_, i) => ({
      method: "POST",
      url: `/api/collections/${demo1}/records`,
      body: { text: `${marker}:${i}:${padding}`, number: i },
    })),
  });
}

function size(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

describe("crash: record writes", () => {
  test(
    "answered single writes survive a kill amid many in flight",
    async () => {
      const dataDir = fresh();
      const server = await launch("iglo", dataDir);
      const acked: string[] = [];
      let kill: Promise<void> | undefined;
      const sends = Array.from({ length: 400 }, async (_, i) => {
        try {
          const res = await fetch(`${server.url}/api/collections/${demo1}/records`, {
            method: "POST",
            headers: jsonHeaders,
            body: JSON.stringify({ text: `single:${i}`, number: i }),
          });
          if (res.status === 200) {
            acked.push(((await res.json()) as { id: string }).id);
            if (acked.length === 20) {
              kill ??= server.kill();
            }
          }
        } catch {
          // the server is gone
        }
      });
      await Promise.all(sends);
      await kill;
      expect(acked.length).toBeGreaterThanOrEqual(20);

      const outcome = await verifyAfterKill(dataDir);
      const ids = new Set(outcome.records.map((r) => r.id));
      for (const id of acked) {
        expect(ids.has(id)).toBe(true);
      }
      // a write is whole: its two fields belong together
      for (const r of outcome.records) {
        if (typeof r["text"] === "string" && r["text"].startsWith("single:")) {
          expect(r["text"]).toBe(`single:${r["number"]}`);
        }
      }
    },
    timeout,
  );

  for (const [label, rows] of [
    ["a batch of 1500 rows", 1500],
    ["a batch of 3 rows", 3],
  ] as const) {
    test(
      `a kill during ${label} leaves all of it or none`,
      async () => {
        const dataDir = fresh();
        const server = await launch("iglo", dataDir);
        await enableBatch(server);
        // one batch that is answered, then a second that the kill interrupts
        const first = await fetch(`${server.url}/api/batch`, {
          method: "POST",
          headers: jsonHeaders,
          body: batchBody("first", rows),
        });
        expect(first.status).toBe(200);

        const wal = join(dataDir, "data.db-wal");
        const before = size(wal);
        const pending = fetch(`${server.url}/api/batch`, {
          method: "POST",
          headers: jsonHeaders,
          body: batchBody("second", rows),
        }).catch(() => undefined);
        // the write is under way once the log of the database has grown, or
        // the answer is in (a small batch can be done before a poll sees it)
        await waitFor("the write", () => size(wal) !== before || undefined, 10_000).catch(
          () => undefined,
        );
        await server.kill();
        await pending;

        const outcome = await verifyAfterKill(dataDir);
        for (const marker of ["first", "second"]) {
          const n = outcome.records.filter(
            (r) => typeof r["text"] === "string" && r["text"].startsWith(`${marker}:`),
          ).length;
          expect(marker === "first" ? n === rows : n === 0 || n === rows).toBe(true);
        }
      },
      timeout,
    );
  }

  test(
    "a kill between acked batches keeps every acked batch whole",
    async () => {
      const dataDir = fresh();
      const server = await launch("iglo", dataDir);
      await enableBatch(server);
      let acked = 0;
      const rows = 200;
      for (let n = 0; n < 3; n++) {
        const res = await api(server, "POST", "/api/batch", JSON.parse(batchBody(`b${n}`, rows)));
        expect(res.status).toBe(200);
        acked++;
      }
      const inflight = fetch(`${server.url}/api/batch`, {
        method: "POST",
        headers: jsonHeaders,
        body: batchBody("b3", rows),
      }).catch(() => undefined);
      await server.kill();
      await inflight;

      const outcome = await verifyAfterKill(dataDir);
      const count = (m: string): number =>
        outcome.records.filter((r) => String(r["text"]).startsWith(`${m}:`)).length;
      for (let n = 0; n < acked; n++) {
        expect(count(`b${n}`)).toBe(rows);
      }
      expect([0, rows]).toContain(count("b3"));
    },
    timeout,
  );
});
