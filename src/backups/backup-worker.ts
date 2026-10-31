// Upstream: none. The thread of a running backup or restore
// (src/backups/worker-client.ts): the VACUUM INTO copies, the compression and
// the zip reads and writes run here, so they never hold the event loop.
//
// `bun build --compile` needs this file as an entry point of its own
// (package.json "build").

import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";

import type { BackupRequest, BackupResponse } from "@/backups/worker-client";
import { extract } from "@/tools/archive/extract";
import { ZipWriter } from "@/tools/archive/zip-writer";

declare const self: Worker;

// the checkpoint waits this long for readers: a write on the main thread
// waits behind it
const checkpointBusyMs = 1000;

let zipper: ZipWriter | null = null;

function openZip(): ZipWriter {
  if (zipper === null) {
    throw new Error("zip writer is already closed");
  }
  return zipper;
}

// A short-lived connection that only reads the source: VACUUM INTO writes
// the copy and leaves the database as it was.
function vacuumInto(src: string, dest: string): void {
  // what a failed earlier copy left behind
  rmSync(dest, { force: true });

  const conn = new Database(src, { readwrite: true });
  try {
    conn.run("PRAGMA busy_timeout=10000");
    conn.query("VACUUM INTO ?").run(dest);
  } finally {
    conn.close();
  }
}

// errors are ignored: a checkpoint held up by a reader only postpones the
// WAL's truncation
function checkpoint(path: string): void {
  const conn = new Database(path, { readwrite: true });
  try {
    conn.run(`PRAGMA busy_timeout=${checkpointBusyMs}`);
    conn.query("PRAGMA wal_checkpoint(TRUNCATE)").all();
  } catch {
    // see above
  } finally {
    conn.close();
  }
}

async function handle(req: BackupRequest): Promise<boolean | undefined> {
  switch (req.op) {
    case "vacuum":
      vacuumInto(req.src, req.dest);
      return undefined;
    case "checkpoint":
      checkpoint(req.path);
      return undefined;
    case "zipOpen":
      zipper = new ZipWriter(req.path);
      return undefined;
    case "zipAdd":
      return openZip().addFile(req.localPath, req.zipPath);
    case "zipClose":
      openZip().close();
      zipper = null;
      return undefined;
    case "extract":
      await extract(req.src, req.dest);
      return undefined;
  }
}

self.addEventListener("message", async (event: MessageEvent<BackupRequest>) => {
  const { id } = event.data;
  let res: BackupResponse;
  try {
    res = { id, ok: true, value: await handle(event.data) };
  } catch (err) {
    res = {
      id,
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      code: (err as { code?: string } | null)?.code ?? null,
    };
  }
  // a Worker's postMessage has no target origin (that is window.postMessage)
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  self.postMessage(res);
});
