// M7.1a: summarizes a .cpuprofile (V8 format, as `bun --cpu-prof` writes):
// the top functions by self time and by total time, and the self time grouped
// by area. Not shipped.
//
//   bun test/perf/compare/summarize-profile.ts <file.cpuprofile> [--top 25] [--md]

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { top: { type: "string", default: "25" }, md: { type: "boolean", default: false } },
});
const top = Number(values.top);

interface Node {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
  children?: number[];
}
const profile = JSON.parse(readFileSync(positionals[0]!, "utf8")) as {
  nodes: Node[];
  samples: number[];
  timeDeltas: number[];
};

const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const parent = new Map<number, number>();
for (const n of profile.nodes) {
  for (const c of n.children ?? []) {
    parent.set(c, n.id);
  }
}

const selfByNode = new Map<number, number>();
let total = 0;
for (let i = 0; i < profile.samples.length; i++) {
  // a sample's duration is the delta to the next one
  const dt = profile.timeDeltas[i + 1] ?? profile.timeDeltas[i] ?? 0;
  selfByNode.set(profile.samples[i]!, (selfByNode.get(profile.samples[i]!) ?? 0) + dt);
  total += dt;
}

function label(n: Node): string {
  const f = n.callFrame;
  const url = f.url
    .replace(/^file:\/\//, "")
    .replace(/^.*\/iglo\.base\/[^/]+\//, "")
    .replace(/^.*\/node_modules\//, "node_modules/");
  const name = f.functionName === "" ? "(anonymous)" : f.functionName;
  return url === "" ? `${name} [native]` : `${name} ${url}:${f.lineNumber + 1}`;
}

const self = new Map<string, number>();
const totalByFn = new Map<string, number>();
for (const [id, t] of selfByNode) {
  const n = byId.get(id)!;
  self.set(label(n), (self.get(label(n)) ?? 0) + t);
  // total: once per distinct function on the stack
  const seen = new Set<string>();
  for (let cur: number | undefined = id; cur !== undefined; cur = parent.get(cur)) {
    const l = label(byId.get(cur)!);
    if (!seen.has(l)) {
      seen.add(l);
      totalByFn.set(l, (totalByFn.get(l) ?? 0) + t);
    }
  }
}

const groups: [string, RegExp][] = [
  ["idle (program, GC, native)", /^\((idle|program|garbage collector|root)\)/],
  ["SQLite and db layer", /src\/db\/|bun:sqlite|sqlite/i],
  ["record hydration and fields", /src\/records\/record-(model|query)|src\/fields\//],
  ["expand", /record-query-expand/],
  [
    "rule and filter parse, resolve",
    /src\/search\/|record-field-resolver|src\/records\/.*resolver|fexpr/,
  ],
  [
    "routing, request event, middleware",
    /src\/server\/|src\/middlewares\/|src\/apis\/(router|serve|base)/,
  ],
  ["record API handlers", /src\/apis\//],
  ["JSON writing and types", /go-json|src\/tools\/types|JSON/],
  ["tokens, security, crypto", /src\/tools\/(security|crypto)|jwt|token/],
  ["Bun runtime and node modules", /native|node:|node_modules|bun:/],
];
const grouped = new Map<string, number>();
for (const [l, t] of self) {
  const g = groups.find(([, re]) => re.test(l))?.[0] ?? "other src";
  grouped.set(g, (grouped.get(g) ?? 0) + t);
}

const ms = (us: number): string => (us / 1000).toFixed(0);
const pct = (us: number): string => ((us / total) * 100).toFixed(1);
const rows = (m: Map<string, number>): string[] =>
  [...m]
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([l, t]) =>
      values.md
        ? `| ${l.replace(/\|/g, "\\|")} | ${ms(t)} | ${pct(t)}% |`
        : `${pct(t).padStart(5)}%  ${ms(t).padStart(6)} ms  ${l}`,
    );

console.log(`total sampled time: ${ms(total)} ms, ${profile.samples.length} samples`);
console.log("\nSelf time by area");
console.log(rows(grouped).join("\n"));
console.log("\nTop self time");
console.log(rows(self).join("\n"));
console.log("\nTop total time");
console.log(rows(totalByFn).join("\n"));
