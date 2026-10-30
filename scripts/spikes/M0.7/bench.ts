// M0.7 spike: the measured executable. Not shipped.
//
// run.ts compiles this file with one workers/worker-<candidate>.ts entry
// into its own executable (bun build --compile), so every candidate is
// measured as M5.2 would ship it: inside a compiled executable, in Bun
// Workers. Usage: bench-<candidate> <candidate> <jobs.json>, where the jobs
// file is { concurrency, jobs: Job[] }. The workers are started and warmed,
// then the jobs run on them, at most `concurrency` at once. The result is
// written to <jobs.json>.result.json, not stdout, which the WebAssembly
// codecs may take over: per-job results, wall time, and this process's
// VmRSS before the jobs and VmHWM (peak RSS) at the end. The process's
// threads include the workers, so the peak covers them.

import { readFileSync, writeFileSync } from "node:fs";

import type { Job, JobResult } from "@/../scripts/spikes/M0.7/workers/serve";

const [candidate, jobsPath] = process.argv.slice(2);
if (!candidate || !jobsPath) {
  throw new Error("usage: bench <candidate> <jobs.json>");
}
const { concurrency, jobs } = JSON.parse(readFileSync(jobsPath, "utf8")) as {
  concurrency: number;
  jobs: Job[];
};

const statusKiB = (key: string): number => {
  const m = new RegExp(`${key}:\\s+(\\d+) kB`).exec(readFileSync("/proc/self/status", "utf8"));
  return m ? Number(m[1]) : 0;
};

const workers = Array.from(
  { length: concurrency },
  () => new Worker(`./workers/worker-${candidate}.ts`),
);

// one request to a worker and its one answer
function call<T>(w: Worker, message: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onMessage = (e: MessageEvent<T>): void => {
      w.removeEventListener("error", onError);
      resolve(e.data);
    };
    const onError = (e: ErrorEvent): void => {
      w.removeEventListener("message", onMessage);
      reject(new Error(e.message));
    };
    w.addEventListener("message", onMessage, { once: true });
    w.addEventListener("error", onError, { once: true });
    // a Worker's postMessage has no target origin (that is window.postMessage)
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    w.postMessage(message);
  });
}

const warmMs = await Promise.all(
  workers.map(async (w) => (await call<{ warmMs: number }>(w, "warm")).warmMs),
);
Bun.gc(true);
const rssBeforeMiB = statusKiB("VmRSS") / 1024;

const queue = [...jobs];
const results: JobResult[] = [];
const started = performance.now();
await Promise.all(
  workers.map(async (w) => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const current = job;
      results.push(
        await call<JobResult>(w, current).catch((err: unknown) => ({
          id: current.id,
          ms: 0,
          error: `worker error: ${String(err)}`,
        })),
      );
    }
  }),
);
const wallMs = performance.now() - started;
writeFileSync(
  `${jobsPath}.result.json`,
  JSON.stringify({
    candidate,
    concurrency,
    warmMs,
    rssBeforeMiB,
    hwmMiB: statusKiB("VmHWM") / 1024,
    wallMs,
    results: results.toSorted((a, b) => a.id - b.id),
  }),
);
process.exit(0);
