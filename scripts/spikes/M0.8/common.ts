// M0.8 spikes: shared helpers. Not shipped; needs `bun run upstream:prepare`.
//
// Servers are started directly (not through test/support) so that the
// spikes can read their /proc counters: resident memory (VmRSS), its peak
// (VmHWM) and open file descriptors. Every spike keeps its data in one
// temporary root on disk (not /tmp, which is a tmpfs on this host and
// would count spilled request bodies as memory) and removes it at the end.

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { freePort } from "@test/support/executable";
import { defaultLayout, requireTool } from "@test/support/reference-tools";

export const repoRoot = resolve(import.meta.dir, "../../..");

// A temporary root under the ignored dist/spike-tmp directory.
// TMPDIR points into it for this process and the servers it starts, so
// spilled request bodies and builds land on disk and are removed with it.
export function spikeRoot(name: string): { root: string; tmp: string; cleanup(): void } {
  const base = join(repoRoot, "dist", "spike-tmp");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, `${name}-`));
  const tmp = join(root, "tmp");
  mkdirSync(tmp);
  process.env.TMPDIR = tmp;
  return {
    root,
    tmp,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
      try {
        rmSync(base);
      } catch {
        // other spike roots are still there
      }
    },
  };
}

// MemAvailable in MiB
export function memAvailableMiB(): number {
  const m = /MemAvailable:\s+(\d+) kB/.exec(readFileSync("/proc/meminfo", "utf8"));
  return m ? Number(m[1]) / 1024 : 0;
}

// Throws when the host has less than minMiB available, so that a
// measurement stops before it pushes the host into swap.
export function guardMemory(minMiB = 2048): void {
  const avail = memAvailableMiB();
  if (avail < minMiB) {
    throw new Error(`MemAvailable ${avail.toFixed(0)} MiB < ${minMiB} MiB, stopping`);
  }
}

export interface ProcStats {
  rssMiB: number;
  hwmMiB: number;
  threads: number;
  fds: number;
}

export function procStats(pid: number): ProcStats {
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  const kb = (key: string): number => {
    const m = new RegExp(`${key}:\\s+(\\d+) kB`).exec(status);
    return m ? Number(m[1]) / 1024 : 0;
  };
  const threads = Number(/Threads:\s+(\d+)/.exec(status)?.[1] ?? 0);
  return {
    rssMiB: kb("VmRSS"),
    hwmMiB: kb("VmHWM"),
    threads,
    fds: readdirSync(`/proc/${pid}/fd`).length,
  };
}

// Samples VmRSS every intervalMs and keeps the maximum, as a cross-check of
// VmHWM. When MemAvailable drops below minMiB it stops sampling and calls
// onLowMemory once, which must end the measurement at once (kill the server).
export function sampler(pid: number, onLowMemory: () => void, intervalMs = 20, minMiB = 1536) {
  let peak = 0;
  let lowMem = false;
  const timer = setInterval(() => {
    try {
      peak = Math.max(peak, procStats(pid).rssMiB);
    } catch {
      // the process is gone
    }
    if (!lowMem && memAvailableMiB() < minMiB) {
      lowMem = true;
      clearInterval(timer);
      onLowMemory();
    }
  }, intervalMs);
  return {
    get lowMem(): boolean {
      return lowMem;
    },
    stop(): { peakMiB: number; lowMem: boolean } {
      clearInterval(timer);
      return { peakMiB: peak, lowMem };
    },
  };
}

export interface Server {
  url: string;
  port: number;
  pid: number;
  output(): string;
  stop(): Promise<void>;
}

async function spawnServer(
  command: string[],
  cwd: string,
  env: Record<string, string>,
  port: number,
): Promise<Server> {
  const proc = Bun.spawn(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1", ...env },
  });
  let output = "";
  const decoder = new TextDecoder();
  const collect = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    for await (const chunk of stream) {
      // keep only the tail: realtime debug output can be large
      output = (output + decoder.decode(chunk, { stream: true })).slice(-20_000);
    }
  };
  const readers = Promise.all([collect(proc.stdout), collect(proc.stderr)]);
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) {
        break;
      }
    } catch {
      // not listening yet
    }
    if (proc.exitCode !== null || Date.now() > deadline) {
      proc.kill("SIGKILL");
      throw new Error(`server did not start: ${command.join(" ")}\n${output}`);
    }
    await Bun.sleep(50);
  }
  return {
    url,
    port,
    pid: proc.pid,
    output: () => output,
    async stop() {
      if (proc.exitCode === null) {
        proc.kill("SIGTERM");
        const timer = setTimeout(() => proc.kill("SIGKILL"), 5_000);
        await proc.exited;
        clearTimeout(timer);
      }
      await readers;
    },
  };
}

export function upstreamBinary(): string {
  return requireTool("pocketbase", defaultLayout);
}

// upstream `serve` with no-op `open`/`xdg-open` (its installer launches a
// browser on a pb_data without superusers; the spikes always create one)
export async function startUpstreamServer(dataDir: string, root: string): Promise<Server> {
  const noBrowser = join(root, "no-browser");
  mkdirSync(noBrowser, { recursive: true });
  for (const name of ["open", "xdg-open"]) {
    writeFileSync(join(noBrowser, name), "#!/bin/sh\nexit 0\n");
    chmodSync(join(noBrowser, name), 0o755);
  }
  const port = await freePort();
  return spawnServer(
    [upstreamBinary(), "serve", "--http", `127.0.0.1:${port}`, "--dir", dataDir],
    root,
    { PATH: `${noBrowser}:${process.env.PATH ?? ""}` },
    port,
  );
}

let built: string | undefined;

// the iglo.base executable, compiled once into the spike root
export async function igloExecutable(root: string): Promise<string> {
  if (built) {
    return built;
  }
  const outfile = join(root, "iglo-base");
  const proc = Bun.spawn(
    [
      process.execPath,
      "build",
      "--compile",
      "src/main.ts",
      "src/db/read-worker.ts",
      "--outfile",
      outfile,
    ],
    { cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
  );
  if ((await proc.exited) !== 0) {
    throw new Error(`build failed:\n${await new Response(proc.stderr).text()}`);
  }
  built = outfile;
  return outfile;
}

export async function startIgloServer(dataDir: string, root: string): Promise<Server> {
  const port = await freePort();
  return spawnServer(
    [await igloExecutable(root), "serve", "--http", `127.0.0.1:${port}`, "--dir", dataDir],
    root,
    {},
    port,
  );
}

export async function upsertSuperuser(
  dataDir: string,
  root: string,
  email: string,
  password: string,
): Promise<void> {
  const proc = Bun.spawn(
    [upstreamBinary(), "superuser", "upsert", email, password, "--dir", dataDir],
    {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if ((await proc.exited) !== 0) {
    throw new Error(`superuser upsert failed: ${await new Response(proc.stderr).text()}`);
  }
}

// A JSON API client for one server; `token` is sent as Authorization.
export function apiClient(url: string) {
  let token = "";
  const call = async (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> => {
    const res = await fetch(url + path, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text === "" ? null : JSON.parse(text) };
  };
  return {
    call,
    async must(method: string, path: string, body?: unknown): Promise<unknown> {
      const r = await call(method, path, body);
      if (r.status >= 300) {
        throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(r.json)}`);
      }
      return r.json;
    },
    async loginSuperuser(identity: string, password: string): Promise<void> {
      const r = await call("POST", "/api/collections/_superusers/auth-with-password", {
        identity,
        password,
      });
      if (r.status !== 200) {
        throw new Error(`superuser login: ${r.status} ${JSON.stringify(r.json)}`);
      }
      token = (r.json as { token: string }).token;
    },
  };
}

export function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) {
    return Number.NaN;
  }
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number;
}

export function hostFacts(): string {
  const cpu = /model name\s*:\s*(.+)/.exec(readFileSync("/proc/cpuinfo", "utf8"))?.[1] ?? "?";
  const total = /MemTotal:\s+(\d+) kB/.exec(readFileSync("/proc/meminfo", "utf8"))?.[1] ?? "0";
  return `bun ${Bun.version}, ${cpu}, MemTotal ${(Number(total) / 1024 / 1024).toFixed(1)} GiB, MemAvailable ${(memAvailableMiB() / 1024).toFixed(1)} GiB`;
}
