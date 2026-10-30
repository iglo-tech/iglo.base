// Upstream: apis/file.go (bindFileApi's thumb generation limits and
// fileApi.createThumb: the singleflight group, the semaphore,
// PB_THUMBS_MAX_WORKERS and PB_THUMBS_MAX_WAIT)
//
// The thumbs of the app (App.thumbs): one generation per thumb path at a
// time (a request for a thumb that is being generated waits for that
// generation, as singleflight's DoChan), at most PB_THUMBS_MAX_WORKERS
// (default NumCPU + 2) generations at once, and a generation that waits
// longer than PB_THUMBS_MAX_WAIT seconds (default 60) for a free slot
// fails with "context deadline exceeded" (the caller then serves the
// original).
//
// The decode, resize and encode run in Bun Workers (thumb-worker.ts), so
// a large image does not stall requests (D10). Workers start lazily, one
// per generation slot in use, so there are never more than
// PB_THUMBS_MAX_WORKERS of them. An idle worker is kept for the next thumb
// and stopped after idleWorkerMs, which gives its memory back.
// The pool reads no process-global state: the environment comes from the
// app (App.getenv).

import { availableParallelism } from "node:os";

import type { Thumb } from "@/files/create-thumb";
import type { ThumbSize } from "@/files/imaging";

export interface ThumbRequestMessage {
  id: number;
  input: ArrayBuffer;
  contentType: string;
  size: ThumbSize;
  maxPixels: number;
}

export type ThumbResponseMessage =
  | { id: number; ok: true; bytes: Uint8Array; contentType: string }
  | { id: number; ok: false; error: string };

// thumb-worker.ts, beside this file, or in the compiled executable
function workerURL(): string {
  if (import.meta.path.startsWith("/$bunfs/")) {
    return "./files/thumb-worker.ts";
  }
  return new URL("thumb-worker.ts", import.meta.url).href;
}

// how long an idle worker is kept for the next thumb
const idleWorkerMs = 30_000;

// cast.ToInt64 of an environment value: strconv.ParseInt(s, 0, 64) after
// a trailing ".0..." is trimmed; 0 when it does not parse
export function envInt(value: string): number {
  let s = value;
  if (/\.0+$/.test(s)) {
    s = s.replace(/\.0+$/, "");
  }
  const m = /^([+-]?)(0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|0[0-7_]*|[1-9][0-9_]*)$/.exec(s);
  if (m === null) {
    return 0;
  }
  let digits = m[2] as string;
  if (digits.includes("_")) {
    // base prefix 0 allows underscores between digits only
    if (/^_|_$|__/.test(digits.replace(/^0[xXoObB]?/, "")) || !digits.startsWith("0")) {
      return 0;
    }
    digits = digits.replaceAll("_", "");
  }
  let n: bigint;
  if (/^0[xXoObB]/.test(digits)) {
    n = BigInt(digits.toLowerCase());
  } else if (digits.length > 1 && digits.startsWith("0")) {
    n = BigInt("0o" + digits.slice(1));
  } else {
    n = BigInt(digits);
  }
  if (m[1] === "-") {
    n = -n;
  }
  if (n > 9223372036854775807n || n < -9223372036854775808n) {
    return 0;
  }
  return Number(n);
}

export interface ThumbPoolOptions {
  // os.Getenv (App.getenv)
  getenv: (name: string) => string;
}

interface Job {
  message: ThumbRequestMessage;
  resolve: (thumb: Thumb) => void;
  reject: (err: Error) => void;
}

interface Slot {
  worker: Worker;
  job: Job | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

export class ThumbPool {
  readonly maxWorkers: number;
  readonly maxWaitMs: number;

  readonly #getenv: (name: string) => string;
  // thumbGenPending: the running generation per thumb path
  readonly #pending = new Map<string, Promise<void>>();
  // thumbGenSem
  #free: number;
  readonly #waiters: (() => void)[] = [];
  readonly #slots: Slot[] = [];
  #nextId = 1;
  #closed = false;

  constructor(options: ThumbPoolOptions) {
    this.#getenv = options.getenv;

    let maxWorkers = envInt(options.getenv("PB_THUMBS_MAX_WORKERS"));
    if (maxWorkers <= 0) {
      maxWorkers = availableParallelism() + 2; // the value is arbitrary chosen and may change in the future
    }
    this.maxWorkers = maxWorkers;

    let maxWait = envInt(options.getenv("PB_THUMBS_MAX_WAIT"));
    if (maxWait <= 0) {
      maxWait = 60;
    }
    this.maxWaitMs = maxWait * 1000;

    this.#free = maxWorkers;
  }

  // PB_THUMBS_MAX_SOURCE_PIXELS, read for each thumb as createThumb does
  maxSourcePixels(): number {
    const maxPixels = envInt(this.#getenv("PB_THUMBS_MAX_SOURCE_PIXELS"));
    return maxPixels <= 0 ? 100 * 2 ** 20 : maxPixels;
  }

  // fileApi.createThumb: runs generate (which reads the original, renders
  // the thumb with render and stores it) once per thumb path at a time,
  // after a generation slot is free. Concurrent calls for the same path
  // share the running generation and its error.
  generate(thumbPath: string, generate: () => Promise<void>): Promise<void> {
    const running = this.#pending.get(thumbPath);
    if (running !== undefined) {
      return running;
    }
    const run = (async () => {
      await this.#acquire();
      try {
        await generate();
      } finally {
        this.#release();
      }
    })();
    this.#pending.set(thumbPath, run);
    const forget = (): void => {
      this.#pending.delete(thumbPath);
    };
    run.then(forget, forget);
    return run;
  }

  // Makes the thumb in a worker. Called from inside generate, so at most
  // maxWorkers renders run at once. The input's buffer is transferred to
  // the worker (unless input is a view of a part of it).
  render(input: Uint8Array, contentType: string, size: ThumbSize): Promise<Thumb> {
    if (this.#closed) {
      return Promise.reject(new Error("the thumb pool is closed"));
    }
    const buffer =
      input.byteOffset === 0 &&
      input.byteLength === input.buffer.byteLength &&
      input.buffer instanceof ArrayBuffer
        ? input.buffer
        : input.slice().buffer;
    return new Promise((resolve, reject) => {
      const message: ThumbRequestMessage = {
        id: this.#nextId++,
        input: buffer,
        contentType,
        size,
        maxPixels: this.maxSourcePixels(),
      };
      const slot = this.#slots.find((s) => s.job === null) ?? this.#spawn();
      if (slot.idleTimer !== null) {
        clearTimeout(slot.idleTimer);
        slot.idleTimer = null;
      }
      slot.job = { message, resolve, reject };
      slot.worker.ref();
      // a Worker's postMessage has no target origin (that is window.postMessage)
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      slot.worker.postMessage(message, [buffer]);
    });
  }

  // the number of started workers (for tests and measurements)
  workers(): number {
    return this.#slots.length;
  }

  // Stops the workers; a render in progress fails.
  close(): void {
    this.#closed = true;
    for (const slot of this.#slots.splice(0)) {
      this.#stop(slot, new Error("the thumb pool is closed"));
    }
  }

  #spawn(): Slot {
    const worker = new Worker(workerURL());
    const slot: Slot = { worker, job: null, idleTimer: null };
    worker.addEventListener("message", (event: MessageEvent<ThumbResponseMessage>) => {
      const job = slot.job;
      if (job === null || job.message.id !== event.data.id) {
        return;
      }
      slot.job = null;
      worker.unref();
      const res = event.data;
      if (res.ok) {
        job.resolve({ bytes: res.bytes, contentType: res.contentType });
      } else {
        job.reject(new Error(res.error));
      }
      this.#idle(slot);
    });
    worker.addEventListener("error", (event: ErrorEvent) => {
      // the worker's thread failed (e.g. out of memory) and exits
      this.#remove(slot);
      this.#stop(slot, new Error(`thumb worker failed: ${event.message}`));
    });
    worker.unref();
    this.#slots.push(slot);
    return slot;
  }

  #idle(slot: Slot): void {
    slot.idleTimer = setTimeout(() => {
      slot.idleTimer = null;
      if (slot.job === null) {
        this.#remove(slot);
        this.#stop(slot, null);
      }
    }, idleWorkerMs);
    slot.idleTimer.unref();
  }

  #remove(slot: Slot): void {
    const i = this.#slots.indexOf(slot);
    if (i !== -1) {
      this.#slots.splice(i, 1);
    }
  }

  #stop(slot: Slot, err: Error | null): void {
    if (slot.idleTimer !== null) {
      clearTimeout(slot.idleTimer);
      slot.idleTimer = null;
    }
    const job = slot.job;
    slot.job = null;
    slot.worker.terminate();
    slot.worker.unref();
    if (job !== null) {
      job.reject(err ?? new Error("thumb worker stopped"));
    }
  }

  // semaphore.Acquire with a PB_THUMBS_MAX_WAIT deadline
  #acquire(): Promise<void> {
    if (this.#free > 0 && this.#waiters.length === 0) {
      this.#free--;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const i = this.#waiters.indexOf(waiter);
        if (i !== -1) {
          this.#waiters.splice(i, 1);
        }
        reject(new Error("context deadline exceeded"));
      }, this.maxWaitMs);
      this.#waiters.push(waiter);
    });
  }

  #release(): void {
    const next = this.#waiters.shift();
    if (next !== undefined) {
      next(); // the slot passes to the waiter
      return;
    }
    this.#free++;
  }
}
