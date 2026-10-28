// M0.6 spike (D8): the read workloads under HTTP load. A server process
// (Bun.serve, this file with "serve") runs one workload per request, on
// the main thread or the read pool; this process (the client) keeps 8
// workload requests outstanding and meanwhile sends a trivial request
// (/health) every 10 ms, one at a time. Not shipped.
//
//   nice -n 10 bun test/perf/read-path/http.ts --fixture <pb_data> --big <pb_data> \
//     --scratch <dir> [--modes 0,2,4,6] [--seconds 3] > result.json
//
// Reported per cell: workload request latency and throughput, /health
// latency, and the server's RSS after warming (VmRSS).

import { readFileSync, rmSync } from "node:fs";
import { parseArgs } from "node:util";

import {
  copyDataset,
  guard,
  openTarget,
  summarize,
  workloadNames,
  type Dataset,
  type WorkloadName,
} from "@test/perf/read-path/workloads";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    fixture: { type: "string" },
    big: { type: "string" },
    scratch: { type: "string" },
    dataset: { type: "string" },
    dir: { type: "string" },
    workers: { type: "string" },
    modes: { type: "string", default: "0,2,4,6" },
    seconds: { type: "string", default: "3" },
  },
});

if (positionals[0] === "serve") {
  const target = openTarget(values.dataset as Dataset, values.dir!, Number(values.workers));
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    routes: {
      "/health": () => new Response("ok"),
      "/q/:w": async (req) => {
        const rows = (await target.run(req.params.w as WorkloadName)) as unknown[];
        return Response.json({ rows: rows.length });
      },
    },
  });
  console.log(server.port);
} else {
  await client();
}

async function client(): Promise<void> {
  const modes = values.modes!.split(",").map(Number);
  const seconds = Number(values.seconds);
  const results: unknown[] = [];
  const datasets: [Dataset, string | undefined][] = [
    ["fixture", values.fixture],
    ["1m", values.big],
  ];
  for (const [dataset, source] of datasets) {
    if (source === undefined) continue;
    const dir = copyDataset(dataset, source, values.scratch!);
    try {
      for (const workers of modes) {
        guard();
        const proc = Bun.spawn(
          [
            "nice",
            "-n",
            "10",
            process.execPath,
            import.meta.path,
            "serve",
            "--dataset",
            dataset,
            "--dir",
            dir,
            "--workers",
            String(workers),
          ],
          { stdout: "pipe", stderr: "inherit" },
        );
        try {
          const reader = proc.stdout.getReader();
          const { value } = await reader.read();
          const url = `http://127.0.0.1:${new TextDecoder().decode(value).trim()}`;
          // warm every worker's connections
          for (let i = 0; i < 3; i++) {
            for (const name of workloadNames) {
              await Promise.all(
                Array.from({ length: Math.max(1, workers) }, () =>
                  fetch(`${url}/q/${name}`).then((r) => r.text()),
                ),
              );
            }
          }
          const rssMiB =
            Number(/VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${proc.pid}/status`, "utf8"))![1]) /
            1024;
          const cells: Record<string, unknown> = {};
          for (const name of workloadNames) {
            guard();
            const ms = (name === "slow" ? 2 : 1) * seconds * 1000;
            cells[name] = await load(url, name, ms);
            const c = cells[name] as { q: { p50: number }; qps: number; health: { p99: number } };
            console.error(
              `${dataset} workers=${workers} ${name}: q p50 ${c.q.p50.toFixed(2)} ms, ${c.qps.toFixed(0)} req/s, health p99 ${c.health.p99.toFixed(1)} ms`,
            );
          }
          results.push({ dataset, workers, rssMiB, workloads: cells });
        } finally {
          proc.kill();
          await proc.exited;
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  console.log(JSON.stringify({ bun: Bun.version, results }, null, 2));
}

async function load(url: string, name: string, ms: number) {
  const q: number[] = [];
  const health: number[] = [];
  const end = performance.now() + ms;
  const start = performance.now();
  const loops = Array.from({ length: 8 }, async () => {
    while (performance.now() < end) {
      const t = performance.now();
      const res = await fetch(`${url}/q/${name}`);
      await res.text();
      if (!res.ok) throw new Error(`${name}: ${res.status}`);
      q.push(performance.now() - t);
    }
  });
  const probe = (async () => {
    while (performance.now() < end) {
      const t = performance.now();
      await (await fetch(`${url}/health`)).text();
      health.push(performance.now() - t);
      await Bun.sleep(10);
    }
  })();
  await Promise.all([...loops, probe]);
  const elapsed = performance.now() - start;
  return { q: summarize(q), qps: (q.length / elapsed) * 1000, health: summarize(health) };
}
