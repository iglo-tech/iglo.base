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
// Go driver does, terminates that worker and starts a replacement: the pool
// always has `size` live workers. The terminated ("abandoned") thread keeps
// one core busy until its statement returns. At most 2 × `size` threads are
// abandoned at once (maxAbandoned). At that limit a worker whose query timed
// out is not terminated: the query still fails at its deadline, and the
// worker takes queries again once its statement returns, or is replaced as
// soon as an abandoned thread exits. A result that comes in after the
// deadline, before its timer ran, fails the query too.

import type { SQLQueryBindings } from "bun:sqlite";

import { DeadlineExceededError, type AsyncReader, type Deadline } from "@/db/dbx/query";
import { NoRowsError, rowsFromValues, type ReadMode } from "@/db/dbx/rows";

export interface ReadRequestMessage {
  id: number;
  path: string;
  sql: string;
  args: SQLQueryBindings[];
  mode: ReadMode;
  // Query.withExactIntegers
  exactIntegers: boolean;
}

// the result of an "all" read as the worker sends it
export interface RowTable {
  names: string[];
  rows: unknown[][];
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
  readonly deadline: Deadline | null;
  timer: ReturnType<typeof setTimeout> | null;
  slot: Slot | null;
  expired: boolean;
}

interface Slot {
  readonly worker: Worker;
  // the requests posted to the worker and not answered yet, in the order it
  // runs them; the first one is running (a timed-out one, expired, until its
  // statement returns, when the worker could not be abandoned). A request
  // that failed at its deadline while it waited, or that another worker took
  // over (steal), stays here with its slot cleared until the worker's answer
  // for it is skipped.
  posted: Request[];
  // when the first posted request started running (performance.now())
  startedAt: number;
}

// the most requests posted to a worker in one message (see pump)
export const maxBatch = 4;

// an idle worker takes over the requests that wait behind a request which
// has been running this long (ms) on another worker (see steal)
export const stealAfterMs = 10;

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

// the most terminated threads that may still run a statement, per worker
export const maxAbandonedPerWorker = 2;

export interface ReadPoolStats {
  // live workers (idle or busy)
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
  private stealTimer: ReturnType<typeof setTimeout> | null = null;
  private nextId = 1;
  private closed = false;

  // the most abandoned threads at once
  readonly maxAbandoned: number;

  private constructor(readonly size: number) {
    this.maxAbandoned = maxAbandonedPerWorker * size;
  }

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
      read: (sql, args, mode, deadline, exactIntegers = false) =>
        this.read(path, sql, args, mode, deadline, exactIntegers),
    };
  }

  stats(): ReadPoolStats {
    return {
      workers: this.slots.length,
      busy: this.slots.filter((slot) => slot.posted.length > 0).length,
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
      if (this.stealTimer !== null) {
        clearTimeout(this.stealTimer);
        this.stealTimer = null;
      }
      const err = new Error("sql: database is closed");
      for (const request of this.queue.splice(0)) {
        this.settle(request);
        request.reject(err);
      }
      for (const slot of this.slots.splice(0)) {
        const posted = slot.posted;
        slot.posted = [];
        slot.worker.terminate();
        for (const request of posted) {
          if (request.slot === slot) {
            this.settle(request);
            request.reject(err);
          }
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
    exactIntegers: boolean,
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
        message: { id, path, sql, args, mode, exactIntegers },
        resolve,
        reject,
        deadline,
        timer: null,
        slot: null,
        expired: false,
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
    const slot: Slot = { worker, posted: [], startedAt: 0 };
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
      const request = slot.posted[0];
      if (request === undefined || request.id !== event.data.id) {
        return;
      }
      // the worker answers its posted requests in order; the next one runs
      slot.posted.shift();
      slot.startedAt = performance.now();
      if (slot.posted.length === 0) {
        worker.unref();
      }
      if (request.slot !== slot) {
        // it failed at its deadline while it waited, or another worker took
        // it over: this answer is not used
        this.pump();
        this.steal(slot);
        return;
      }
      this.settle(request);
      const res = event.data;
      if (request.expired) {
        // rejected at its deadline already
      } else if (request.deadline?.expired() === true) {
        // the result came in before the overdue timer ran (a busy main
        // thread): the query still fails, as its context expired
        request.reject(new DeadlineExceededError());
      } else if (res.ok) {
        request.resolve(
          request.message.mode === "all"
            ? rowsFromValues((res.value as RowTable).names, (res.value as RowTable).rows)
            : res.value,
        );
      } else {
        request.reject(deserializeError(res.error));
      }
      this.pump();
      this.steal(slot);
    });
    worker.addEventListener("error", (event: ErrorEvent) => {
      // the worker's thread failed outside a query and exits; replace it
      const posted = slot.posted;
      this.removeSlot(slot);
      slot.posted = [];
      worker.terminate();
      worker.unref();
      // the running request fails; the ones behind it did not run
      const running = posted[0];
      this.requeue(posted.slice(1), slot);
      if (running !== undefined && running.slot === slot) {
        this.settle(running);
        running.reject(new Error(`read worker failed: ${event.message}`));
      }
      this.refill();
    });
    worker.unref();
    this.slots.push(slot);
  }

  // Posts queued requests to idle workers. While every queued request can
  // have an idle worker to itself, each is posted alone, as it is posted
  // as soon as it comes. When more requests wait than workers are idle,
  // each idle worker takes several in one message (at most maxBatch): a
  // message costs the event loop about as much for one request as for
  // several, and it is the event loop that the requests are waiting for.
  // The worker runs them in order and answers each when it is done.
  private pump(): void {
    while (this.queue.length > 0) {
      let idle = 0;
      let slot: Slot | undefined;
      for (const s of this.slots) {
        if (s.posted.length === 0) {
          idle++;
          slot ??= s;
        }
      }
      if (slot === undefined) {
        return;
      }
      const take = Math.min(maxBatch, Math.ceil(this.queue.length / idle));
      const batch = this.queue.splice(0, take);
      slot.posted = batch;
      slot.startedAt = performance.now();
      for (const request of batch) {
        request.slot = slot;
      }
      slot.worker.ref();
      // a Worker's postMessage has no target origin (that is window.postMessage)
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      slot.worker.postMessage(batch.length === 1 ? batch[0]!.message : batch.map((r) => r.message));
    }
  }

  // An idle worker takes over a request that waits behind one which has been
  // running for stealAfterMs on another worker, so a slow query does not
  // hold up the requests posted with it. The first worker still runs the
  // request and its answer is dropped (reads can be repeated).
  private steal(slot: Slot): void {
    if (this.closed || this.queue.length > 0 || slot.posted.length > 0) {
      return;
    }
    if (!this.slots.includes(slot)) {
      return;
    }
    const now = performance.now();
    let wait = Infinity;
    for (const victim of this.slots) {
      if (victim === slot || victim.posted.length < 2) {
        continue;
      }
      if (now - victim.startedAt < stealAfterMs) {
        // not long enough yet: look again when it is
        wait = Math.min(wait, stealAfterMs - (now - victim.startedAt));
        continue;
      }
      for (let i = victim.posted.length - 1; i >= 1; i--) {
        const request = victim.posted[i] as Request;
        if (request.slot === victim && !request.expired) {
          request.slot = slot;
          slot.posted = [request];
          slot.startedAt = now;
          slot.worker.ref();
          // oxlint-disable-next-line unicorn/require-post-message-target-origin
          slot.worker.postMessage(request.message);
          return;
        }
      }
    }
    if (wait !== Infinity && this.stealTimer === null) {
      this.stealTimer = setTimeout(() => {
        this.stealTimer = null;
        for (const idle of this.slots.slice()) {
          this.steal(idle);
        }
      }, wait + 1);
      this.stealTimer.unref();
    }
  }

  // the query's deadline passed: fail it, and replace its worker if it runs
  private expire(request: Request): void {
    request.timer = null;
    request.expired = true;
    const slot = request.slot;
    if (slot === null) {
      const i = this.queue.indexOf(request);
      if (i !== -1) {
        this.queue.splice(i, 1);
      }
    } else if (slot.posted[0] !== request) {
      // posted behind the running request: it fails now and its answer is
      // skipped when it comes
      request.slot = null;
    } else if (this.abandoned.size < this.maxAbandoned) {
      this.retire(slot);
      this.refill();
    }
    request.reject(new DeadlineExceededError());
  }

  // terminates a worker; its thread exits once its statement returns
  private retire(slot: Slot): void {
    const posted = slot.posted;
    slot.posted = [];
    if (posted[0] !== undefined && posted[0].slot === slot) {
      posted[0].slot = null;
    }
    this.removeSlot(slot);
    // the requests that did not run go to another worker (reads can be
    // repeated); refill() posts them
    this.requeue(posted.slice(1), slot);
    slot.worker.terminate();
    slot.worker.unref();
    this.abandoned.add(slot.worker);
  }

  // puts requests that did not run back at the front of the queue; the ones
  // that failed at their deadline while they waited are dropped
  private requeue(requests: Request[], from: Slot): void {
    const live = requests.filter((r) => !r.expired && r.slot === from);
    for (const request of live) {
      request.slot = null;
    }
    this.queue.unshift(...live);
  }

  // keeps `size` live workers, and replaces workers still running a
  // timed-out query while abandoned threads stay under the limit
  private refill(): void {
    if (this.closed) {
      return;
    }
    for (const slot of this.slots.slice()) {
      if (this.abandoned.size >= this.maxAbandoned) {
        break;
      }
      const first = slot.posted[0];
      if (first?.expired === true && first.slot === slot) {
        this.retire(slot);
      }
    }
    while (this.slots.length < this.size) {
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
