// M3.1: records create, update and delete over HTTP, iglo.base against
// upstream PocketBase v0.41.0 on the same data. Not shipped; needs
// `bun run upstream:prepare`.
//
//   nice -n 10 bun test/perf/records-write/bench.ts [--requests 2000] [--concurrency 1]
//
// Builds a fresh install through upstream's API: 10 teams, 50 members
// (auth, with a team relation) and two collections with the same fields
// (title, views, author relation, created/updated): `notes` with empty
// create/update/delete rules and `notes_rel` with the relation rule
// `author.team.name != "Team 3"` for all three. Then upstream and the
// iglo.base executable serve copies of that pb_data, one at a time, and
// each collection gets, as a guest: --requests creates (explicit ids,
// after 200 warm-up creates), an update of each created record, and a
// delete of each, with --concurrency requests in flight over keep-alive
// connections. Prints requests/s and the p50/p99 latency per workload.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { runUpstream } from "@test/differential/db/fixture";
import { copyDataDir } from "@test/scenarios/fixture";
import { startServer } from "@test/support/executable";
import { startUpstream } from "@test/support/upstream";

const { values } = parseArgs({
  options: {
    requests: { type: "string", default: "2000" },
    concurrency: { type: "string", default: "1" },
  },
});
const totalRequests = Number(values.requests);
const concurrency = Number(values.concurrency);
const warmup = 200;
const password = "1234567890";

// a 15 character record id: a one letter prefix and the number
function id(prefix: string, n: number): string {
  return prefix + String(n).padStart(14, "0");
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

    const teams = (await api("POST", "/api/collections", {
      name: "teams",
      type: "base",
      listRule: "",
      viewRule: "",
      fields: [{ name: "name", type: "text" }],
    })) as { id: string };
    const members = (await api("POST", "/api/collections", {
      name: "members",
      type: "auth",
      listRule: "",
      viewRule: "",
      fields: [
        { name: "name", type: "text" },
        { name: "team", type: "relation", collectionId: teams.id, maxSelect: 1 },
      ],
    })) as { id: string };
    for (const [name, rule] of [
      ["notes", ""],
      ["notes_rel", `author.team.name != "Team 3"`],
    ] as const) {
      await api("POST", "/api/collections", {
        name,
        type: "base",
        listRule: "",
        viewRule: "",
        createRule: rule,
        updateRule: rule,
        deleteRule: rule,
        fields: [
          { name: "title", type: "text" },
          { name: "views", type: "number" },
          { name: "author", type: "relation", collectionId: members.id, maxSelect: 1 },
          { name: "created", type: "autodate", onCreate: true },
          { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
        ],
      });
    }

    for (let t = 0; t < 10; t++) {
      await api("POST", "/api/collections/teams/records", { id: id("t", t), name: `Team ${t}` });
    }
    for (let m = 0; m < 50; m++) {
      await api("POST", "/api/collections/members/records", {
        id: id("m", m),
        email: `m${m}@example.com`,
        password,
        passwordConfirm: password,
        name: `Member ${m}`,
        team: id("t", m % 10),
      });
    }
  } finally {
    await server.stop();
  }
}

// the author of note n: never in Team 3, so the relation rule passes
function author(n: number): string {
  const m = n % 50;
  return id("m", m % 10 === 3 ? m + 1 : m);
}

async function run(
  baseUrl: string,
  from: number,
  n: number,
  request: (i: number) => { method: string; path: string; body?: unknown },
  expected: number,
): Promise<{ rps: number; p50: number; p99: number }> {
  const latencies: number[] = [];
  let next = from;
  const end = from + n;
  const started = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < end) {
        const r = request(next++);
        const t0 = performance.now();
        const res = await fetch(baseUrl + r.path, {
          method: r.method,
          headers: { "content-type": "application/json" },
          body: r.body === undefined ? undefined : JSON.stringify(r.body),
        });
        await res.arrayBuffer();
        if (res.status !== expected) {
          throw new Error(`${r.method} ${r.path}: ${res.status}`);
        }
        latencies.push(performance.now() - t0);
      }
    }),
  );
  const elapsed = (performance.now() - started) / 1000;
  latencies.sort((a, b) => a - b);
  const at = (q: number): number =>
    latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))] as number;
  return { rps: n / elapsed, p50: at(0.5), p99: at(0.99) };
}

const root = mkdtempSync(join(tmpdir(), "iglo-base-records-write-bench-"));
try {
  const dataDir = join(root, "pb_data");
  await build(dataDir, root);

  const results: string[] = [];
  for (const target of ["upstream", "iglo.base"] as const) {
    const copy = join(root, target, "pb_data");
    copyDataDir(dataDir, copy);
    const server =
      target === "upstream" ? await startUpstream({ dataDir: copy }) : await startServer([], copy);
    try {
      for (const collection of ["notes", "notes_rel"]) {
        const base = `/api/collections/${collection}/records`;
        const workloads = [
          {
            name: "create",
            expected: 200,
            request: (i: number) => ({
              method: "POST",
              path: base,
              body: { id: id("n", i), title: `Note ${i}`, views: i, author: author(i) },
            }),
          },
          {
            name: "update",
            expected: 200,
            request: (i: number) => ({
              method: "PATCH",
              path: `${base}/${id("n", i)}`,
              body: { title: `Note ${i} updated`, "views+": 1 },
            }),
          },
          {
            name: "delete",
            expected: 204,
            request: (i: number) => ({ method: "DELETE", path: `${base}/${id("n", i)}` }),
          },
        ];
        for (const w of workloads) {
          await run(server.url, 0, warmup, w.request, w.expected);
          const r = await run(server.url, warmup, totalRequests, w.request, w.expected);
          results.push(
            `| ${w.name} ${collection} | ${target} | ${r.rps.toFixed(0)} | ${r.p50.toFixed(2)} ms | ${r.p99.toFixed(2)} ms |`,
          );
        }
      }
    } finally {
      await server.stop();
    }
  }
  console.log(`concurrency ${concurrency}, ${totalRequests} requests per workload`);
  console.log("| Workload | Server | Requests/s | p50 | p99 |");
  console.log("|---|---|---|---|---|");
  for (const line of results) {
    console.log(line);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
