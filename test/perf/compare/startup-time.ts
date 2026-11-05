// P.3: time from process start to the first /api/health 200 on a copy of a
// pb_data (see startup-db.ts), one server at a time, median of --repeat.
//
//   bun test/perf/compare/startup-time.ts <pb_data> [--exe dist/iglo-base] [--repeat 7] [--upstream]

import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { repoRoot, upstreamBinary } from "@/../scripts/spikes/M0.8/common";
import { freePort } from "@test/support/executable";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    exe: { type: "string", default: join(repoRoot, "dist/iglo-base") },
    repeat: { type: "string", default: "7" },
    upstream: { type: "boolean", default: false },
  },
});
const src = positionals[0]!;
const exe = values.upstream ? upstreamBinary() : values.exe!;
const times: number[] = [];
const cpus: number[] = [];
const root = mkdtempSync(join(repoRoot, "dist", "startup-"));
try {
  for (let i = 0; i < Number(values.repeat); i++) {
    const dir = join(root, `d${i}`, "pb_data");
    cpSync(src, dir, { recursive: true });
    const port = await freePort();
    const t0 = performance.now();
    const proc = Bun.spawn(
      [
        exe,
        "serve",
        "--http",
        `127.0.0.1:${port}`,
        "--dir",
        dir,
        ...(values.upstream ? [] : ["--automigrate=false"]),
      ],
      { cwd: root, stdout: "ignore", stderr: "ignore", env: { ...process.env, NO_COLOR: "1" } },
    );
    for (;;) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break;
      } catch {}
      await Bun.sleep(2);
    }
    times.push(performance.now() - t0);
    proc.kill("SIGTERM");
    await proc.exited;
    const ru = proc.resourceUsage();
    if (ru) cpus.push(Number(ru.cpuTime.user + ru.cpuTime.system) / 1000);
    rmSync(join(root, `d${i}`), { recursive: true, force: true });
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
times.sort((a, b) => a - b);
cpus.sort((a, b) => a - b);
console.log(
  `${values.upstream ? "upstream" : "iglo.base"} startup ms: median ${times[Math.floor(times.length / 2)]!.toFixed(0)}, min ${times[0]!.toFixed(0)}, max ${times.at(-1)!.toFixed(0)}, CPU ms median ${(cpus[Math.floor(cpus.length / 2)] ?? 0).toFixed(0)} (to exit, so includes shutdown), load ${await Bun.file(
    "/proc/loadavg",
  )
    .text()
    .then((t) => t.split(" ")[0])}`,
);
