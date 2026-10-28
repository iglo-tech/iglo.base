// M0.6 spike (D8): the read workloads alone, in one process: main-thread
// reads against read pools of several sizes. Not shipped.
//
//   nice -n 10 bun test/perf/read-path/bench.ts --fixture <pb_data> --big <pb_data> \
//     --scratch <dir> [--modes 0,2,4,6] [--seconds 2] > result.json
//
// Per dataset (copied once into --scratch, removed afterwards) and mode:
// - latency: one query at a time for --seconds (the slow workload 1.5x);
// - throughput: 8 queries outstanding for --seconds;
// - event-loop lag: a 5 ms timer's lateness while the throughput phase runs;
// - hop: "SELECT 1" latency (the pool's cost per query, minus main's);
// - memory: RSS after warming every worker's connections.

import { rmSync } from "node:fs";
import { parseArgs } from "node:util";

import {
  copyDataset,
  guard,
  memAvailableMiB,
  openTarget,
  summarize,
  workloadNames,
  type Dataset,
  type Target,
  type WorkloadName,
} from "@test/perf/read-path/workloads";

const { values } = parseArgs({
  options: {
    fixture: { type: "string" },
    big: { type: "string" },
    scratch: { type: "string" },
    modes: { type: "string", default: "0,2,4,6" },
    seconds: { type: "string", default: "2" },
  },
});
const modes = values.modes!.split(",").map(Number);
const seconds = Number(values.seconds);
const scratch = values.scratch!;
const concurrency = 8;

async function latency(target: Target, run: () => unknown, ms: number): Promise<number[]> {
  const samples: number[] = [];
  const end = performance.now() + ms;
  while (performance.now() < end) {
    const t = performance.now();
    await run();
    samples.push(performance.now() - t);
  }
  return samples;
}

async function throughput(
  run: () => unknown,
  ms: number,
): Promise<{ qps: number; lag: ReturnType<typeof summarize> }> {
  let done = 0;
  const lags: number[] = [];
  let expected = performance.now() + 5;
  const timer = setInterval(() => {
    const now = performance.now();
    lags.push(Math.max(0, now - expected));
    expected = now + 5;
  }, 5);
  const start = performance.now();
  const end = start + ms;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (performance.now() < end) {
        await run();
        done++;
        // let timers run between queries, as an HTTP server's event loop would
        await new Promise((r) => setImmediate(r));
      }
    }),
  );
  const elapsed = performance.now() - start;
  clearInterval(timer);
  return { qps: (done / elapsed) * 1000, lag: summarize(lags) };
}

const results: unknown[] = [];
const datasets: [Dataset, string | undefined][] = [
  ["fixture", values.fixture],
  ["1m", values.big],
];
for (const [dataset, source] of datasets) {
  if (source === undefined) continue;
  const dir = copyDataset(dataset, source, scratch);
  try {
    for (const workers of modes) {
      guard();
      const rssBefore = process.memoryUsage().rss;
      const target = openTarget(dataset, dir, workers);
      try {
        // warm every worker's connections and the page cache
        for (let i = 0; i < 3; i++) {
          for (const name of workloadNames) {
            await Promise.all(Array.from({ length: Math.max(1, workers) }, () => target.run(name)));
          }
        }
        Bun.gc(true);
        const rss = process.memoryUsage().rss;
        const ping =
          workers === 0
            ? () => target.app.concurrentDB().newQuery("SELECT 1").all()
            : () => target.app.concurrentDB().newQuery("SELECT 1").allAsync();
        const hop = summarize(await latency(target, ping, 1000));
        const cells: Record<string, unknown> = {};
        for (const name of workloadNames) {
          guard();
          const ms = (name === "slow" ? 1.5 : 1) * seconds * 1000;
          const run = () => target.run(name as WorkloadName);
          const lat = summarize(await latency(target, run, ms));
          const tp = await throughput(run, ms);
          cells[name] = { latency: lat, qps: tp.qps, lag: tp.lag };
          console.error(
            `${dataset} workers=${workers} ${name}: p50 ${lat.p50.toFixed(3)} ms, ${tp.qps.toFixed(0)} q/s, lag p99 ${tp.lag.p99.toFixed(1)} ms`,
          );
        }
        results.push({
          dataset,
          workers,
          rssMiB: rss / 2 ** 20,
          rssDeltaMiB: (rss - rssBefore) / 2 ** 20,
          memAvailableMiB: memAvailableMiB(),
          hop,
          workloads: cells,
        });
      } finally {
        await target.close();
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log(JSON.stringify({ bun: Bun.version, sqlite: undefined, results }, null, 2));
