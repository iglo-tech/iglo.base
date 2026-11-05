// M7.1a: iglo.base against upstream PocketBase v0.41.0 on the same data: HTTP
// workloads at 1, 8 and 50 clients, startup time and idle RSS. Not shipped;
// needs `bun run upstream:prepare` and `bun run build` (it runs dist/iglo-base
// unless --exe is given). Report: docs/perf/M7.1a-profile.md.
//
//   nice -n 10 bun test/perf/compare/bench.ts [--target iglo-base,upstream] [--clients 1,8,50]
//     [--seconds 4] [--warmup 1.5] [--repeat 3] [--workloads list,health] [--exe dist/iglo-base]
//     [--json out.json] [--cpu-prof <dir>]
//
// One pb_data is built once through upstream's API (a superuser, 20 teams, 200
// members with the default bcrypt cost 10, 3,000 posts with an author
// relation; the vendored fixture is only copied for its settings, never
// written). Each repetition copies it for each server and runs one server at a
// time. Every workload runs for --seconds after --warmup seconds, over
// keep-alive connections from this process (a separate process from the server;
// its CPU time is printed). The median of the repetitions is reported.
//
// With --cpu-prof the iglo.base server runs from source under
// `bun --cpu-prof --cpu-prof-dir <dir>` and is stopped with SIGTERM after each
// workload group so a .cpuprofile is written per run.

import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import {
  apiClient,
  hostFacts,
  percentile,
  procStats,
  repoRoot,
  startUpstreamServer,
  upsertSuperuser,
  type Server,
} from "@/../scripts/spikes/M0.8/common";

import { freePort } from "@test/support/executable";

const { values } = parseArgs({
  options: {
    target: { type: "string", default: "iglo-base,upstream" },
    clients: { type: "string", default: "1,8,50" },
    seconds: { type: "string", default: "4" },
    warmup: { type: "string", default: "1.5" },
    repeat: { type: "string", default: "3" },
    workloads: { type: "string" },
    exe: { type: "string", default: join(repoRoot, "dist/iglo-base") },
    json: { type: "string" },
    "cpu-prof": { type: "string" },
    keep: { type: "string" },
    // an experiment: turn off the request logs (settings logs.maxDays 0) on every server
    "no-logs": { type: "boolean", default: false },
  },
});
const targets = values.target!.split(",");
const clientCounts = values.clients!.split(",").map(Number);
const seconds = Number(values.seconds);
const warmup = Number(values.warmup);
const repeat = Number(values.repeat);
const password = "1234567890";
const MEMBERS = 200;
const POSTS = 3000;

function id(prefix: string, n: number): string {
  return prefix + String(n).padStart(14, "0");
}

async function build(dataDir: string, root: string): Promise<void> {
  await upsertSuperuser(dataDir, root, "bench@example.com", password);
  const server = await startUpstreamServer(dataDir, root);
  try {
    const api = apiClient(server.url);
    await api.loginSuperuser("bench@example.com", password);
    const teams = (await api.must("POST", "/api/collections", {
      name: "teams",
      type: "base",
      listRule: "",
      viewRule: "",
      fields: [{ name: "name", type: "text" }],
    })) as { id: string };
    const members = (await api.must("POST", "/api/collections", {
      name: "members",
      type: "auth",
      listRule: "",
      viewRule: "",
      fields: [
        { name: "name", type: "text" },
        { name: "team", type: "relation", collectionId: teams.id, maxSelect: 1 },
      ],
    })) as { id: string };
    await api.must("POST", "/api/collections", {
      name: "posts",
      type: "base",
      listRule: "",
      viewRule: "",
      createRule: "",
      fields: [
        { name: "title", type: "text" },
        { name: "body", type: "editor" },
        { name: "views", type: "number" },
        { name: "author", type: "relation", collectionId: members.id, maxSelect: 1 },
        { name: "created", type: "autodate", onCreate: true },
      ],
    });
    for (let t = 0; t < 20; t++) {
      await api.must("POST", "/api/collections/teams/records", {
        id: id("t", t),
        name: `Team ${t}`,
      });
    }
    // members are created in batches of 10 concurrent requests: each hashes a password
    for (let m = 0; m < MEMBERS; m += 10) {
      await Promise.all(
        Array.from({ length: 10 }, (_, k) =>
          api.must("POST", "/api/collections/members/records", {
            id: id("m", m + k),
            email: `m${m + k}@example.com`,
            emailVisibility: true,
            password,
            passwordConfirm: password,
            name: `Member ${m + k}`,
            team: id("t", (m + k) % 20),
          }),
        ),
      );
    }
    for (let p = 0; p < POSTS; p += 20) {
      await Promise.all(
        Array.from({ length: 20 }, (_, k) =>
          api.must("POST", "/api/collections/posts/records", {
            id: id("p", p + k),
            title: `Post ${p + k}`,
            body: `<p>Body of post <b>${p + k}</b></p>`.repeat(5),
            views: (p + k) * 7,
            author: id("m", (p + k) % MEMBERS),
          }),
        ),
      );
    }
  } finally {
    await server.stop();
  }
}

interface Workload {
  name: string;
  key: string;
  method?: string;
  path: string;
  body?: () => string;
  // clients above this are skipped (the workload cannot finish in time)
  status?: number;
}

const workloads: Workload[] = [
  { key: "list", name: "list 30", path: "/api/collections/posts/records?perPage=30" },
  {
    key: "list-filter",
    name: "list 30, filter + sort",
    path:
      "/api/collections/posts/records?perPage=30&sort=-views,title&filter=" +
      encodeURIComponent('views > 1000 && title ~ "Post 1"'),
  },
  {
    key: "list-expand1",
    name: "list 30, expand author",
    path: "/api/collections/posts/records?perPage=30&expand=author",
  },
  {
    key: "list-expand2",
    name: "list 30, expand author.team",
    path: "/api/collections/posts/records?perPage=30&expand=author.team",
  },
  { key: "view", name: "view", path: `/api/collections/posts/records/${id("p", 42)}` },
  {
    key: "create",
    name: "create (JSON)",
    method: "POST",
    path: "/api/collections/posts/records",
    body: () =>
      JSON.stringify({
        title: "New post",
        body: "<p>created by the benchmark</p>",
        views: 1,
        author: id("m", 7),
      }),
  },
  {
    key: "auth",
    name: "auth with password (cost 10)",
    method: "POST",
    path: "/api/collections/members/auth-with-password",
    body: () => JSON.stringify({ identity: "m5@example.com", password }),
  },
  { key: "health", name: "/api/health", path: "/api/health" },
];
const selected = values.workloads
  ? workloads.filter((w) => values.workloads!.split(",").includes(w.key))
  : workloads;

interface Result {
  rps: number;
  p50: number;
  p95: number;
  p99: number;
  errors: number;
  clientCpuMs: number;
}

async function run(url: string, w: Workload, clients: number, secs: number): Promise<Result> {
  const latencies: number[] = [];
  let errors = 0;
  const cpu0 = process.cpuUsage();
  const started = performance.now();
  const stopAt = started + secs * 1000;
  await Promise.all(
    Array.from({ length: clients }, async () => {
      while (performance.now() < stopAt) {
        const t0 = performance.now();
        try {
          const res = await fetch(url + w.path, {
            method: w.method ?? "GET",
            headers: w.body ? { "content-type": "application/json" } : undefined,
            body: w.body?.(),
          });
          await res.arrayBuffer();
          if (res.status !== 200) {
            errors++;
            continue;
          }
        } catch {
          errors++;
          continue;
        }
        latencies.push(performance.now() - t0);
      }
    }),
  );
  const elapsed = (performance.now() - started) / 1000;
  const cpu = process.cpuUsage(cpu0);
  latencies.sort((a, b) => a - b);
  return {
    rps: latencies.length / elapsed,
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    p99: percentile(latencies, 0.99),
    errors,
    clientCpuMs: (cpu.user + cpu.system) / 1000,
  };
}

async function startIglo(
  dataDir: string,
  root: string,
): Promise<{ server: Server; startMs: number }> {
  const port = await freePort();
  const profDir = values["cpu-prof"];
  const cmd = profDir
    ? [process.execPath, "--cpu-prof", "--cpu-prof-dir", profDir, join(repoRoot, "src/main.ts")]
    : [values.exe!];
  const t0 = performance.now();
  const proc = Bun.spawn(
    [
      ...cmd,
      "serve",
      "--http",
      `127.0.0.1:${port}`,
      "--dir",
      dataDir,
      "--automigrate=false",
      // a run from source is a dev run (logs and SQL printed); the compiled
      // executable is not, so profile it the same way
      ...(profDir ? ["--dev=false"] : []),
    ],
    {
      cwd: root,
      stdout: "ignore",
      stderr: "pipe",
      env: { ...process.env, NO_COLOR: "1" },
    },
  );
  const url = `http://127.0.0.1:${port}`;
  for (;;) {
    try {
      if ((await fetch(`${url}/api/health`)).ok) {
        break;
      }
    } catch {
      // not listening yet
    }
    if (proc.exitCode !== null) {
      throw new Error("iglo.base did not start");
    }
    await Bun.sleep(5);
  }
  const startMs = performance.now() - t0;
  return {
    startMs,
    server: {
      url,
      port,
      pid: proc.pid,
      output: () => "",
      async stop() {
        proc.kill("SIGTERM");
        const timer = setTimeout(() => proc.kill("SIGKILL"), 8_000);
        await proc.exited;
        clearTimeout(timer);
      },
    },
  };
}

async function startUp(
  dataDir: string,
  root: string,
): Promise<{ server: Server; startMs: number }> {
  const t0 = performance.now();
  const server = await startUpstreamServer(dataDir, root);
  // startUpstreamServer polls every 50 ms; the figure is an upper bound
  return { server, startMs: performance.now() - t0 };
}

const fmt = (n: number | null, d = 2): string => (n === null ? "-" : n.toFixed(d));

const median = (xs: number[]): number => {
  const s = xs.toSorted((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

mkdirSync(join(repoRoot, "dist"), { recursive: true });
const root = mkdtempSync(join(repoRoot, "dist", "compare-"));
const out: Record<string, unknown> = { host: hostFacts(), seconds, repeat };
try {
  const base = values.keep ?? join(root, "base", "pb_data");
  if (!existsSync(join(base, "data.db"))) {
    mkdirSync(base, { recursive: true });
    console.error("building the data...");
    await build(base, root);
  }

  const runs: Record<string, Record<string, Result[]>> = {};
  const startup: Record<string, number[]> = {};
  const idle: Record<string, number[]> = {};
  for (let rep = 0; rep < repeat; rep++) {
    for (const target of targets) {
      const dataDir = join(root, `${target}-${rep}`, "pb_data");
      mkdirSync(join(root, `${target}-${rep}`), { recursive: true });
      cpSync(base, dataDir, { recursive: true });
      const { server, startMs } =
        target === "upstream" ? await startUp(dataDir, root) : await startIglo(dataDir, root);
      try {
        (startup[target] ??= []).push(startMs);
        if (values["no-logs"]) {
          const api = apiClient(server.url);
          await api.loginSuperuser("bench@example.com", password);
          await api.must("PATCH", "/api/settings", { logs: { maxDays: 0 } });
        }
        // the idle time would show up in a CPU profile as one function's self time
        await Bun.sleep(values["cpu-prof"] ? 0 : 3000);
        (idle[target] ??= []).push(procStats(server.pid).rssMiB);
        for (const w of selected) {
          for (const c of clientCounts) {
            await run(server.url, w, c, warmup);
            const r = await run(server.url, w, c, seconds);
            ((runs[target] ??= {})[`${w.key}@${c}`] ??= []).push(r);
            console.error(
              `${rep} ${target} ${w.key}@${c}: ${r.rps.toFixed(0)} rps p50 ${r.p50.toFixed(2)} p99 ${r.p99.toFixed(2)} err ${r.errors} clientCPU ${r.clientCpuMs.toFixed(0)}ms`,
            );
          }
        }
        (idle[`${target}-after`] ??= []).push(procStats(server.pid).rssMiB);
      } finally {
        await server.stop();
        rmSync(join(root, `${target}-${rep}`), { recursive: true, force: true });
      }
    }
  }

  const table: string[] = [
    "| Workload | Clients | iglo.base req/s | p50 | p95 | p99 | upstream req/s | p50 | p95 | p99 | p50 ratio | p95 ratio | req/s ratio |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  const med = (target: string, key: string, f: keyof Result): number | null => {
    const rs = runs[target]?.[key];
    return rs ? median(rs.map((r) => r[f])) : null;
  };
  for (const w of selected) {
    for (const c of clientCounts) {
      const key = `${w.key}@${c}`;
      const g = (t: string, f: keyof Result) => med(t, key, f);
      const ratio = (f: keyof Result): string => {
        const a = g("iglo-base", f);
        const b = g("upstream", f);
        return a === null || b === null ? "-" : (a / b).toFixed(2);
      };
      table.push(
        `| ${w.name} | ${c} | ${fmt(g("iglo-base", "rps"), 0)} | ${fmt(g("iglo-base", "p50"))} | ${fmt(g("iglo-base", "p95"))} | ${fmt(g("iglo-base", "p99"))} | ${fmt(g("upstream", "rps"), 0)} | ${fmt(g("upstream", "p50"))} | ${fmt(g("upstream", "p95"))} | ${fmt(g("upstream", "p99"))} | ${ratio("p50")} | ${ratio("p95")} | ${ratio("rps")} |`,
      );
    }
  }
  console.log(table.join("\n"));
  for (const t of targets) {
    console.log(
      `\n${t}: startup ${startup[t]!.map((x) => x.toFixed(0)).join("/")} ms (median ${median(startup[t]!).toFixed(0)}), idle RSS ${idle[t]!.map((x) => x.toFixed(1)).join("/")} MiB (median ${median(idle[t]!).toFixed(1)}), RSS after the run ${idle[`${t}-after`]!.map((x) => x.toFixed(0)).join("/")} MiB`,
    );
  }
  out.runs = runs;
  out.startup = startup;
  out.idle = idle;
  if (values.json) {
    writeFileSync(values.json, JSON.stringify(out, null, 1));
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
