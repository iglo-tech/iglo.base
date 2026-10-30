// M3.3: POST /api/batch over HTTP, iglo.base against upstream PocketBase
// v0.41.0 on the same data. Not shipped; needs `bun run upstream:prepare`.
//
//   nice -n 10 bun test/perf/batch/bench.ts [--batches 100] [--items 50] [--concurrency 1]
//
// A fresh install built through upstream's API, with `notes` (empty create,
// update and delete rules) and `notes_rel` (a rule with a relation join on the
// create, update and delete), as test/perf/records-write/bench.ts builds them.
// Upstream and the iglo.base executable serve copies of it, one at a time,
// and each collection gets --batches batches of --items creates (after 10
// warm-up batches), then of updates of those records, then of their deletes.
// Prints batches/s, items/s, the p50/p99 latency of a batch per workload and
// the server's peak RSS. Stops below 1.5 GiB of MemAvailable.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { runUpstream } from "@test/differential/db/fixture";
import { copyDataDir } from "@test/scenarios/fixture";
import { startServer } from "@test/support/executable";
import { startUpstream } from "@test/support/upstream";

const { values } = parseArgs({
  options: {
    batches: { type: "string", default: "100" },
    items: { type: "string", default: "50" },
    concurrency: { type: "string", default: "1" },
  },
});
const batches = Number(values.batches);
const items = Number(values.items);
const concurrency = Number(values.concurrency);
const password = "1234567890";

function id(prefix: string, n: number): string {
  return prefix + String(n).padStart(14, "0");
}

function memAvailableMiB(): number {
  const m = /MemAvailable:\s+(\d+) kB/.exec(readFileSync("/proc/meminfo", "utf8"));
  return Number(m?.[1] ?? 0) / 1024;
}

async function build(dataDir: string, root: string): Promise<void> {
  const upsert = await runUpstream(
    ["superuser", "upsert", "bench@example.com", password, "--dir", dataDir],
    root,
  );
  if (upsert.exitCode !== 0) {
    throw new Error(upsert.output);
  }
  const server = await startUpstream({ dataDir });
  try {
    let token = "";
    const api = async (method: string, path: string, body?: unknown): Promise<unknown> => {
      const res = await fetch(`${server.url}${path}`, {
        method,
        headers: { "content-type": "application/json", ...(token ? { authorization: token } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`${method} ${path}: ${res.status} ${text}`);
      }
      return text === "" ? null : JSON.parse(text);
    };
    token = (
      (await api("POST", "/api/collections/_superusers/auth-with-password", {
        identity: "bench@example.com",
        password,
      })) as { token: string }
    ).token;
    await api("PATCH", "/api/settings", {
      batch: { enabled: true, maxRequests: items, timeout: 30 },
    });

    const teams = (await api("POST", "/api/collections", {
      name: "teams",
      listRule: "",
      viewRule: "",
      fields: [{ name: "name", type: "text" }],
    })) as { id: string };
    for (const [name, rule] of [
      ["notes", ""],
      ["notes_rel", `team.name != "Team 3"`],
    ] as const) {
      await api("POST", "/api/collections", {
        name,
        listRule: "",
        viewRule: "",
        createRule: rule,
        updateRule: rule,
        deleteRule: rule,
        fields: [
          { name: "title", type: "text" },
          { name: "views", type: "number" },
          { name: "team", type: "relation", collectionId: teams.id, maxSelect: 1 },
          { name: "created", type: "autodate", onCreate: true },
          { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
        ],
      });
    }
    for (let t = 0; t < 10; t++) {
      await api("POST", "/api/collections/teams/records", { id: id("t", t), name: `Team ${t}` });
    }
  } finally {
    await server.stop();
  }
}

interface Stats {
  batchesPerSecond: number;
  p50: number;
  p99: number;
}

async function run(
  baseUrl: string,
  from: number,
  n: number,
  request: (item: number) => object,
): Promise<Stats> {
  const latencies: number[] = [];
  let next = from;
  const end = from + n;
  const started = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < end) {
        const batch = next++;
        const requests = Array.from({ length: items }, (_, i) => request(batch * items + i));
        const body = JSON.stringify({ requests });
        const t0 = performance.now();
        const res = await fetch(baseUrl + "/api/batch", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        });
        const text = await res.text();
        if (res.status !== 200) {
          throw new Error(`batch: ${res.status} ${text.slice(0, 500)}`);
        }
        latencies.push(performance.now() - t0);
      }
    }),
  );
  const elapsed = (performance.now() - started) / 1000;
  latencies.sort((a, b) => a - b);
  const at = (q: number): number =>
    latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))] as number;
  return { batchesPerSecond: n / elapsed, p50: at(0.5), p99: at(0.99) };
}

const root = mkdtempSync(join(tmpdir(), "iglo-base-batch-bench-"));
try {
  const dataDir = join(root, "pb_data");
  await build(dataDir, root);

  const lines: string[] = [];
  for (const target of ["upstream", "iglo.base"] as const) {
    if (memAvailableMiB() < 1536) {
      throw new Error("MemAvailable below 1.5 GiB");
    }
    const copy = join(root, target, "pb_data");
    copyDataDir(dataDir, copy);
    const server =
      target === "upstream" ? await startUpstream({ dataDir: copy }) : await startServer([], copy);
    try {
      for (const collection of ["notes", "notes_rel"]) {
        const base = `/api/collections/${collection}/records`;
        const team = (i: number): string => id("t", i % 10 === 3 ? 4 : i % 10);
        const create = (i: number): object => ({
          method: "POST",
          url: base,
          body: { id: id("n", i), title: `Note ${i}`, views: i, team: team(i) },
        });
        await run(server.url, batches + 1, 10, create);
        const workloads: [string, (i: number) => object][] = [
          ["create", create],
          [
            "update",
            (i) => ({
              method: "PATCH",
              url: `${base}/${id("n", i)}`,
              body: { title: `Updated ${i}`, "views+": 1 },
            }),
          ],
          ["delete", (i) => ({ method: "DELETE", url: `${base}/${id("n", i)}` })],
        ];
        for (const [name, request] of workloads) {
          const s = await run(server.url, 0, batches, request);
          lines.push(
            `${target} ${collection} ${name}: ${s.batchesPerSecond.toFixed(1)} batches/s, ` +
              `${(s.batchesPerSecond * items).toFixed(0)} items/s, ` +
              `p50 ${s.p50.toFixed(1)} ms, p99 ${s.p99.toFixed(1)} ms`,
          );
        }
      }
      lines.push(`${target} MemAvailable ${memAvailableMiB().toFixed(0)} MiB`);
    } finally {
      await server.stop();
    }
  }
  console.log(lines.join("\n"));
} finally {
  rmSync(root, { recursive: true, force: true });
}
