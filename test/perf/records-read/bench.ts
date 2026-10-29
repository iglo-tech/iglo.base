// M2.4: records list and view over HTTP, iglo.base against upstream
// PocketBase v0.41.0 on the same data. Not shipped; needs
// `bun run upstream:prepare`.
//
//   nice -n 10 bun test/perf/records-read/bench.ts [--requests 3000] [--concurrency 8] [--keep <dir>]
//
// Builds a fresh install through upstream's API: 10 teams, 50 members
// (auth, with a team relation), and 200 posts (an author relation) in two
// collections with the same records: `posts` with an empty list/view rule
// and `posts_rel` with a relation rule (`author.team.name != "Team 3"`).
// Then upstream and the iglo.base executable serve copies of that pb_data
// (iglo.base with its default read pool), one at a time, and each
// workload runs as a guest: --requests requests (after 300 warm-up
// requests) with --concurrency requests in flight over keep-alive
// connections. Prints requests/s and the p50/p99 latency per workload.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { runUpstream } from "@test/differential/db/fixture";
import { copyDataDir } from "@test/scenarios/fixture";
import { startServer } from "@test/support/executable";
import { startUpstream } from "@test/support/upstream";

const { values } = parseArgs({
  options: {
    requests: { type: "string", default: "3000" },
    concurrency: { type: "string", default: "8" },
    // build the data once into this directory and keep it (reused when it exists)
    keep: { type: "string" },
  },
});
const totalRequests = Number(values.requests);
const concurrency = Number(values.concurrency);
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
      ["posts", ""],
      ["posts_rel", `author.team.name != "Team 3"`],
    ] as const) {
      await api("POST", "/api/collections", {
        name,
        type: "base",
        listRule: rule,
        viewRule: rule,
        fields: [
          { name: "title", type: "text" },
          { name: "body", type: "editor" },
          { name: "views", type: "number" },
          { name: "author", type: "relation", collectionId: members.id, maxSelect: 1 },
          { name: "created", type: "autodate", onCreate: true },
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
        emailVisibility: m % 2 === 0,
        password,
        passwordConfirm: password,
        name: `Member ${m}`,
        team: id("t", m % 10),
      });
    }
    for (let p = 0; p < 200; p++) {
      const body = {
        id: id("p", p),
        title: `Post ${p}`,
        body: `<p>Body of post <b>${p}</b></p>`.repeat(5),
        views: p * 7,
        author: id("m", p % 50),
      };
      await api("POST", "/api/collections/posts/records", body);
      await api("POST", "/api/collections/posts_rel/records", body);
    }
  } finally {
    await server.stop();
  }
}

interface Workload {
  name: string;
  path: string;
}

const workloads: Workload[] = [
  { name: "list 30", path: "/api/collections/posts/records?perPage=30" },
  { name: "list 30, relation rule", path: "/api/collections/posts_rel/records?perPage=30" },
  {
    name: "list 30, expand author.team",
    path: "/api/collections/posts/records?perPage=30&expand=author.team",
  },
  { name: "view", path: `/api/collections/posts/records/${id("p", 42)}` },
];

async function run(
  baseUrl: string,
  path: string,
  n: number,
): Promise<{ rps: number; p50: number; p99: number }> {
  const latencies: number[] = [];
  let next = 0;
  const started = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < n) {
        next++;
        const t0 = performance.now();
        const res = await fetch(baseUrl + path);
        await res.arrayBuffer();
        if (res.status !== 200) {
          throw new Error(`${path}: ${res.status}`);
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

const root = mkdtempSync(join(tmpdir(), "iglo-base-records-bench-"));
try {
  const dataDir = values.keep ?? join(root, "pb_data");
  if (values.keep === undefined || !existsSync(join(dataDir, "data.db"))) {
    await build(dataDir, root);
  }

  const results: string[] = [];
  for (const target of ["upstream", "iglo.base"] as const) {
    const copy = join(root, target, "pb_data");
    copyDataDir(dataDir, copy);
    const server =
      target === "upstream" ? await startUpstream({ dataDir: copy }) : await startServer([], copy);
    try {
      for (const w of workloads) {
        await run(server.url, w.path, 300);
        const r = await run(server.url, w.path, totalRequests);
        results.push(
          `| ${w.name} | ${target} | ${r.rps.toFixed(0)} | ${r.p50.toFixed(2)} ms | ${r.p99.toFixed(2)} ms |`,
        );
      }
    } finally {
      await server.stop();
    }
  }
  console.log("| Workload | Server | Requests/s | p50 | p99 |");
  console.log("|---|---|---|---|---|");
  for (const line of results) {
    console.log(line);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
