// M0.6 spike (D8): the read workloads, run through src/db either with the
// synchronous resolvers on the main-thread connection ("main") or with the
// async resolvers on the read worker pool ("pool N"). Not shipped.

import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Databases } from "@/db/base";
import type { Params } from "@/db/dbx/query";

export type Dataset = "fixture" | "1m";
export type WorkloadName = "lookup" | "page" | "count" | "slow";
export const workloadNames: readonly WorkloadName[] = ["lookup", "page", "count", "slow"];

export interface Workload {
  // a new query's SQL and params each call
  next(): { sql: string; params: Params };
}

export interface Target {
  dataset: Dataset;
  dir: string;
  app: Databases;
  workloads: Record<WorkloadName, Workload>;
  // runs one query of the workload in the target's mode
  run(name: WorkloadName): Promise<unknown> | unknown;
  close(): Promise<void>;
}

function pick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}

function workloadsFor(dataset: Dataset, app: Databases): Record<WorkloadName, Workload> {
  const db = app.nonconcurrentDB();
  if (dataset === "fixture") {
    const ids = db.newQuery("SELECT id FROM _collections").column<string>();
    return {
      lookup: {
        next: () => ({
          sql: "SELECT {{_collections}}.* FROM {{_collections}} WHERE [[id]] = {:id} LIMIT 1",
          params: { id: pick(ids) },
        }),
      },
      page: {
        next: () => ({
          sql: "SELECT {{_migrations}}.* FROM {{_migrations}} WHERE [[applied]] > {:a} ORDER BY [[file]] DESC LIMIT 30",
          params: { a: 0 },
        }),
      },
      count: { next: () => ({ sql: "SELECT COUNT(*) FROM {{_migrations}}", params: {} }) },
      slow: {
        next: () => ({
          sql: "SELECT {{_collections}}.* FROM {{_collections}} WHERE [[fields]] LIKE {:q} ORDER BY [[created]] DESC LIMIT 30",
          params: { q: "%needle-xyz%" },
        }),
      },
    };
  }
  const ids = db.newQuery("SELECT id FROM posts WHERE rowid % 1000 = 0").column<string>();
  return {
    lookup: {
      next: () => ({
        sql: "SELECT {{posts}}.* FROM {{posts}} WHERE [[id]] = {:id} LIMIT 1",
        params: { id: pick(ids) },
      }),
    },
    page: {
      next: () => ({
        // one author's posts (about 1,000, indexed), half of them by score
        sql: "SELECT {{posts}}.* FROM {{posts}} WHERE [[author]] = {:a} AND [[score]] > {:min} ORDER BY [[created]] DESC LIMIT 30",
        params: { a: `author${Math.floor(Math.random() * 1000)}`, min: 50 },
      }),
    },
    count: { next: () => ({ sql: "SELECT COUNT(*) FROM {{posts}}", params: {} }) },
    slow: {
      next: () => ({
        sql: "SELECT {{posts}}.* FROM {{posts}} WHERE [[body]] LIKE {:q} ORDER BY [[created]] DESC LIMIT 30",
        params: { q: "%needle-xyz%" },
      }),
    },
  };
}

// a copy of a pb_data's database files in a new directory under `scratch`
export function copyDataset(dataset: Dataset, source: string, scratch: string): string {
  const dir = mkdtempSync(join(scratch, `${dataset}-`));
  for (const name of ["data.db", "auxiliary.db"]) {
    cpSync(join(source, name), join(dir, name));
  }
  return dir;
}

// the pb_data copy in `dir` opened with `workers` read workers (0: main thread)
export function openTarget(dataset: Dataset, dir: string, workers: number): Target {
  const app = Databases.open({ dataDir: dir, readWorkers: workers });
  const workloads = workloadsFor(dataset, app);
  const run =
    workers === 0
      ? (name: WorkloadName) => {
          const { sql, params } = workloads[name].next();
          return app.concurrentDB().newQuery(sql).bind(params).all();
        }
      : (name: WorkloadName) => {
          const { sql, params } = workloads[name].next();
          return app.concurrentDB().newQuery(sql).bind(params).allAsync();
        };
  return {
    dataset,
    dir,
    app,
    workloads,
    run,
    close: async () => {
      app.close();
      await app.closed();
    },
  };
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

export function summarize(samples: number[]): { n: number; p50: number; p95: number; p99: number } {
  const sorted = samples.toSorted((a, b) => a - b);
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
}

export function memAvailableMiB(): number {
  const m = /MemAvailable:\s+(\d+) kB/.exec(readFileSync("/proc/meminfo", "utf8"));
  return m ? Number(m[1]) / 1024 : Number.POSITIVE_INFINITY;
}

// stops the run when the host is short of memory or the process is too big
export function guard(): void {
  const rss = process.memoryUsage().rss / 2 ** 20;
  const avail = memAvailableMiB();
  if (rss > 2048 || avail < 2048) {
    throw new Error(`stopping: rss ${rss.toFixed(0)} MiB, MemAvailable ${avail.toFixed(0)} MiB`);
  }
}
