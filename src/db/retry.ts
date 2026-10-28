// Upstream: core/db_retry.go
//
// The wait between attempts of a synchronous query blocks, as upstream's
// time.Sleep blocks its goroutine: bun:sqlite is synchronous and the write
// connection is on the main thread. The async resolvers (reads on the read
// worker pool) wait with a timer instead. The sleep functions are injected
// so tests never wait.
//
// As upstream, a query without a deadline gets one from the query timeout
// (--queryTimeout) for all of its attempts, and loses it afterwards.

import { Deadline, type AsyncExecHookFunc, type ExecHookFunc, type Query } from "@/db/dbx/query";
import { isNoRowsError } from "@/db/dbx/rows";

// blocks for the given milliseconds
export type SleepFunc = (ms: number) => void;

// waits for the given milliseconds without blocking
export type AsyncSleepFunc = (ms: number) => Promise<void>;

// monotonic milliseconds
export type NowFunc = () => number;

export const defaultSleep: SleepFunc = (ms) => Bun.sleepSync(ms);

export const defaultAsyncSleep: AsyncSleepFunc = (ms) => Bun.sleep(ms);

export const defaultNow: NowFunc = () => performance.now();

// default retries intervals (in ms)
export const defaultRetryIntervals: readonly number[] = Object.freeze([
  50, 100, 150, 200, 300, 400, 500, 700, 1000,
]);

// default max retry attempts
export const defaultMaxLockRetries = 12;

// timeout in milliseconds
export function execLockRetry(
  timeout: number,
  maxRetries: number,
  sleep: SleepFunc,
  now: NowFunc,
): ExecHookFunc {
  return (q, op) => {
    const reset = withTimeout(q, timeout, now);
    try {
      baseLockRetry(() => op(), maxRetries, sleep);
    } catch (err) {
      throw failedQueryError(q, err);
    } finally {
      reset();
    }
  };
}

// execLockRetry for the async resolvers
export function execLockRetryAsync(
  timeout: number,
  maxRetries: number,
  sleep: AsyncSleepFunc,
  now: NowFunc,
): AsyncExecHookFunc {
  return async (q, op) => {
    const reset = withTimeout(q, timeout, now);
    try {
      await baseLockRetryAsync(() => op(), maxRetries, sleep);
    } catch (err) {
      throw failedQueryError(q, err);
    } finally {
      reset();
    }
  };
}

// gives q a deadline unless it has one; returns what removes it again
function withTimeout(q: Query, timeout: number, now: NowFunc): () => void {
  if (q.deadline() !== null) {
    return () => {};
  }
  q.withDeadline(new Deadline(timeout, now));
  return () => {
    q.withDeadline(null); // reset
  };
}

function failedQueryError(q: Query, err: unknown): unknown {
  if (isNoRowsError(err)) {
    return err;
  }
  return new Error(`${errorMessage(err)}; failed query: ${q.sql()}`, { cause: err });
}

export function baseLockRetry(
  op: (attempt: number) => void,
  maxRetries: number,
  sleep: SleepFunc,
): void {
  for (let attempt = 1; ; attempt++) {
    try {
      op(attempt);
      return;
    } catch (err) {
      if (attempt > maxRetries || !isLockError(err)) {
        throw err;
      }
      // wait and retry
      sleep(getDefaultRetryInterval(attempt));
    }
  }
}

export async function baseLockRetryAsync(
  op: (attempt: number) => Promise<void>,
  maxRetries: number,
  sleep: AsyncSleepFunc,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await op(attempt);
      return;
    } catch (err) {
      if (attempt > maxRetries || !isLockError(err)) {
        throw err;
      }
      // wait and retry
      await sleep(getDefaultRetryInterval(attempt));
    }
  }
}

// we are checking the error against the plain error texts since the codes could vary between drivers
function isLockError(err: unknown): boolean {
  const errStr = errorMessage(err);
  return errStr.includes("database is locked") || errStr.includes("table is locked");
}

// the retry interval in ms
export function getDefaultRetryInterval(attempt: number): number {
  if (attempt < 0 || attempt > defaultRetryIntervals.length - 1) {
    return defaultRetryIntervals[defaultRetryIntervals.length - 1]!;
  }
  return defaultRetryIntervals[attempt]!;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
