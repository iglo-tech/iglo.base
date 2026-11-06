// Upstream: none (src/backups/worker-client.ts is iglo.base's own).
//
// A stopped worker answers no call: every later call rejects at once instead
// of waiting for a reply that never comes (which would keep the backup flag
// set and refuse every later backup and restore).

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BackupWorker } from "@/backups/worker-client";

const dirs: string[] = [];
const workers: BackupWorker[] = [];

afterEach(() => {
  for (const w of workers.splice(0)) {
    w.close();
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function start(): BackupWorker {
  const w = new BackupWorker();
  workers.push(w);
  return w;
}

// the paths the process holds open
function openPaths(): string[] {
  const paths: string[] = [];
  for (const fd of readdirSync("/proc/self/fd")) {
    try {
      paths.push(readlinkSync(join("/proc/self/fd", fd)));
    } catch {
      // closed meanwhile
    }
  }
  return paths;
}

describe("BackupWorker", () => {
  test("a call after close rejects at once", async () => {
    const w = start();
    await w.call({ op: "zipAbort" });
    w.close();

    await expect(w.call({ op: "zipAbort" })).rejects.toThrow("the backup worker was stopped");
    // closing again keeps the state
    w.close();
    await expect(w.call({ op: "zipAbort" })).rejects.toThrow("the backup worker was stopped");
  });

  test("a call in flight when the worker closes rejects, and so do the next ones", async () => {
    const w = start();
    const dir = mkdtempSync(join(tmpdir(), "iglo-worker-"));
    dirs.push(dir);

    const inflight = w.call({ op: "zipOpen", path: join(dir, "a.zip") });
    w.close();

    await expect(inflight).rejects.toThrow("the backup worker was stopped");
    await expect(w.call({ op: "zipAbort" })).rejects.toThrow("the backup worker was stopped");
  });

  test("zipOpen closes the writer an earlier zipOpen left open", async () => {
    const w = start();
    const dir = mkdtempSync(join(tmpdir(), "iglo-worker-"));
    dirs.push(dir);
    const first = join(dir, "first.zip");
    const second = join(dir, "second.zip");

    await w.call({ op: "zipOpen", path: first });
    expect(openPaths()).toContain(first);

    await w.call({ op: "zipOpen", path: second });
    expect(openPaths()).not.toContain(first);
    expect(openPaths()).toContain(second);

    await w.call({ op: "zipAbort" });
    expect(openPaths()).not.toContain(second);
  });
});
