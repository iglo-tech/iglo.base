// M5.7: static files from --publicDir, the SPA fallback, CORS and a records
// list over HTTP: upstream PocketBase v0.41.0, the iglo.base executable of
// this tree and, with --before, an executable built from an earlier commit.
// Not shipped; needs `bun run upstream:prepare`.
//
//   nice -n 10 bun test/perf/serve/bench.ts [--requests 5000] [--concurrency 8] [--before <executable>]
//
// Every server gets its own copy of the vendored fixture and the same
// pb_public (a 4 KiB script, a 1 MiB image and an index.html), one server
// at a time. Each workload runs as a guest: --requests requests (after 500
// warm-up requests) with --concurrency requests in flight over keep-alive
// connections. Prints requests/s and the p50/p99 latency per workload.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";
import { freePort, startServer, tempDir } from "@test/support/executable";
import { startUpstream } from "@test/support/upstream";

const { values } = parseArgs({
  options: {
    requests: { type: "string", default: "5000" },
    concurrency: { type: "string", default: "8" },
    before: { type: "string" },
  },
});
const totalRequests = Number(values.requests);
const concurrency = Number(values.concurrency);

interface Workload {
  name: string;
  path: string;
  headers?: Record<string, string>;
  // the status an executable without --publicDir answers (before M5.7)
  status?: number;
}

const workloads: Workload[] = [
  { name: "static 4 KiB script", path: "/app.js" },
  { name: "static 1 MiB image", path: "/photo.png" },
  { name: "SPA fallback (missing path)", path: "/some/route" },
  { name: "list 30 (demo2)", path: "/api/collections/demo2/records?perPage=30" },
  {
    name: "list 30, with an Origin",
    path: "/api/collections/demo2/records?perPage=30",
    headers: { Origin: "https://example.com" },
  },
];

async function run(
  baseUrl: string,
  w: Workload,
  n: number,
): Promise<{ rps: number; p50: number; p99: number; status: number }> {
  const latencies: number[] = [];
  let next = 0;
  let status = 0;
  const started = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < n) {
        next++;
        const t0 = performance.now();
        const res = await fetch(baseUrl + w.path, { headers: w.headers });
        await res.arrayBuffer();
        status = res.status;
        latencies.push(performance.now() - t0);
      }
    }),
  );
  const elapsed = (performance.now() - started) / 1000;
  latencies.sort((a, b) => a - b);
  const at = (q: number): number =>
    latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))] as number;
  return { rps: n / elapsed, p50: at(0.5), p99: at(0.99), status };
}

// an executable from an earlier commit, started as startServer starts this one
async function startBefore(
  executable: string,
  dataDir: string,
  publicDir: string,
): Promise<{ url: string; stop(): Promise<void> }> {
  const port = await freePort();
  const proc = Bun.spawn(
    [
      executable,
      "serve",
      "--http",
      `127.0.0.1:${port}`,
      "--dir",
      dataDir,
      "--automigrate=false",
      "--publicDir",
      publicDir,
    ],
    { cwd: tempDir(), stdout: "ignore", stderr: "ignore", env: { ...process.env, NO_COLOR: "1" } },
  );
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${url}/api/health`)).ok) {
        break;
      }
    } catch {
      // not listening yet
    }
    await Bun.sleep(100);
  }
  return {
    url,
    async stop() {
      proc.kill();
      await proc.exited;
    },
  };
}

const root = tempDir();
try {
  const pub = join(root, "pb_public");
  mkdirSync(join(pub, "some"), { recursive: true });
  writeFileSync(join(pub, "index.html"), "<!doctype html><title>bench</title>");
  writeFileSync(join(pub, "app.js"), "x".repeat(4096));
  const png = new Uint8Array(1 << 20);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  writeFileSync(join(pub, "photo.png"), png);

  const targets = ["upstream", "iglo.base", ...(values.before ? ["before"] : [])];
  const results: string[] = [];
  for (const target of targets) {
    const copy = join(root, target, "pb_data");
    copyDataDir(fixtureDir, copy);
    const server =
      target === "upstream"
        ? await startUpstream({ dataDir: copy, args: ["--publicDir", pub] })
        : target === "iglo.base"
          ? await startServer(["--publicDir", pub], copy)
          : await startBefore(values.before as string, copy, pub);
    try {
      for (const w of workloads) {
        await run(server.url, w, 500);
        const r = await run(server.url, w, totalRequests);
        results.push(
          `| ${w.name} | ${target} | ${r.status} | ${r.rps.toFixed(0)} | ${r.p50.toFixed(2)} ms | ${r.p99.toFixed(2)} ms |`,
        );
      }
    } finally {
      await server.stop();
    }
  }
  console.log("| Workload | Server | Status | Requests/s | p50 | p99 |");
  console.log("|---|---|---|---|---|---|");
  for (const line of results) {
    console.log(line);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
