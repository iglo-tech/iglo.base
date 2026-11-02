// Requests per second, latency and memory of a read route with request logs
// on, for docs/perf/M5.5-logs.md. Each server runs on its own copy of the
// fixture, one at a time; the clients are keep-alive fetches in this process.
//
// bun test/perf/logs/measure.ts <name>=<binary>... (one per server)

import { Database } from "bun:sqlite";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";
import { setLogsSettings } from "@test/scenarios/logs";
import { tempDir } from "@test/support/executable";

const concurrency = 32;
const roundMs = 15_000;
const burstMs = 60_000;
const rounds = 3;
const routes = ["/api/collections/demo2/records?perPage=30", "/api/health"];

function status(pid: number): { rss: number; peak: number } {
  const text = readFileSync(`/proc/${pid}/status`, "utf8");
  const kb = (key: string): number => Number(new RegExp(`${key}:\\s+(\\d+)`).exec(text)?.[1] ?? 0);
  return { rss: kb("VmRSS") / 1024, peak: kb("VmHWM") / 1024 };
}

async function load(url: string, ms: number): Promise<{ rps: number; p50: number; p99: number }> {
  const latencies: number[] = [];
  const end = performance.now() + ms;
  const client = async (): Promise<void> => {
    while (performance.now() < end) {
      const start = performance.now();
      const res = await fetch(url);
      await res.arrayBuffer();
      if (res.status !== 200) {
        throw new Error(`${url}: ${res.status}`);
      }
      latencies.push(performance.now() - start);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, client));
  latencies.sort((a, b) => a - b);
  return {
    rps: latencies.length / (ms / 1000),
    p50: latencies[Math.floor(latencies.length * 0.5)] ?? 0,
    p99: latencies[Math.floor(latencies.length * 0.99)] ?? 0,
  };
}

function median(values: number[]): number {
  return values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
}

async function measure(name: string, binary: string, port: number): Promise<void> {
  const root = tempDir();
  const dataDir = join(root, "pb_data");
  copyDataDir(fixtureDir, dataDir);
  setLogsSettings(dataDir, { maxDays: 7, logIP: true, minLevel: 0 });

  const server = Bun.spawn([binary, "serve", "--http", `127.0.0.1:${port}`, "--dir", dataDir], {
    stdout: "ignore",
    stderr: "ignore",
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (
      await fetch(`${base}/api/health`).then(
        (r) => r.ok,
        () => false,
      )
    ) {
      break;
    }
    await Bun.sleep(100);
  }

  try {
    for (const route of routes) {
      const results = [];
      for (let i = 0; i < rounds; i++) {
        results.push(await load(base + route, roundMs));
      }
      console.log(
        `${name} ${route}: ${median(results.map((r) => r.rps)).toFixed(0)} req/s, p50 ${median(results.map((r) => r.p50)).toFixed(2)} ms, p99 ${median(results.map((r) => r.p99)).toFixed(2)} ms`,
      );
    }

    const before = status(server.pid);
    let maxRss = before.rss;
    const sampler = setInterval(() => {
      maxRss = Math.max(maxRss, status(server.pid).rss);
    }, 200);
    const burst = await load(`${base}${routes[1]}`, burstMs);
    clearInterval(sampler);
    const after = status(server.pid);
    console.log(
      `${name} burst: ${burst.rps.toFixed(0)} req/s for ${burstMs / 1000} s, RSS ${before.rss.toFixed(0)} -> max ${maxRss.toFixed(0)} -> ${after.rss.toFixed(0)} MiB, peak ${after.peak.toFixed(0)} MiB`,
    );
  } finally {
    server.kill("SIGTERM");
    await server.exited;
  }

  const db = new Database(join(dataDir, "auxiliary.db"), { readonly: true });
  const row = db.query("SELECT count(*) AS n FROM _logs").get() as { n: number };
  db.close();
  console.log(`${name}: ${row.n} rows in _logs`);
  rmSync(root, { recursive: true, force: true });
}

let port = 18790;
for (const arg of process.argv.slice(2)) {
  const [name, binary] = arg.split("=");
  await measure(name!, binary!, port++);
}
