// Upstream: apis/cron_test.go, the scenarios that need a job or a job list
// the upstream binary cannot have (test/scenarios/cron.ts has the rest), and
// the built-in jobs of core/base.go, core/otp_model.go, core/mfa_model.go.
//
// In-process, on the app clock: a job's end is awaited, never slept for.

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { newRouter } from "@/apis/base";
import { bootstrap, clearBootstrap } from "@/app/bootstrap";
import { deleteOldLogs } from "@/logs/log-query";

import { openFixtureApp, type TestApp } from "@test/app/app";
import { expiredRow, liveRow, superuserToken, writeMFAs, writeOTPs } from "@test/scenarios/cron";
import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";
import { tempDir } from "@test/support/executable";
import { serveTest } from "@test/support/router";

let opened: TestApp[] = [];

afterEach(async () => {
  for (const app of opened) {
    await app.cleanup();
  }
  opened = [];
});

async function open(prepare?: (dataDir: string) => void, now?: Date): Promise<TestApp> {
  const dataDir = join(tempDir(), "pb_data");
  copyDataDir(fixtureDir, dataDir);
  prepare?.(dataDir);
  const app = await openFixtureApp({
    dataDir,
    ...(now === undefined ? {} : { clock: { now: () => now } }),
  });
  opened.push(app);
  return app;
}

function send(
  app: TestApp,
  method: string,
  target: string,
  headers: Record<string, string> = { Authorization: superuserToken },
): Promise<Response> {
  return serveTest(newRouter(app).buildMux(), { method, target, headers });
}

async function runJob(app: TestApp, id: string): Promise<void> {
  const res = await send(app, "POST", `/api/crons/${id}`);
  expect(res.status).toBe(204);
  await app.cron.waitForRunning(5000);
}

function ids(app: TestApp, table: string): string[] {
  return app.databases.db().newQuery(`SELECT id FROM ${table} ORDER BY id`).column<string>();
}

function withTestJob(app: TestApp): { calls: () => number } {
  let calls = 0;
  app.cron.add("test", "* * * * *", () => {
    calls++;
  });
  return { calls: () => calls };
}

const walSize = (app: TestApp, file: string): number =>
  statSync(join(app.dataDir, `${file}-wal`)).size;

function writeSomething(app: TestApp): void {
  const id = crypto.randomUUID();
  app.databases.auxNonconcurrentDB().newQuery(`INSERT INTO _logs (id) VALUES ('${id}')`).execute();
  app.databases
    .nonconcurrentDB()
    .newQuery(`INSERT INTO _params (id, value) VALUES ('${id}', '{}')`)
    .execute();
}

async function openOwn(): Promise<{ app: TestApp; dataDir: string }> {
  const dataDir = join(tempDir(), "pb_data");
  copyDataDir(fixtureDir, dataDir);
  const app = await openFixtureApp({ dataDir });
  return { app, dataDir };
}

describe("TestCronsList", () => {
  test("authorized as superuser (empty list)", async () => {
    const app = await open();
    app.cron.removeAll();

    const res = await send(app, "GET", "/api/crons");
    expect(res.status).toBe(200);
    expect((await res.text()).trimEnd()).toBe("[]");
  });

  test("the built-in jobs in registration order", async () => {
    const app = await open();

    const res = await send(app, "GET", "/api/crons");
    expect(await res.json()).toEqual([
      { id: "__pbDBOptimize__", expression: "0 0 * * *" },
      { id: "__pbMFACleanup__", expression: "0 * * * *" },
      { id: "__pbOTPCleanup__", expression: "0 * * * *" },
      { id: "__pbLogsCleanup__", expression: "0 */6 * * *" },
    ]);
  });

  test("the order is the insertion sort's of the inconsistent comparator", async () => {
    const app = await open();
    app.cron.removeAll();
    for (const id of ["__pbX", "c", "__pbY", "a", "b", "__pbZ"]) {
      app.cron.add(id, "* * * * *", () => {});
    }

    const res = await send(app, "GET", "/api/crons");
    const jobs = (await res.json()) as { id: string }[];
    expect(jobs.map((j) => j.id)).toEqual(["a", "b", "c", "__pbX", "__pbY", "__pbZ"]);
  });
});

describe("TestCronsRun", () => {
  test("unauthorized", async () => {
    const app = await open();
    const job = withTestJob(app);

    const res = await send(app, "POST", "/api/crons/test", {});
    expect(res.status).toBe(401);
    await app.cron.waitForRunning(5000);
    expect(job.calls()).toBe(0);
  });

  test("authorized as regular user", async () => {
    const app = await open();
    const job = withTestJob(app);
    const user =
      "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6IjRxMXhsY2xtZmxva3UzMyIsInR5cGUiOiJhdXRoIiwiY29sbGVjdGlvbklkIjoiX3BiX3VzZXJzX2F1dGhfIiwiZXhwIjoyNTI0NjA0NDYxLCJyZWZyZXNoYWJsZSI6dHJ1ZX0.ZT3F0Z3iM-xbGgSG3LEKiEzHrPHr8t8IuHLZGGNuxLo";

    const res = await send(app, "POST", "/api/crons/test", { Authorization: user });
    expect(res.status).toBe(403);
    await app.cron.waitForRunning(5000);
    expect(job.calls()).toBe(0);
  });

  test("authorized as superuser (missing job)", async () => {
    const app = await open();
    const job = withTestJob(app);

    const res = await send(app, "POST", "/api/crons/missing");
    expect(res.status).toBe(404);
    await app.cron.waitForRunning(5000);
    expect(job.calls()).toBe(0);
  });

  test("authorized as superuser (existing job)", async () => {
    const app = await open();
    const job = withTestJob(app);

    await runJob(app, "test");
    expect(job.calls()).toBe(1);
  });

  test("the POST answers without waiting, and the job may overlap itself", async () => {
    const app = await open();
    let started = 0;
    const { promise: released, resolve: release } = Promise.withResolvers<void>();
    app.cron.add("slow", "* * * * *", async () => {
      started++;
      await released;
    });

    expect((await send(app, "POST", "/api/crons/slow")).status).toBe(204);
    expect((await send(app, "POST", "/api/crons/slow")).status).toBe(204);
    await Bun.sleep(0);
    expect(started).toBe(2);
    release();
  });

  test("a job that throws or rejects is logged, and the server goes on", async () => {
    const app = await open();
    app.cron.add("sync", "* * * * *", () => {
      throw new Error("sync failure");
    });
    app.cron.add("async", "* * * * *", async () => {
      await Promise.resolve();
      throw new Error("async failure");
    });

    await runJob(app, "sync");
    await runJob(app, "async");

    expect(app.logged.map((l) => [l.message, (l.cause as Error).message])).toEqual([
      ["[FireAndForget] RECOVERED FROM PANIC", "sync failure"],
      ["[FireAndForget] RECOVERED FROM PANIC", "async failure"],
    ]);
    expect((await send(app, "GET", "/api/crons")).status).toBe(200);
  });
});

describe("the cleanup jobs", () => {
  test("__pbOTPCleanup__ deletes the expired OTPs", async () => {
    const app = await open(writeOTPs);
    await runJob(app, "__pbOTPCleanup__");
    expect(ids(app, "_otps")).toEqual([liveRow]);
    expect(app.warned).toEqual([]);
  });

  test("__pbMFACleanup__ deletes the expired MFAs", async () => {
    const app = await open(writeMFAs);
    await runJob(app, "__pbMFACleanup__");
    expect(ids(app, "_mfas")).toEqual([liveRow]);
    expect(app.warned).toEqual([]);
  });

  test("the hourly tick of the same minute runs both", async () => {
    const app = await open((dataDir) => {
      writeOTPs(dataDir);
      writeMFAs(dataDir);
    });
    app.cron.runDue(new Date("2030-01-01T10:00:00Z"));
    await app.cron.waitForRunning(5000);
    expect(ids(app, "_otps")).toEqual([liveRow]);
    expect(ids(app, "_mfas")).toEqual([liveRow]);
  });

  test("__pbLogsCleanup__ deletes the logs past maxDays", async () => {
    const now = new Date("2030-03-15T12:00:00Z");
    const app = await open((dataDir) => {
      const db = new Database(join(dataDir, "auxiliary.db"));
      for (const [id, created] of [
        ["old", "2030-03-08 11:59:59.999Z"],
        ["boundary", "2030-03-08 12:00:00.000Z"],
        ["kept", "2030-03-08 12:00:00.001Z"],
      ]) {
        db.query("INSERT INTO _logs (id, created) VALUES (?, ?)").run(id!, created!);
      }
      db.close();
    }, now);
    app.settings.Logs.MaxDays = 7;

    await runJob(app, "__pbLogsCleanup__");

    expect(
      app.databases.auxDB().newQuery("SELECT id FROM _logs ORDER BY id").column<string>(),
    ).toEqual(["kept"]);
    expect(app.warned).toEqual([]);
  });

  test("deleteOldLogs formats the date in UTC with milliseconds", async () => {
    const app = await open();
    const db = app.databases.auxNonconcurrentDB();
    db.newQuery(
      "INSERT INTO _logs (id, created) VALUES ('a', '2030-01-01 00:00:00.123Z')",
    ).execute();

    deleteOldLogs(app, new Date("2030-01-01T00:00:00.122Z"));
    expect(db.newQuery("SELECT count(*) FROM _logs WHERE id = 'a'").column<number>()).toEqual([1]);

    deleteOldLogs(app, new Date("2030-01-01T00:00:00.123Z"));
    expect(db.newQuery("SELECT count(*) FROM _logs WHERE id = 'a'").column<number>()).toEqual([0]);
  });

  test("a failed job logs upstream's warning", async () => {
    const app = await open();
    app.databases.auxNonconcurrentDB().newQuery("DROP TABLE _logs").execute();
    app.databases.nonconcurrentDB().newQuery("DROP TABLE _otps").execute();
    app.databases.nonconcurrentDB().newQuery("DROP TABLE _mfas").execute();

    await runJob(app, "__pbLogsCleanup__");
    await runJob(app, "__pbOTPCleanup__");
    await runJob(app, "__pbMFACleanup__");

    expect(app.warned.map((w) => w.message)).toEqual([
      "Failed to delete old logs",
      "Failed to delete expired OTP sessions",
      "Failed to delete expired MFA sessions",
    ]);
    expect(app.logged).toEqual([]);
  });
});

describe("__pbDBOptimize__", () => {
  test("truncates both WAL files", async () => {
    const app = await open();
    writeSomething(app);
    expect(walSize(app, "data.db")).toBeGreaterThan(0);
    expect(walSize(app, "auxiliary.db")).toBeGreaterThan(0);

    await runJob(app, "__pbDBOptimize__");

    expect(walSize(app, "data.db")).toBe(0);
    expect(walSize(app, "auxiliary.db")).toBe(0);
    expect(app.warned).toEqual([]);
    expect(app.logged).toEqual([]);
  });

  test("runs its pragmas in upstream's order", async () => {
    const dataDir = join(tempDir(), "pb_data");
    copyDataDir(fixtureDir, dataDir);
    const lines: string[] = [];
    const app = await bootstrap({
      dataDir,
      isDev: true,
      encryptionEnv: "",
      queryTimeout: 30,
      clock: { now: () => new Date() },
      logger: { error: () => {}, warn: () => {} },
      readWorkers: 0,
      devSQLLog: (line) => lines.push(line),
    });

    lines.length = 0;
    const job = app.cron.jobs().find((j) => j.id === "__pbDBOptimize__")!;
    app.cron.fireAndForget(job);
    await app.cron.waitForRunning(5000);
    await clearBootstrap(app);

    // data.db's statements: the auxiliary checkpoint runs between these two
    expect(lines.map((l) => l.replace(/^\S+ /, ""))).toEqual([
      "PRAGMA wal_checkpoint(TRUNCATE)",
      "PRAGMA optimize",
    ]);
  });

  test("a reader that holds up the checkpoint fails nothing", async () => {
    const app = await open();
    writeSomething(app);

    // an open read transaction pins the WAL
    const reader = new Database(join(app.dataDir, "data.db"), { readonly: true });
    reader.run("BEGIN");
    reader.query("SELECT count(*) FROM _params").get();
    writeSomething(app);
    const before = walSize(app, "data.db");

    // no waiting out the 10 seconds of busy_timeout here
    app.databases.nonconcurrentDB().newQuery("PRAGMA busy_timeout(1)").execute();
    await runJob(app, "__pbDBOptimize__");
    expect(walSize(app, "data.db")).toBe(before);
    expect(app.warned).toEqual([]);
    expect(app.logged).toEqual([]);

    reader.run("COMMIT");
    reader.close();
    await runJob(app, "__pbDBOptimize__");
    expect(walSize(app, "data.db")).toBe(0);
  });

  test("writes no rows of its own", async () => {
    const app = await open();
    const tables = (): string[] =>
      app.databases
        .db()
        .newQuery("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
        .column<string>();
    const before = tables();

    await runJob(app, "__pbDBOptimize__");

    expect(tables()).toEqual(before);
  });
});

describe("the shutdown", () => {
  test("clearBootstrap stops the ticker", async () => {
    const { app, dataDir } = await openOwn();
    app.cron.start();
    await clearBootstrap(app);
    expect(app.cron.hasStarted()).toBe(false);
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("clearBootstrap waits for a running job, which writes before the close", async () => {
    const { app, dataDir } = await openOwn();
    app.cron.add("slow", "* * * * *", async () => {
      await Bun.sleep(1);
      app.databases.nonconcurrentDB().newQuery("UPDATE _params SET updated = 'written'").execute();
    });
    app.cron.fireAndForget(app.cron.jobs().find((j) => j.id === "slow")!);

    await clearBootstrap(app);

    const db = new Database(join(dataDir, "data.db"), { readonly: true });
    const row = db.query("SELECT count(*) AS n FROM _params WHERE updated = 'written'").get();
    db.close();
    expect((row as { n: number }).n).toBeGreaterThan(0);
    expect(app.logged).toEqual([]);
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("a job that runs after the close fails into the log", async () => {
    const { app, dataDir } = await openOwn();
    await clearBootstrap(app);

    for (const id of ["__pbOTPCleanup__", "__pbMFACleanup__", "__pbLogsCleanup__"]) {
      app.cron.fireAndForget(app.cron.jobs().find((j) => j.id === id)!);
    }
    app.cron.fireAndForget(app.cron.jobs().find((j) => j.id === "__pbDBOptimize__")!);
    await app.cron.waitForRunning(5000);

    expect(app.warned.map((w) => w.message)).toEqual([
      "Failed to delete expired OTP sessions",
      "Failed to delete expired MFA sessions",
      "Failed to delete old logs",
      "Failed to run periodic PRAGMA wal_checkpoint for the main DB",
      "Failed to run periodic PRAGMA wal_checkpoint for the auxiliary DB",
      "Failed to run periodic PRAGMA optimize",
    ]);
    expect(app.logged).toEqual([]);
    rmSync(dataDir, { recursive: true, force: true });
  });
});
