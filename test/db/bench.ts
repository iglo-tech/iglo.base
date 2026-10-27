// Baseline measurements of the db layer for docs/perf/M0.4-db-layer.md.
// Not a test: run `bun test/db/bench.ts [--dir <scratch dir>]` after
// `bun run upstream:prepare` (it opens copies of upstream's tests/data).
// The scratch directory defaults to the OS temp directory; each run copies
// the fixture into a new subdirectory and removes it afterwards.

import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { Databases } from "@/db/base";
import { HashExp } from "@/db/dbx/expression";
import { runInTransaction } from "@/db/tx";
import { defaultLayout } from "@test/support/reference-tools";

const { values } = parseArgs({ options: { dir: { type: "string" } }, strict: true });
const scratch = values.dir ?? tmpdir();
const fixtureDir = join(defaultLayout.sourceDir, "tests", "data");

function withCopy<T>(fn: (dataDir: string) => T): T {
  const root = mkdtempSync(join(scratch, "iglo-base-bench-"));
  try {
    const dataDir = join(root, "pb_data");
    cpSync(fixtureDir, dataDir, { recursive: true });
    return fn(dataDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function median(xs: number[]): number {
  const sorted = xs.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function time(fn: () => void): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

function rate(n: number, ms: number): string {
  return `${Math.round((n / ms) * 1000).toLocaleString("en-US")} ops/s (${n} in ${ms.toFixed(0)} ms)`;
}

const results: [string, string][] = [];
function report(name: string, value: string): void {
  results.push([name, value]);
}

// open time of both fixture files (connect + pragmas), first open of a copy
{
  const samples: number[] = [];
  for (let i = 0; i < 20; i++) {
    withCopy((dataDir) => {
      let app: Databases | null = null;
      samples.push(
        time(() => {
          app = Databases.open({ dataDir });
        }),
      );
      (app as Databases | null)?.close();
    });
  }
  report("open data.db + auxiliary.db (median of 20)", `${median(samples).toFixed(2)} ms`);
}

withCopy((dataDir) => {
  const app = Databases.open({ dataDir });
  try {
    app
      .nonconcurrentDB()
      .newQuery(
        "CREATE TABLE bench (id TEXT PRIMARY KEY NOT NULL, title TEXT DEFAULT '' NOT NULL, n INTEGER DEFAULT 0 NOT NULL)",
      )
      .execute();

    // single-row inserts, each its own implicit transaction
    const autocommitN = 2_000;
    let ms = time(() => {
      for (let i = 0; i < autocommitN; i++) {
        app
          .db()
          .insert("bench", { id: `a${i}`, title: `title ${i}`, n: i })
          .execute();
      }
    });
    report("single-row insert, outside a transaction", rate(autocommitN, ms));

    // single-row inserts inside one transaction
    const txN = 20_000;
    ms = time(() => {
      runInTransaction(app, (txApp) => {
        for (let i = 0; i < txN; i++) {
          txApp
            .db()
            .insert("bench", { id: `t${i}`, title: `title ${i}`, n: i })
            .execute();
        }
      });
    });
    report("single-row insert, inside one transaction", rate(txN, ms));

    // single-row select by primary key through the builder
    const selectN = 20_000;
    ms = time(() => {
      for (let i = 0; i < selectN; i++) {
        app
          .db()
          .select("id", "title", "n")
          .from("bench")
          .where(new HashExp({ id: `t${i}` }))
          .limit(1)
          .one();
      }
    });
    report("single-row select by id, outside a transaction", rate(selectN, ms));

    ms = time(() => {
      runInTransaction(app, (txApp) => {
        for (let i = 0; i < selectN; i++) {
          txApp
            .db()
            .select("id", "title", "n")
            .from("bench")
            .where(new HashExp({ id: `t${i}` }))
            .limit(1)
            .one();
        }
      });
    });
    report("single-row select by id, inside one transaction", rate(selectN, ms));

    // a 10,000-row select
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      samples.push(
        time(() => {
          const rows = app.db().select("id", "title", "n").from("bench").limit(10_000).all();
          if (rows.length !== 10_000) throw new Error(`got ${rows.length} rows`);
        }),
      );
    }
    report("10,000-row select (median of 20)", `${median(samples).toFixed(2)} ms`);
  } finally {
    app.close();
  }
});

console.log(`Bun ${Bun.version}, scratch ${scratch}\n`);
console.log("| Measurement | Result |\n|---|---|");
for (const [name, value] of results) {
  console.log(`| ${name} | ${value} |`);
}
