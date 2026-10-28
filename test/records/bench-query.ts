// Measurements of the record query path for
// docs/perf/M1.8b-record-query.md. Not a test: run
// `bun test/records/bench-query.ts` after `bun run upstream:prepare`.
//
// A fresh upstream install gets a base collection `bench` (title, n,
// active) through POST /api/collections and 10,000 rows through POST
// /api/sql. Upstream's list and view endpoints are timed on it (HTTP
// round trips on 127.0.0.1, as a superuser); then upstream stops, and
// iglo.base's finders are timed in this process on a copy of the same
// pb_data. Each figure is the median of the runs, after one warm-up run.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { reloadCachedCollections } from "@/collections/collection-query";
import { HashExp } from "@/db/dbx/expression";
import { countRecords, findAllRecords, findRecordById } from "@/records/record-query";

import { openDataDir } from "@test/collections/app";
import { runUpstream } from "@test/differential/db/fixture";
import { copyDataDir } from "@test/scenarios/fixture";
import { startUpstream } from "@test/support/upstream";

const email = "bench@example.com";
const password = "1234567890";
const rows = 10_000;
const insertRows = `INSERT INTO bench (id, title, n, active) WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ${rows}) SELECT printf('r%014d', x), 'title ' || x, x % 100, x % 2 FROM c`;

function median(values: number[]): number {
  const s = values.toSorted((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1
    ? (s[mid] as number)
    : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

async function timeAsync(runs: number, fn: () => Promise<void>): Promise<number> {
  await fn(); // warm-up
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    await fn();
    times.push(performance.now() - start);
  }
  return median(times);
}

function timeSync(runs: number, fn: () => void): number {
  fn(); // warm-up
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    fn();
    times.push(performance.now() - start);
  }
  return median(times);
}

const root = mkdtempSync(join(tmpdir(), "iglo-base-bench-query-"));
try {
  const dataDir = join(root, "pb_data");
  const upsert = await runUpstream(
    ["superuser", "upsert", email, password, "--dir", dataDir],
    root,
  );
  if (upsert.exitCode !== 0) {
    throw new Error("superuser upsert failed");
  }

  const upstream = await startUpstream({ dataDir });
  const results: [string, string, number][] = [];
  try {
    const call = async (method: string, path: string, body?: unknown): Promise<string> => {
      const res = await fetch(`${upstream.url}${path}`, {
        method,
        headers: { "content-type": "application/json", authorization: token },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      if (res.status !== 200 && res.status !== 204) {
        throw new Error(`${method} ${path}: ${res.status} ${text}`);
      }
      return text;
    };
    let token = "";
    token = (
      JSON.parse(
        await call("POST", "/api/collections/_superusers/auth-with-password", {
          identity: email,
          password,
        }),
      ) as { token: string }
    ).token;
    await call("POST", "/api/collections", {
      name: "bench",
      type: "base",
      fields: [
        { name: "title", type: "text" },
        { name: "n", type: "number" },
        { name: "active", type: "bool" },
      ],
    });
    await call("POST", "/api/sql", { query: insertRows });

    const id = "r00000000005000";
    results.push([
      "view one record",
      "GET /records/{id}",
      await timeAsync(200, async () => {
        await call("GET", `/api/collections/bench/records/${id}`);
      }),
    ]);
    results.push([
      "all 10,000 records",
      "GET /records, 10 pages of 1,000 (skipTotal)",
      await timeAsync(10, async () => {
        for (let page = 1; page <= 10; page++) {
          await call("GET", `/api/collections/bench/records?perPage=1000&page=${page}&skipTotal=1`);
        }
      }),
    ]);
    results.push([
      "count with active = true",
      "GET /records?filter=active=true&perPage=1 (totalItems)",
      await timeAsync(50, async () => {
        await call("GET", "/api/collections/bench/records?filter=active%3Dtrue&perPage=1");
      }),
    ]);
  } finally {
    await upstream.stop();
  }

  const copy = join(root, "copy");
  copyDataDir(dataDir, copy);
  const app = openDataDir(copy);
  try {
    reloadCachedCollections(app);
    const iglo: number[] = [
      timeSync(200, () => {
        findRecordById(app, "bench", "r00000000005000");
      }),
      timeSync(10, () => {
        if (findAllRecords(app, "bench").length !== rows) {
          throw new Error("unexpected total");
        }
      }),
      timeSync(50, () => {
        countRecords(app, "bench", new HashExp({ active: true }));
      }),
    ];

    console.log("| Operation | iglo.base | upstream (HTTP) | upstream request |");
    console.log("|---|---|---|---|");
    for (const [i, [name, request, ms]] of results.entries()) {
      console.log(
        `| ${name} | ${(iglo[i] as number).toFixed(2)} ms | ${ms.toFixed(2)} ms | ${request} |`,
      );
    }
  } finally {
    app.cleanup();
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
