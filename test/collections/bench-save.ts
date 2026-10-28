// Measurements of the collection save path for
// docs/perf/M1.7-collection-save.md. Not a test: run
// `bun test/collections/bench-save.ts [--dir <scratch dir>]` after
// `bun run upstream:prepare`, on Linux (upstream's peak memory is read
// from /proc).
//
// Each scenario runs on its own fresh upstream install (`superuser
// upsert`), copied for both sides:
//
//   - iglo.base: a child bun process (this file with --side iglo) runs the
//     scenario through saveCollection and reports the times and its peak
//     RSS (process.resourceUsage().maxRSS) after setup and at the end;
//   - upstream: a new `serve` on the copy, the same scenario through its
//     /api/collections endpoints (rows through POST /api/sql), and the
//     server's VmHWM (peak RSS) from /proc after setup and at the end.
//
// Upstream's times include the HTTP round trip on 127.0.0.1.
//
// Scenarios (median of the repetitions):
//   - fields50: create a base collection with 50 fields (5 runs, each a
//     new collection);
//   - multiple: a select field on a 100,000-row table changed from single
//     to multiple and back (3 runs each way, both directions reported);
//   - view: a view over that table resaved with a changed query (5 runs).

import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { newCollection, type Collection } from "@/collections/collection-model";
import { findCollectionByNameOrId, reloadCachedCollections } from "@/collections/collection-query";
import { saveCollection } from "@/collections/collection-save";
import { decodeString, unmarshalGoStruct } from "@/collections/go-json-struct";

import { openDataDir } from "@test/collections/app";
import { runUpstream } from "@test/differential/db/fixture";
import { startUpstream } from "@test/support/upstream";

const { values } = parseArgs({
  options: {
    dir: { type: "string" },
    side: { type: "string" },
    data: { type: "string" },
    scenario: { type: "string" },
  },
  strict: true,
});

type Scenario = "fields50" | "multiple" | "view";
const scenarios: Scenario[] = ["fields50", "multiple", "view"];

const email = "bench@example.com";
const password = "1234567890";

const rows = 100_000;
const insertRows = `INSERT INTO big (id, tag) WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ${rows}) SELECT printf('r%014d', x), 'a' FROM c`;

const fieldTypes = [
  "text",
  "number",
  "bool",
  "email",
  "url",
  "date",
  "select",
  "json",
  "editor",
  "file",
];

function fields50Body(i: number): Record<string, unknown> {
  const fields = [];
  for (let f = 0; f < 50; f++) {
    const type = fieldTypes[f % fieldTypes.length]!;
    const field: Record<string, unknown> = { name: `f${f}_${type}`, type };
    if (type === "select") {
      field.values = ["a", "b"];
    }
    fields.push(field);
  }
  return { name: `wide${i}`, type: "base", fields };
}

const bigBody = {
  name: "big",
  type: "base",
  fields: [{ name: "tag", type: "select", values: ["a", "b", "c"], maxSelect: 1 }],
};

function viewQuery(i: number): string {
  return `select id, tag, ${i} as n from big`;
}

function median(xs: number[]): number {
  const sorted = xs.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

interface Result {
  times: Record<string, number>;
  setupPeakKiB: number;
  peakKiB: number;
}

// ---------------------------------------------------------------------
// iglo.base (child process)

// apis/collection.go collectionCreate / collectionUpdate
function create(body: Record<string, unknown>): Collection {
  const raw = JSON.stringify(body);
  const extract = { type: "", name: "" };
  unmarshalGoStruct(
    raw,
    {
      type: (v) => (extract.type = decodeString(v)),
      name: (v) => (extract.name = decodeString(v)),
    },
    () => {},
  );
  const c = newCollection(extract.type, extract.name);
  c.unmarshalJSON(raw);
  return c;
}

function timed(fn: () => void): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

function igloScenario(dataDir: string, scenario: Scenario): Result {
  const app = openDataDir(dataDir);
  reloadCachedCollections(app);

  const update = (target: string, body: Record<string, unknown>): Collection => {
    const c = findCollectionByNameOrId(app, target);
    c.unmarshalJSON(JSON.stringify(body));
    return c;
  };
  const times: Record<string, number> = {};
  let setupPeakKiB = 0;
  try {
    switch (scenario) {
      case "fields50": {
        setupPeakKiB = process.resourceUsage().maxRSS;
        const runs: number[] = [];
        for (let i = 0; i < 5; i++) {
          const c = create(fields50Body(i));
          runs.push(timed(() => saveCollection(app, c)));
        }
        times.fields50 = median(runs);
        break;
      }
      case "multiple": {
        saveCollection(app, create(bigBody));
        app.databases.nonconcurrentDB().newQuery(insertRows).execute();
        setupPeakKiB = process.resourceUsage().maxRSS;
        const toMultiple: number[] = [];
        const toSingle: number[] = [];
        for (let i = 0; i < 3; i++) {
          for (const [maxSelect, list] of [
            [3, toMultiple],
            [1, toSingle],
          ] as const) {
            const fields = JSON.parse(
              findCollectionByNameOrId(app, "big").fields.marshalJSON(),
            ) as {
              name: string;
              maxSelect?: number;
            }[];
            fields.find((f) => f.name === "tag")!.maxSelect = maxSelect;
            const c = update("big", { fields });
            list.push(timed(() => saveCollection(app, c)));
          }
        }
        times.singleToMultiple = median(toMultiple);
        times.multipleToSingle = median(toSingle);
        break;
      }
      case "view": {
        saveCollection(app, create(bigBody));
        app.databases.nonconcurrentDB().newQuery(insertRows).execute();
        saveCollection(app, create({ name: "big_view", type: "view", viewQuery: viewQuery(0) }));
        setupPeakKiB = process.resourceUsage().maxRSS;
        const runs: number[] = [];
        for (let i = 1; i <= 5; i++) {
          const c = update("big_view", { viewQuery: viewQuery(i) });
          runs.push(timed(() => saveCollection(app, c)));
        }
        times.viewResave = median(runs);
        break;
      }
    }
  } finally {
    app.cleanup();
  }

  return { times, setupPeakKiB, peakKiB: process.resourceUsage().maxRSS };
}

// ---------------------------------------------------------------------
// upstream

function vmHWM(pid: number): number {
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  const m = /VmHWM:\s+(\d+) kB/.exec(status);
  return m === null ? 0 : Number(m[1]);
}

function serverPid(dataDir: string): number {
  const out = Bun.spawnSync(["pgrep", "-f", "--", `serve .* --dir ${dataDir}`])
    .stdout.toString()
    .trim();
  const pid = Number(out.split("\n")[0]);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`no upstream process for ${dataDir}`);
  }
  return pid;
}

async function upstreamScenario(dataDir: string, scenario: Scenario): Promise<Result> {
  const server = await startUpstream({ dataDir });
  try {
    const pid = serverPid(dataDir);
    const auth = await fetch(`${server.url}/api/collections/_superusers/auth-with-password`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity: email, password }),
    });
    const token = ((await auth.json()) as { token: string }).token;
    const call = async (method: string, path: string, body: unknown): Promise<number> => {
      const start = performance.now();
      const res = await fetch(`${server.url}${path}`, {
        method,
        headers: { "content-type": "application/json", authorization: token },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      const ms = performance.now() - start;
      if (res.status >= 300) {
        throw new Error(`${method} ${path}: ${res.status} ${text}`);
      }
      return ms;
    };
    const fieldsOf = async (name: string) => {
      const res = await fetch(`${server.url}/api/collections/${name}`, {
        headers: { authorization: token },
      });
      return ((await res.json()) as { fields: { name: string; maxSelect?: number }[] }).fields;
    };

    const times: Record<string, number> = {};
    let setupPeakKiB = 0;
    switch (scenario) {
      case "fields50": {
        setupPeakKiB = vmHWM(pid);
        const runs: number[] = [];
        for (let i = 0; i < 5; i++) {
          runs.push(await call("POST", "/api/collections", fields50Body(i)));
        }
        times.fields50 = median(runs);
        break;
      }
      case "multiple": {
        await call("POST", "/api/collections", bigBody);
        await call("POST", "/api/sql", { query: insertRows });
        setupPeakKiB = vmHWM(pid);
        const toMultiple: number[] = [];
        const toSingle: number[] = [];
        for (let i = 0; i < 3; i++) {
          for (const [maxSelect, list] of [
            [3, toMultiple],
            [1, toSingle],
          ] as const) {
            const fields = await fieldsOf("big");
            fields.find((f) => f.name === "tag")!.maxSelect = maxSelect;
            list.push(await call("PATCH", "/api/collections/big", { fields }));
          }
        }
        times.singleToMultiple = median(toMultiple);
        times.multipleToSingle = median(toSingle);
        break;
      }
      case "view": {
        await call("POST", "/api/collections", bigBody);
        await call("POST", "/api/sql", { query: insertRows });
        await call("POST", "/api/collections", {
          name: "big_view",
          type: "view",
          viewQuery: viewQuery(0),
        });
        setupPeakKiB = vmHWM(pid);
        const runs: number[] = [];
        for (let i = 1; i <= 5; i++) {
          runs.push(await call("PATCH", "/api/collections/big_view", { viewQuery: viewQuery(i) }));
        }
        times.viewResave = median(runs);
        break;
      }
    }
    return { times, setupPeakKiB, peakKiB: vmHWM(pid) };
  } finally {
    await server.stop();
  }
}

// ---------------------------------------------------------------------

if (values.side === "iglo") {
  const result = igloScenario(values.data!, values.scenario as Scenario);
  console.log(JSON.stringify(result));
} else {
  const scratch = values.dir ?? tmpdir();
  const report: Record<string, { iglo: Result; upstream: Result }> = {};
  for (const scenario of scenarios) {
    const root = mkdtempSync(join(scratch, "iglo-base-bench-save-"));
    try {
      const base = join(root, "base", "pb_data");
      const upsert = await runUpstream(
        ["superuser", "upsert", email, password, "--dir", base],
        root,
      );
      if (upsert.exitCode !== 0) {
        throw new Error(upsert.output);
      }
      const igloDir = join(root, "iglo", "pb_data");
      const upstreamDir = join(root, "upstream", "pb_data");
      cpSync(base, igloDir, { recursive: true });
      cpSync(base, upstreamDir, { recursive: true });

      const child = Bun.spawnSync(
        [
          process.execPath,
          import.meta.path,
          "--side",
          "iglo",
          "--data",
          igloDir,
          "--scenario",
          scenario,
        ],
        { stdout: "pipe", stderr: "inherit" },
      );
      if (child.exitCode !== 0) {
        throw new Error(`iglo.base ${scenario} failed`);
      }
      const iglo = JSON.parse(child.stdout.toString()) as Result;
      const upstream = await upstreamScenario(upstreamDir, scenario);
      report[scenario] = { iglo, upstream };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  console.log(JSON.stringify(report, null, 2));
}
