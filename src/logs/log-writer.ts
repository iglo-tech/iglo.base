// Upstream: none (D31). The main thread's side of the log writer thread
// (log-worker.ts): batches of `_logs` rows are posted to it and written there
// on a connection of their own. The thread starts with the first batch and
// stops with `stop`, so an app that logs nothing holds no thread.

import { MessageChannel, receiveMessageOnPort, type MessagePort } from "node:worker_threads";

export type LogRow = [id: string, created: string, level: number, message: string, data: string];

export type LogWorkerRequest =
  | { type: "init"; done: SharedArrayBuffer; errors: MessagePort }
  | { type: "write"; seq: number; path: string; rows: LogRow[] }
  | { type: "close"; seq: number };

// on the worker's own port, so that a stopping app can read them without the event loop
export type LogWorkerError = { text: string };

export type LogWorkerResponse = { type: "done"; seq: number };

// log-worker.ts, beside this file, or in the compiled executable
function workerURL(): string {
  if (import.meta.path.startsWith("/$bunfs/")) {
    return "./logs/log-worker.ts";
  }
  return new URL("log-worker.ts", import.meta.url).href;
}

// how long a flush waits for the thread at most
const flushTimeoutMs = 60_000;

interface Running {
  worker: Worker;
  done: Int32Array;
  errors: MessagePort;
  // the last sequence number posted
  posted: number;
}

export class LogWriter {
  readonly #path: string;
  readonly #onError: (text: string) => void;
  readonly #timeoutMs: number;
  #running: Running | null = null;
  #waiters: { seq: number; resolve: () => void }[] = [];

  // timeoutMs bounds how long a stop waits for the thread
  constructor(path: string, onError: (text: string) => void, timeoutMs = flushTimeoutMs) {
    this.#path = path;
    this.#onError = onError;
    this.#timeoutMs = timeoutMs;
  }

  // posts one batch
  write(rows: LogRow[]): number {
    const running = this.#start();
    const seq = ++running.posted;
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    running.worker.postMessage({ type: "write", seq, path: this.#path, rows });
    return seq;
  }

  // resolves once every batch posted so far has been written
  flush(): Promise<void> {
    const running = this.#running;
    if (running === null) {
      return Promise.resolve();
    }
    const seq = running.posted;
    if (Atomics.load(running.done, 0) >= seq) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.#waiters.push({ seq, resolve }));
  }

  // blocks until every batch posted so far has been written: the app is
  // stopping and its logs must reach the file first
  flushSync(): void {
    const running = this.#running;
    if (running === null) {
      return;
    }
    this.#waitSync(running, running.posted);
  }

  // writes what is posted, closes the connection and ends the thread; a later
  // write starts a new one
  async stop(): Promise<void> {
    const running = this.#running;
    if (running === null) {
      return;
    }
    const seq = ++running.posted;
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    running.worker.postMessage({ type: "close", seq });
    // as stopSync, the wait is bounded: a hung thread must not stall the
    // suspend of a backup or a restore
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      new Promise<boolean>((resolve) => this.#waiters.push({ seq, resolve: () => resolve(false) })),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), this.#timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    this.#drainErrors(running);
    if (timedOut) {
      this.#onError(
        `Failed to stop the log writer: no answer within ${this.#timeoutMs}ms, the thread is terminated`,
      );
    }
    this.#end(running);
  }

  // stop, blocking
  stopSync(): void {
    const running = this.#running;
    if (running === null) {
      return;
    }
    const seq = ++running.posted;
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    running.worker.postMessage({ type: "close", seq });
    this.#waitSync(running, seq);
    this.#drainErrors(running);
    this.#end(running);
  }

  #waitSync(running: Running, seq: number): void {
    const deadline = performance.now() + flushTimeoutMs;
    for (;;) {
      const current = Atomics.load(running.done, 0);
      if (current >= seq) {
        return;
      }
      const left = deadline - performance.now();
      if (left <= 0) {
        return;
      }
      Atomics.wait(running.done, 0, current, left);
    }
  }

  #drainErrors(running: Running): void {
    for (;;) {
      const msg = receiveMessageOnPort(running.errors);
      if (msg === undefined) {
        return;
      }
      this.#onError((msg.message as LogWorkerError).text);
    }
  }

  #end(running: Running): void {
    running.errors.close();
    if (this.#running === running) {
      this.#running = null;
    }
    running.worker.terminate();
    this.#release(Number.MAX_SAFE_INTEGER);
  }

  #release(upTo: number): void {
    const waiting = this.#waiters;
    this.#waiters = [];
    for (const w of waiting) {
      if (w.seq <= upTo) {
        w.resolve();
      } else {
        this.#waiters.push(w);
      }
    }
  }

  #start(): Running {
    if (this.#running !== null) {
      return this.#running;
    }
    const worker = new Worker(workerURL());
    const buffer = new SharedArrayBuffer(4);
    const channel = new MessageChannel();
    const running: Running = {
      worker,
      done: new Int32Array(buffer),
      errors: channel.port1,
      posted: 0,
    };
    worker.addEventListener("message", (event: MessageEvent<LogWorkerResponse>) => {
      this.#drainErrors(running);
      this.#release(event.data.seq);
    });
    worker.addEventListener("error", () => {
      // a crashed thread: what it held is lost, and the next batch starts another
      if (this.#running === running) {
        this.#running = null;
      }
      this.#release(Number.MAX_SAFE_INTEGER);
    });
    worker.unref();
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    worker.postMessage({ type: "init", done: buffer, errors: channel.port2 }, [channel.port2]);
    this.#running = running;
    return running;
  }
}
