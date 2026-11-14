// R.1 spike (throwaway): prints the markdown tables of docs/perf/replicas-spike.md
// from the JSON of bench.ts --json (median of the repetitions, min to max in brackets).
//
//   bun scripts/spikes/R.1/summarize.ts <bench.json> [<bench.json> ...]

import { readFileSync } from "node:fs";

interface Result {
  rps: number;
  p50: number;
  p95: number;
  p99: number;
  errors: number;
  clientCpuMs: number;
  serverCpuMs?: number[];
}
interface Bench {
  seconds: number;
  repeat: number;
  cpus: number;
  host: string;
  runs: Record<string, Record<string, Result[]>>;
  rss: Record<string, { idle: number[]; after: number[] }[]>;
  load: Record<string, { before: string; after: string; memBeforeMiB: number }[]>;
  skipped: string[];
  startup: Record<string, number[]>;
}

const files = process.argv.slice(2);
const docs: Bench[] = files.map((f) => JSON.parse(readFileSync(f, "utf8")) as Bench);
// several files are merged: their runs of one target are added together
const merged: Bench = { ...docs[0]!, runs: {}, rss: {}, load: {}, skipped: [], startup: {} };
for (const d of docs) {
  for (const [t, byKey] of Object.entries(d.runs)) {
    for (const [k, rs] of Object.entries(byKey)) {
      ((merged.runs[t] ??= {})[k] ??= []).push(...rs);
    }
  }
  for (const [t, xs] of Object.entries(d.rss)) {
    (merged.rss[t] ??= []).push(...xs);
  }
  for (const [t, xs] of Object.entries(d.load)) {
    (merged.load[t] ??= []).push(...xs);
  }
  merged.skipped.push(...d.skipped);
  for (const [t, xs] of Object.entries(d.startup)) {
    (merged.startup[t] ??= []).push(...xs);
  }
}
const b = merged;

const median = (xs: number[]): number => {
  const s = xs.toSorted((x, y) => x - y);
  return s[Math.floor(s.length / 2)]!;
};
const range = (xs: number[], d = 1): string =>
  `[${Math.min(...xs).toFixed(d)}–${Math.max(...xs).toFixed(d)}]`;
const med = (xs: number[], d = 2): string => median(xs).toFixed(d);

// the configurations in the order they were run
const configs = Object.keys(b.runs);
const label = (t: string): string => {
  if (t === "iglo-base") return "iglo.base, N=0 (today)";
  if (t === "upstream") return "PocketBase v0.41.0";
  const m = /^iglo-r(\d+)(p?)$/.exec(t);
  if (!m) return t;
  return `N=${m[1]} replicas${m[2] ? ", read pool 4" : ""}`;
};
const workloads: { key: string; name: string }[] = [
  { key: "list", name: "list 30" },
  { key: "list-filter", name: "list 30, filter + sort" },
  { key: "list-expand1", name: "list 30, expand author" },
  { key: "view", name: "view" },
  { key: "create", name: "create (JSON)" },
];
const clients = [1, 10, 50];

const out: string[] = [];
const p = (s = "") => out.push(s);

p("## Latency and throughput per workload");
p();
p(
  "Each cell: median of the repetitions; spread in brackets (min–max). p50 and req/s at 1, 10 and 50 clients; p95 at 50 clients.",
);
p();
for (const w of workloads) {
  p(`### ${w.name}`);
  p();
  p(
    "| Configuration | 1 client p50 ms | 1 client req/s | 10 clients p50 ms | 10 clients req/s | 50 clients p50 ms | 50 clients p95 ms | 50 clients req/s |",
  );
  p("|---|---|---|---|---|---|---|---|");
  for (const t of configs) {
    const cells: string[] = [label(t)];
    for (const c of clients) {
      const rs = b.runs[t]?.[`${w.key}@${c}`];
      if (!rs) {
        cells.push("-");
        if (c !== 50) cells.push("-");
        continue;
      }
      cells.push(`${med(rs.map((r) => r.p50))} ${range(rs.map((r) => r.p50))}`);
      if (c !== 50) {
        cells.push(
          med(
            rs.map((r) => r.rps),
            0,
          ),
        );
      } else {
        cells.push(med(rs.map((r) => r.p95)));
        cells.push(
          `${med(
            rs.map((r) => r.rps),
            0,
          )} ${range(
            rs.map((r) => r.rps),
            0,
          )}`,
        );
      }
    }
    p(`| ${cells.join(" | ")} |`);
  }
  p();
}

p("## Ratio to PocketBase (p50 at 50 clients; below 1.00 is faster)");
p();
p("| Configuration | " + workloads.map((w) => w.name).join(" | ") + " |");
p("|---|" + workloads.map(() => "---").join("|"));
for (const t of configs.filter((x) => x !== "upstream")) {
  const row = workloads.map((w) => {
    const a = b.runs[t]?.[`${w.key}@50`];
    const u = b.runs.upstream?.[`${w.key}@50`];
    if (!a || !u) return "-";
    return (median(a.map((r) => r.p50)) / median(u.map((r) => r.p50))).toFixed(2);
  });
  p(`| ${label(t)} | ${row.join(" | ")} |`);
}
p();

p("## Memory (RSS, MiB): primary first, then each replica; median of the repetitions");
p();
p("| Configuration | idle | after the runs | host load (1 min) before, median |");
p("|---|---|---|---|");
for (const t of configs) {
  const rs = b.rss[t];
  if (!rs) continue;
  const procs = rs[0]!.idle.length;
  const idle = Array.from({ length: procs }, (_, i) =>
    median(rs.map((r) => r.idle[i]!)).toFixed(0),
  );
  const after = Array.from({ length: procs }, (_, i) =>
    median(rs.map((r) => r.after[i]!)).toFixed(0),
  );
  const loads = b.load[t]?.map((l) => Number(l.before.split(" ")[0])) ?? [];
  p(
    `| ${label(t)} | ${idle.join(" + ")} | ${after.join(" + ")} | ${loads.length ? median(loads).toFixed(2) : "-"} |`,
  );
}
p();

p("## CPU of the servers at 50 clients: cores busy per process, median (primary first)");
p();
p("| Configuration | workload | cores per process | bench client cores |");
p("|---|---|---|---|");
for (const t of configs) {
  if (t === "upstream") continue;
  for (const w of workloads) {
    const rs = b.runs[t]?.[`${w.key}@50`];
    if (!rs || !rs[0]!.serverCpuMs) continue;
    const procs = rs[0]!.serverCpuMs!.length;
    const cores = Array.from({ length: procs }, (_, i) =>
      (median(rs.map((r) => r.serverCpuMs![i]!)) / (b.seconds * 1000)).toFixed(2),
    );
    const client = median(rs.map((r) => r.clientCpuMs / (b.seconds * 1000))).toFixed(2);
    p(`| ${label(t)} | ${w.name} | ${cores.join(" / ")} | ${client} |`);
  }
}
p();

p("## Host");
p();
p(
  `- ${b.host}; ${b.cpus} CPUs (availableParallelism); ${b.repeat} repetitions, ${b.seconds} s measured per cell.`,
);
p(
  "- Load average (1 min) before each configuration, by configuration: " +
    configs
      .map((t) => `${label(t)}: ${(b.load[t] ?? []).map((l) => l.before.split(" ")[0]).join(", ")}`)
      .join("; ") +
    ".",
);
if (b.skipped.length > 0) {
  p(`- Skipped: ${b.skipped.join("; ")}.`);
}
p();

console.log(out.join("\n"));
