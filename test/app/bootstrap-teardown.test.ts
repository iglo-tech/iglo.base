// Upstream: core/base.go Bootstrap and ClearBootstrap. A failing teardown
// step does not leave the databases open, and a failed bootstrap does not
// leave its read workers (and so the WAL files) behind. SQLite removes the
// -wal and -shm files when the last connection closes.

import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { bootstrap, clearBootstrap } from "@/app/bootstrap";

import { testLogger } from "@test/support/logger";
import { execSQL } from "@test/migrations/dump";
import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";
import { tempDir } from "@test/support/executable";

function walFiles(dataDir: string): string[] {
  return ["data.db-wal", "auxiliary.db-wal"].filter((name) => existsSync(join(dataDir, name)));
}

function config(dataDir: string) {
  return {
    dataDir,
    isDev: false,
    encryptionEnv: "",
    queryTimeout: 30,
    clock: { now: () => new Date(0) },
    logger: testLogger(),
    readWorkers: 2,
  };
}

test("clearBootstrap closes everything even if a step fails, and reports the error", async () => {
  const dataDir = join(tempDir(), "pb_data");
  copyDataDir(fixtureDir, dataDir);
  const app = await bootstrap(config(dataDir));
  // a connection is open: the WAL files exist
  expect(walFiles(dataDir).length).toBeGreaterThan(0);

  (app.cron as unknown as { waitForRunning: () => Promise<void> }).waitForRunning = () =>
    Promise.reject(new Error("cron did not stop"));

  await expect(clearBootstrap(app)).rejects.toThrow("cron did not stop");
  expect(walFiles(dataDir)).toEqual([]);
});

test("a failed bootstrap leaves no open database", async () => {
  const dataDir = join(tempDir(), "pb_data");
  copyDataDir(fixtureDir, dataDir);
  // a settings row that cannot be loaded
  execSQL(join(dataDir, "data.db"), "UPDATE _params SET value = 'not json' WHERE id = 'settings'");

  await expect(bootstrap(config(dataDir))).rejects.toThrow();
  expect(walFiles(dataDir)).toEqual([]);
});

test("clearBootstrap names every failing step in its error message", async () => {
  const dataDir = join(tempDir(), "pb_data");
  copyDataDir(fixtureDir, dataDir);
  const app = await bootstrap(config(dataDir));
  const cron = app.cron as unknown as { waitForRunning: () => Promise<void> };
  cron.waitForRunning = () => Promise.reject(new Error("cron did not stop"));
  const thumbs = app.thumbs as unknown as { close: () => Promise<void> };
  thumbs.close = () => Promise.reject(new Error("thumbs did not close"));

  const err = await clearBootstrap(app).then(
    () => undefined,
    (e: Error) => e,
  );
  expect(err?.message).toBe("cron did not stop\nthumbs did not close");
  expect(walFiles(dataDir)).toEqual([]);
});
