// R.1 spike (throwaway): starts one iglo.base primary and N read-only replicas
// (scripts/spikes/R.1/replica.ts) on one public port, and stops them all.
//
// N = 0: the primary alone on the public port (today's server, TCP).
// N >= 1: the primary on a Unix socket in a private mktemp -d directory; the
// replicas share the public port with SO_REUSEPORT.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { freePort } from "@test/support/executable";
import { repoRoot } from "@/../scripts/spikes/M0.8/common";

export interface Cluster {
  // the public URL every client uses
  url: string;
  // the primary first, then the replicas
  pids: number[];
  // the primary's Unix socket (N >= 1), for requests that bypass the replicas
  socket: string | undefined;
  // the primary's last stderr output (its tail)
  primaryLog(): string;
  // stops the replicas, then the primary; throws if a process is still alive
  stop(): Promise<void>;
}

export interface ClusterOptions {
  exe: string;
  dataDir: string;
  cwd: string;
  replicas: number;
  readyTimeoutMs?: number;
}

const replicaSource = join(repoRoot, "scripts/spikes/R.1/replica.ts");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// keeps the tail of a stream, so a failed start can say why
async function tailOf(stream: ReadableStream<Uint8Array>, keep: { text: string }): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    keep.text = (keep.text + decoder.decode(chunk, { stream: true })).slice(-8_000);
  }
}

async function waitFor(
  check: () => Promise<boolean>,
  what: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await Bun.sleep(20);
  }
}

export async function startCluster(o: ClusterOptions): Promise<Cluster> {
  const timeout = o.readyTimeoutMs ?? 30_000;
  const dir = o.replicas > 0 ? mkdtempSync(join(tmpdir(), "iglo-r1-")) : undefined;
  const sock = dir === undefined ? undefined : join(dir, "primary.sock");
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const primaryErr = { text: "" };
  const replicas: ReturnType<typeof Bun.spawn>[] = [];
  let primary: ReturnType<typeof Bun.spawn> | undefined;
  let stopped = false;

  const stop = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    stopped = true;
    const procs = [...replicas, ...(primary ? [primary] : [])];
    for (const p of procs) {
      if (p.exitCode === null) {
        p.kill("SIGTERM");
      }
    }
    for (const p of procs) {
      const timer = setTimeout(() => p.kill("SIGKILL"), 8_000);
      await p.exited;
      clearTimeout(timer);
    }
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
    const survivors = procs.map((p) => p.pid).filter(alive);
    if (survivors.length > 0) {
      throw new Error(`processes still running after stop: ${survivors.join(", ")}`);
    }
  };

  try {
    const primaryArgs = [
      o.exe,
      "serve",
      "--http",
      sock === undefined ? `127.0.0.1:${port}` : `unix:${sock}`,
      "--dir",
      o.dataDir,
      "--automigrate=false",
    ];
    primary = Bun.spawn(primaryArgs, {
      cwd: o.cwd,
      stdout: "ignore",
      stderr: "pipe",
      env: { ...process.env, NO_COLOR: "1" },
    });
    const primaryProc = primary;
    void tailOf(primaryProc.stderr as ReadableStream<Uint8Array>, primaryErr);

    const primaryUp = async (): Promise<boolean> => {
      if (primaryProc.exitCode !== null) {
        throw new Error(`primary exited: ${primaryErr.text}`);
      }
      try {
        const res =
          sock === undefined
            ? await fetch(`${url}/api/health`)
            : await fetch("http://primary/api/health", { unix: sock });
        return res.ok;
      } catch {
        return false;
      }
    };
    await waitFor(primaryUp, "the primary", timeout);

    for (let i = 0; i < o.replicas; i++) {
      const proc = Bun.spawn(
        [
          process.execPath,
          replicaSource,
          "--socket",
          sock as string,
          "--local",
          join(dir as string, `replica-${i}.sock`),
          "--http",
          `127.0.0.1:${port}`,
          "--dir",
          o.dataDir,
        ],
        { cwd: repoRoot, stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1" } },
      );
      replicas.push(proc);
      const out = { text: "" };
      void tailOf(proc.stdout as ReadableStream<Uint8Array>, out);
      const errs = { text: "" };
      void tailOf(proc.stderr as ReadableStream<Uint8Array>, errs);
      await waitFor(
        async () => {
          if (proc.exitCode !== null) {
            throw new Error(`replica exited: ${errs.text}`);
          }
          return out.text.includes("replica ready");
        },
        `replica ${i + 1}`,
        timeout,
      );
    }

    await waitFor(
      async () => {
        try {
          return (await fetch(`${url}/api/health`)).ok;
        } catch {
          return false;
        }
      },
      "the public port",
      timeout,
    );

    return {
      url,
      socket: sock,
      pids: [primaryProc.pid, ...replicas.map((r) => r.pid)],
      primaryLog: () => primaryErr.text,
      stop,
    };
  } catch (err) {
    await stop();
    throw err;
  }
}
