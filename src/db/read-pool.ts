// Upstream: core/base.go (initDataDB, initAuxDB: the concurrent connection
// pools, DefaultDataMaxOpenConns 120 and DefaultAuxMaxOpenConns 20) and
// core/db_retry.go (execLockRetry: a query timeout through a context, which
// the Go SQLite driver enforces with sqlite3_interrupt)
//
// The read pool stands in for upstream's concurrent connection pools (D8):
// a few Bun workers (read-worker.ts), each with read-only connections to
// data.db and auxiliary.db, run the async resolvers' queries one at a time,
// so a slow read does not stall the event loop. A query waits in a queue
// for a free worker, as Go's database/sql waits for a free connection.
//
// bun:sqlite has no sqlite3_interrupt or progress handler, and terminating
// a worker does not stop a statement that is running: the thread finishes
// the statement step before it exits (docs/perf/M0.6-read-path.md). So at a
// query's deadline the pool rejects it with DeadlineExceededError, as the
// Go driver does, terminates that worker and starts a replacement. The
// terminated ("abandoned") thread keeps one core busy until its statement
// returns. At most `size` threads are abandoned at once: beyond that no
// replacement starts until one exits, and queued queries wait or time out.

import type { SQLQueryBindings } from "bun:sqlite";

import { DeadlineExceededError, type AsyncReader, type Deadline } from "@/db/dbx/query";
import { NoRowsError, type ReadMode } from "@/db/dbx/rows";

export interface ReadRequestMessage {
  id: number;
  path: string;
  sql: string;
  args: SQLQueryBindings[];
  mode: ReadMode;
}

export interface SerializedError {
  name: string;
  message: string;
  code: string | null;
  errno: number | null;
}

export type ReadResponseMessage =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: SerializedError };

interface Request {
  readonly id: number;
  readonly message: ReadRequestMessage;
  readonly resolve: (value: unknown) => void;
  readonly reject: (err: unknown) => void;
  timer: ReturnType<typeof setTimeout> | null;
  slot: Slot | null;
}

interface Slot {
  readonly worker: Worker;
  request: Request | null;
}

// a SQLite error from a worker: bun:sqlite's SQLiteError cannot be
// constructed outside it, so this one carries the same name, message,
// code and errno
export class ReadWorkerError extends Error {
  constructor(
    name: string,
    message: string,
    readonly code: string | null,
    readonly errno: number | null,
  ) {
    super(message);
    this.name = name;
  }
}

function deserializeError(err: SerializedError): Error {
  if (err.name === "NoRowsError") {
    return new NoRowsError();
  }
  return new ReadWorkerError(err.name, err.message, err.code, err.errno);
}

// bun build --compile bundles this module into the executable's entry,
// where read-worker.ts is a separate entry point under the bundle's root
// (src/)
function workerURL(): string {
  if (import.meta.path.startsWith("/$bunfs/")) {
    return "./db/read-worker.ts";
  }
  return new URL("read-worker.ts", import.meta.url).href;
}

export interface ReadPoolStats {
  // live workers taking queries
  workers: number;
  busy: number;
  queued: number;
  // terminated workers whose thread is still running a statement
  abandoned: number;
}

export class ReadPool {
  private readonly slots: Slot[] = [];
  private readonly queue: Request[] = [];
  private readonly abandoned = new Set<Worker>();
  private readonly exited: Promise<void>[] = [];
  private nextId = 1;
  private closed = false;

  private constructor(readonly size: number) {}

  // starts `size` workers; their connections open on first use
  static open(size: number): ReadPool {
    if (!Number.isInteger(size) || size < 1) {
      throw new Error(`invalid read pool size: ${size}`);
    }
    const pool = new ReadPool(size);
    for (let i = 0; i < size; i++) {
      pool.spawn();
    }
    return pool;
  }

  // the AsyncReader of one database file
  reader(path: string): AsyncReader {
    return {
      read: (sql, args, mode, deadline) => this.read(path, sql, args, mode, deadline),
    };
  }

  stats(): ReadPoolStats {
    return {
      workers: this.slots.length,
      busy: this.slots.filter((slot) => slot.request !== null).length,
      queued: this.queue.length,
      abandoned: this.abandoned.size,
    };
  }

  // Close stops the workers and fails the queued and running queries. The
  // promise resolves once every worker thread, abandoned ones included, has
  // exited.
  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      const err = new Error("sql: database is closed");
      for (const request of this.queue.splice(0)) {
        this.settle(request);
        request.reject(err);
      }
      for (const slot of this.slots.splice(0)) {
        const request = slot.request;
        slot.worker.terminate();
        if (request !== null) {
          this.settle(request);
          request.reject(err);
        }
      }
    }
    return Promise.all(this.exited).then(() => {});
  }

  private read(
    path: string,
    sql: string,
    args: SQLQueryBindings[],
    mode: ReadMode,
    deadline: Deadline | null,
  ): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error("sql: database is closed"));
    }
    if (deadline?.expired()) {
      return Promise.reject(new DeadlineExceededError());
    }
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const request: Request = {
        id,
        message: { id, path, sql, args, mode },
        resolve,
        reject,
        timer: null,
        slot: null,
      };
      if (deadline !== null) {
        request.timer = setTimeout(() => this.expire(request), deadline.remaining());
      }
      this.queue.push(request);
      this.pump();
    });
  }

  private spawn(): void {
    const worker = new Worker(workerURL());
    const slot: Slot = { worker, request: null };
    this.exited.push(
      new Promise((resolve) => {
        worker.addEventListener("close", () => {
          this.abandoned.delete(worker);
          this.removeSlot(slot);
          resolve();
          // an exited abandoned thread makes room for a replacement
          this.refill();
        });
      }),
    );
    worker.addEventListener("message", (event: MessageEvent<ReadResponseMessage>) => {
      const request = slot.request;
      if (request === null || request.id !== event.data.id) {
        return;
      }
      slot.request = null;
      this.settle(request);
      worker.unref();
      const res = event.data;
      if (res.ok) {
        request.resolve(res.value);
      } else {
        request.reject(deserializeError(res.error));
      }
      this.pump();
    });
    worker.addEventListener("error", (event: ErrorEvent) => {
      // the worker's thread failed outside a query; replace it
      const request = slot.request;
      this.retire(slot);
      if (request !== null) {
        this.settle(request);
        request.reject(new Error(`read worker failed: ${event.message}`));
      }
      this.refill();
    });
    worker.unref();
    this.slots.push(slot);
  }

  private pump(): void {
    while (this.queue.length > 0) {
      const slot = this.slots.find((s) => s.request === null);
      if (slot === undefined) {
        return;
      }
      const request = this.queue.shift()!;
      slot.request = request;
      request.slot = slot;
      slot.worker.ref();
      // a Worker's postMessage has no target origin (that is window.postMessage)
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      slot.worker.postMessage(request.message);
    }
  }

  // the query's deadline passed: fail it, and stop its worker if it runs
  private expire(request: Request): void {
    request.timer = null;
    const slot = request.slot;
    if (slot === null) {
      const i = this.queue.indexOf(request);
      if (i !== -1) {
        this.queue.splice(i, 1);
      }
    } else {
      this.retire(slot);
      this.refill();
    }
    request.reject(new DeadlineExceededError());
  }

  // terminates a worker; its thread exits once its statement returns
  private retire(slot: Slot): void {
    this.removeSlot(slot);
    slot.request = null;
    slot.worker.terminate();
    slot.worker.unref();
    this.abandoned.add(slot.worker);
  }

  private refill(): void {
    if (this.closed) {
      return;
    }
    while (
      this.slots.length < this.size &&
      this.abandoned.size + this.slots.length < 2 * this.size
    ) {
      this.spawn();
    }
    this.pump();
  }

  private removeSlot(slot: Slot): void {
    const i = this.slots.indexOf(slot);
    if (i !== -1) {
      this.slots.splice(i, 1);
    }
  }

  private settle(request: Request): void {
    if (request.timer !== null) {
      clearTimeout(request.timer);
      request.timer = null;
    }
    request.slot = null;
  }
}
