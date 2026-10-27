// Upstream: core/db_retry.go
//
// The wait between attempts blocks, as upstream's time.Sleep blocks its
// goroutine: bun:sqlite is synchronous and the write connection is on the
// main thread. The sleep function is injected so tests never wait.
// Upstream also gives each retried query a context with the query timeout;
// query timeouts are left to M0.6 (D8).

import type { ExecHookFunc } from "@/db/dbx/query";
import { isNoRowsError } from "@/db/dbx/rows";

// blocks for the given milliseconds
export type SleepFunc = (ms: number) => void;

export const defaultSleep: SleepFunc = (ms) => Bun.sleepSync(ms);

// default retries intervals (in ms)
export const defaultRetryIntervals: readonly number[] = Object.freeze([
  50, 100, 150, 200, 300, 400, 500, 700, 1000,
]);

// default max retry attempts
export const defaultMaxLockRetries = 12;

export function execLockRetry(maxRetries: number, sleep: SleepFunc): ExecHookFunc {
  return (q, op) => {
    try {
      baseLockRetry(() => op(), maxRetries, sleep);
    } catch (err) {
      if (isNoRowsError(err)) {
        throw err;
      }
      throw new Error(`${errorMessage(err)}; failed query: ${q.sql()}`, { cause: err });
    }
  };
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
      if (attempt > maxRetries) {
        throw err;
      }
      // we are checking the error against the plain error texts since the codes could vary between drivers
      const errStr = errorMessage(err);
      if (!errStr.includes("database is locked") && !errStr.includes("table is locked")) {
        throw err;
      }
      // wait and retry
      sleep(getDefaultRetryInterval(attempt));
    }
  }
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
