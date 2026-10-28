// Upstream: core/db_retry_test.go, plus a write blocked by another
// connection's lock. Waits go to an injected sleep function; the test
// never sleeps.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { dataDBFilename } from "@/db/base";
import { saveNoValidate } from "@/db/db";
import { baseLockRetry, execLockRetry, getDefaultRetryInterval } from "@/db/retry";
import { Demo } from "@test/db/models";
import { getPreparedDB, openTempDatabases } from "@test/db/support";

const noSleep = () => {};

test("TestGetDefaultRetryInterval", () => {
  expect(getDefaultRetryInterval(-1)).toBe(1000);
  expect(getDefaultRetryInterval(999)).toBe(1000);
  expect(getDefaultRetryInterval(3)).toBe(200);
});

describe("TestBaseLockRetry", () => {
  const scenarios: { err: Error | null; failUntilAttempt: number; expectedAttempts: number }[] = [
    { err: null, failUntilAttempt: 3, expectedAttempts: 1 },
    { err: new Error("test"), failUntilAttempt: 3, expectedAttempts: 1 },
    { err: new Error("database is locked"), failUntilAttempt: 3, expectedAttempts: 3 },
    { err: new Error("table is locked"), failUntilAttempt: 3, expectedAttempts: 3 },
  ];

  scenarios.forEach((s, i) => {
    test(`${i}_${s.err?.message ?? "nil"}`, () => {
      let lastAttempt = 0;
      let err: unknown = null;

      try {
        baseLockRetry(
          (attempt) => {
            lastAttempt = attempt;

            if (attempt < s.failUntilAttempt && s.err !== null) {
              throw s.err;
            }
          },
          s.failUntilAttempt + 2,
          noSleep,
        );
      } catch (e) {
        err = e;
      }

      expect(lastAttempt).toBe(s.expectedAttempts);

      if (s.failUntilAttempt === s.expectedAttempts) {
        expect(err).toBeNull();
      }

      if (s.failUntilAttempt !== s.expectedAttempts && s.err !== null) {
        expect(err).toBe(s.err);
      }
    });
  });
});

test("gives up after the max retries with upstream's waits", () => {
  const sleeps: number[] = [];
  let attempts = 0;
  expect(() =>
    baseLockRetry(
      () => {
        attempts++;
        throw new Error("database is locked");
      },
      12,
      (ms) => sleeps.push(ms),
    ),
  ).toThrow("database is locked");
  // attempt 1 plus 12 retries; the waits start at the second interval
  expect(attempts).toBe(13);
  expect(sleeps).toEqual([100, 150, 200, 300, 400, 500, 700, 1000, 1000, 1000, 1000, 1000]);
});

test("execLockRetry adds the failed query to the error", () => {
  const db = getPreparedDB();
  expect(() =>
    db
      .newQuery("SELECT * FROM missing")
      .withExecHook(execLockRetry(30_000, 12, noSleep, () => 0))
      .execute(),
  ).toThrow("no such table: missing; failed query: SELECT * FROM missing");
});

test("a write blocked by another connection's lock is retried", () => {
  let other: Database | null = null;
  // the other connection commits while iglo.base waits for its second retry
  const { app, dataDir, sleeps } = openTempDatabases(() => {
    if (sleeps.length === 2) {
      other?.run("COMMIT");
    }
  });
  // fail fast instead of waiting busy_timeout (10s) inside SQLite
  app.nonconcurrentDB().newQuery("PRAGMA busy_timeout = 0").execute();

  other = new Database(join(dataDir, dataDBFilename));
  other.run("BEGIN IMMEDIATE");
  other.run("INSERT INTO demo (id, title) VALUES ('other', 'other')");

  const m = new Demo();
  m.id = "demo1";
  m.title = "saved after the lock";
  saveNoValidate(app, m);

  expect(sleeps).toEqual([100, 150]);
  expect(m.isNew()).toBe(false);
  expect(app.concurrentDB().newQuery("SELECT id FROM demo ORDER BY id").column<string>()).toEqual([
    "demo1",
    "other",
  ]);

  other.close();
  app.close();
});
