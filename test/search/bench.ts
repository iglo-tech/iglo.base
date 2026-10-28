// Not a test: run `nice -n 10 bun test/search/bench.ts` for the numbers in
// docs/perf/M2.1-search.md.
//
// 1. Parse + build: filterBuildExpr with the simple field resolver, then
//    Expression.build (the SQL text), for representative filters, without
//    and with a ParsedFilterCache.
// 2. Provider list: Provider.exec over a 10,000-row table in a file
//    database (WAL), with a filter, a sort, the count query and a page.

import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Clock } from "@/app/clock";
import { newFromDB } from "@/db/dbx/db";
import { type FilterData, filterBuildExpr, ParsedFilterCache } from "@/search/filter";
import { newProvider } from "@/search/provider";
import { newSimpleFieldResolver } from "@/search/simple-field-resolver";
import { parseSortFromString } from "@/search/sort";

const clock: Clock = { now: () => new Date() };

function median(xs: number[]): number {
  const sorted = xs.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

// the median of `runs` timings (ms) after `warmup` runs
async function time(runs: number, warmup: number, fn: () => unknown): Promise<number> {
  for (let i = 0; i < warmup; i++) {
    await fn();
  }
  const out: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    await fn();
    out.push(performance.now() - start);
  }
  return median(out);
}

const filters: [string, FilterData][] = [
  ["simple", "title = 'abc'"],
  [
    "50 expressions",
    Array.from({ length: 50 }, (_, i) =>
      i % 3 === 0 ? `n > ${i}` : i % 3 === 1 ? `title ~ 'x${i}'` : `active = true`,
    ).join(" && "),
  ],
  [
    "nested groups (depth 10)",
    Array.from({ length: 10 }, (_, i) => `(n > ${i} || title = 't${i}' && `).join("") +
      "active = false" +
      ")".repeat(10),
  ],
  ["long string (3,000 chars)", `title ~ '${"abc".repeat(1000)}'`],
  [
    "macros and functions",
    "created > @todayStart && strftime('%Y', created) = '2026' && geoDistance(1, 2, 3, 4) < 100",
  ],
];

const resolver = newSimpleFieldResolver("title", "n", "active", "created");
const db = newFromDB(new Database(":memory:"), "sqlite");

console.log("## Parse + build (median of 2,000 runs, ms)\n");
console.log("| Filter | Length | No cache | With cache |");
console.log("|---|---|---|---|");
for (const [name, filter] of filters) {
  const cache = new ParsedFilterCache();
  const noCache = await time(2000, 200, () =>
    filterBuildExpr(filter, resolver, { clock }).build(db, {}),
  );
  const withCache = await time(2000, 200, () =>
    filterBuildExpr(filter, resolver, { clock, cache }).build(db, {}),
  );
  console.log(`| ${name} | ${filter.length} | ${noCache.toFixed(4)} | ${withCache.toFixed(4)} |`);
}

const root = mkdtempSync(join(tmpdir(), "iglo-base-search-bench-"));
try {
  const conn = new Database(join(root, "data.db"));
  conn.run("PRAGMA journal_mode = WAL");
  conn.run(
    "CREATE TABLE bench (id TEXT PRIMARY KEY NOT NULL, title TEXT DEFAULT '' NOT NULL, n INTEGER DEFAULT 0 NOT NULL, active BOOLEAN DEFAULT FALSE NOT NULL, created TEXT DEFAULT '' NOT NULL)",
  );
  const insert = conn.prepare("INSERT INTO bench VALUES (?, ?, ?, ?, ?)");
  conn.transaction(() => {
    for (let i = 0; i < 10_000; i++) {
      insert.run(
        `r${String(i).padStart(14, "0")}`,
        `title ${i}`,
        i,
        i % 2,
        "2026-10-28 12:00:00.000Z",
      );
    }
  })();
  const bench = newFromDB(conn, "sqlite");

  const cases: [string, FilterData[], string, number, boolean][] = [
    ["no filter, page 1 of 30", [], "", 30, false],
    [
      "filter + sort, page 1 of 30",
      ["n > 2500 && title ~ 'title 1' && active = true"],
      "-n,title",
      30,
      false,
    ],
    ["filter + sort, 1,000 rows, skipTotal", ["n >= 0"], "-n", 1000, true],
    ["all 10,000 rows (10 pages of 1,000, skipTotal)", [], "n", 1000, true],
  ];

  console.log("\n## Provider list over 10,000 rows (median of 50 runs, ms)\n");
  console.log("| Case | ms |");
  console.log("|---|---|");
  for (const [name, filter, sort, perPage, skipTotal] of cases) {
    const ms = await time(50, 5, async () => {
      const pages = name.startsWith("all") ? 10 : 1;
      for (let page = 1; page <= pages; page++) {
        await newProvider(resolver, { clock })
          .query(bench.select("*").from("bench"))
          .filter(filter)
          .sort(sort === "" ? [] : parseSortFromString(sort))
          .page(page)
          .perPage(perPage)
          .skipTotal(skipTotal)
          .exec();
      }
    });
    console.log(`| ${name} | ${ms.toFixed(2)} |`);
  }
  conn.close();
} finally {
  rmSync(root, { recursive: true, force: true });
}
