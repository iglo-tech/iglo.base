// Upstream: none (D31). The thread of the log writer (src/logs/log-writer.ts):
// the batch insert into `_logs` of core/base.go's initLogger writeFunc, run on
// a connection of its own to auxiliary.db (read-write, upstream's pragmas), so
// the main thread only queues the logs. Upstream writes the batch from a
// goroutine too.
//
// A batch is one transaction. A lock held by the main thread (log cleanup,
// VACUUM, backup) is waited for and the batch tried again, up to 12 times
// (about two minutes); after that the batch is dropped. Anything else that
// fails loses the batch, as upstream ignores the error of its write.
//
// `bun build --compile` needs this file as an entry point of its own
// (package.json "build").

import type { Database, Statement } from "bun:sqlite";
import type { MessagePort } from "node:worker_threads";

import { openReadWrite } from "@/db/connect";
import { defaultMaxLockRetries, getDefaultRetryInterval } from "@/db/retry";
import type { LogWorkerRequest, LogWorkerResponse } from "@/logs/log-writer";

declare const self: Worker;

const insertSQL = "INSERT INTO _logs (id, created, level, message, data) VALUES (?, ?, ?, ?, ?)";

let db: Database | null = null;
let done: Int32Array | null = null;
let errors: MessagePort | null = null;

function isLockError(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return text.includes("database is locked") || text.includes("table is locked");
}

function send(res: LogWorkerResponse): void {
  postMessage(res);
}

function writeBatch(conn: Database, rows: LogWorkerRequest & { type: "write" }): void {
  for (let attempt = 1; ; attempt++) {
    try {
      conn.run("BEGIN IMMEDIATE");
      try {
        let insert: Statement | null = null;
        let prepareErr: unknown = null;
        try {
          insert = conn.query(insertSQL);
        } catch (err) {
          if (isLockError(err)) {
            throw err;
          }
          prepareErr = err;
        }
        try {
          for (const row of rows.rows) {
            try {
              if (insert === null) {
                throw prepareErr;
              }
              insert.run(...row);
            } catch (err) {
              if (isLockError(err)) {
                throw err;
              }
              // oxlint-disable-next-line unicorn/require-post-message-target-origin
              errors?.postMessage({ text: `Failed to write log ${row[3]} ${String(err)}` });
            }
          }
        } finally {
          insert?.finalize();
        }
        conn.run("COMMIT");
        return;
      } catch (err) {
        try {
          conn.run("ROLLBACK");
        } catch {
          // nothing open
        }
        throw err;
      }
    } catch (err) {
      if (!isLockError(err) || attempt > defaultMaxLockRetries) {
        return;
      }
      Bun.sleepSync(getDefaultRetryInterval(attempt));
    }
  }
}

function finish(seq: number): void {
  if (done !== null) {
    Atomics.store(done, 0, seq);
    Atomics.notify(done, 0);
  }
  send({ type: "done", seq });
}

self.addEventListener("message", (event: MessageEvent<LogWorkerRequest>) => {
  const req = event.data;
  if (req.type === "init") {
    done = new Int32Array(req.done);
    errors = req.errors;
    return;
  }
  if (req.type === "close") {
    try {
      db?.close();
    } catch {
      // closing at the end
    }
    db = null;
    finish(req.seq);
    return;
  }
  try {
    db ??= openReadWrite(req.path);
    writeBatch(db, req);
  } catch {
    // the batch is lost (a failed open: auxiliary.db is gone or not writable)
  }
  finish(req.seq);
});
