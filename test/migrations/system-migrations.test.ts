// Upstream: core/base.go Bootstrap (RunSystemMigrations, the temp dir
// cleanup), core/migrations_runner.go Up for the system list and
// migrations/1640988000_aux_init.go's ReapplyCondition, with the open
// rules of docs/design/03-data-compatibility.md "Migrations".
//
// Each case bootstraps an app on a pb_data directory and reads the
// directory back. Upstream's MigrationsList and runner tests
// (core/migrations_list_test.go, core/migrations_runner_test.go) exercise
// user migrations, up/down and history-sync: M3.7. That the fresh install
// equals upstream's byte for byte is checked against the upstream binary
// in test/differential/migrations/.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrap, clearBootstrap, LocalTempDirName } from "@/app/bootstrap";
import type { Clock } from "@/app/clock";
import {
  olderDataMessage,
  OlderDataError,
  systemMigrationFiles,
} from "@/migrations/system-migrations";

import { openFixtureApp } from "@test/app/app";
import { dumpPbData, execSQL, fileState } from "@test/migrations/dump";
import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";

const fixedTime = new Date(Date.UTC(2026, 9, 29, 10, 11, 12, 345));
const clock: Clock = { now: () => fixedTime };

function newRoot(): string {
  return mkdtempSync(join(tmpdir(), "iglo-base-migrations-"));
}

function fixtureCopy(): string {
  const dataDir = join(newRoot(), "pb_data");
  copyDataDir(fixtureDir, dataDir);
  return dataDir;
}

// bootstraps on dataDir and closes again; returns the warnings
async function open(dataDir: string): Promise<string[]> {
  const app = await openFixtureApp({ dataDir, clock });
  await app.cleanup();
  return app.warnings;
}

async function openError(dataDir: string): Promise<unknown> {
  try {
    await bootstrap({
      dataDir,
      isDev: false,
      encryptionEnv: "",
      queryTimeout: 30,
      clock,
      logger: { error: () => {} },
      readWorkers: 0,
    });
  } catch (err) {
    return err;
  }
  return undefined;
}

describe("fresh install", () => {
  test("creates the data dir, the system schema and every system migration row", async () => {
    const dataDir = join(newRoot(), "nested", "pb_data");
    await open(dataDir);

    const dump = dumpPbData(dataDir);
    expect(dump.migrations).toEqual(
      systemMigrationFiles.map((file) => ({ file, applied: fixedTime.getTime() * 1000 })),
    );
    expect(dump.migrations.map((m) => m.file)).toEqual([
      "1640988000_aux_init.go",
      "1640988000_init.go",
      "1717233556_v0.23_migrate.go",
      "1717233557_v0.23_migrate2.go",
      "1717233558_v0.23_migrate3.go",
      "1717233559_v0.23_migrate4.go",
      "1763020353_update_default_auth_alert_templates.go",
      "1778828400_normalize_indexes.go",
    ]);
    expect(dump.dataSchema.filter((r) => r.type === "table").map((r) => r.name)).toEqual([
      "_migrations",
      "_params",
      "_collections",
      "_mfas",
      "sqlite_stat1",
      "_otps",
      "_externalAuths",
      "_authOrigins",
      "_superusers",
      "users",
    ]);
    expect(dump.auxSchema.map((r) => r.name)).toEqual([
      "_logs",
      "sqlite_autoindex__logs_1",
      "idx_logs_level",
      "idx_logs_message",
      "idx_logs_created_hour",
    ]);
    expect(dump.collections.map((c) => [c.name, c.id, c.type, c.system])).toEqual([
      ["_mfas", "pbc_2279338944", "base", 1],
      ["_otps", "pbc_1638494021", "base", 1],
      ["_externalAuths", "pbc_2281828961", "base", 1],
      ["_authOrigins", "pbc_4275539003", "base", 1],
      ["_superusers", "pbc_3142635823", "auth", 1],
      ["users", "_pb_users_auth_", "auth", 0],
    ]);
    // the default settings row, written by the settings load
    expect(dump.params).toEqual([{ id: "settings" }]);
  });

  test("a second open writes nothing", async () => {
    const dataDir = join(newRoot(), "pb_data");
    await open(dataDir);
    const before = dumpPbData(dataDir);
    let time = fixedTime.getTime();
    const later = await openFixtureApp({ dataDir, clock: { now: () => new Date((time += 1000)) } });
    await later.cleanup();
    expect(dumpPbData(dataDir)).toEqual(before);
    expect(later.warnings).toEqual([]);
  });

  test("an empty `_migrations` table is a fresh install", async () => {
    const dataDir = join(newRoot(), "pb_data");
    mkdirSync(dataDir);
    execSQL(
      join(dataDir, "data.db"),
      "CREATE TABLE `_migrations` (file VARCHAR(255) PRIMARY KEY NOT NULL, applied INTEGER NOT NULL)",
    );
    await open(dataDir);
    expect(dumpPbData(dataDir).migrations.map((m) => m.file)).toEqual([...systemMigrationFiles]);
  });
});

describe("existing data", () => {
  test("the v0.41.0 fixture opens without any write", async () => {
    const dataDir = fixtureCopy();
    const before = dumpPbData(dataDir);
    expect(await open(dataDir)).toEqual([]);
    expect(dumpPbData(dataDir)).toEqual(before);
  });

  test("a v0.40.x `_migrations` set (the eight system rows only) opens without any write", async () => {
    // a v0.40.6 fresh install records exactly the v0.41.0 system rows
    const dataDir = fixtureCopy();
    execSQL(
      join(dataDir, "data.db"),
      `DELETE FROM _migrations WHERE file NOT IN (${systemMigrationFiles.map((f) => `'${f}'`).join(", ")})`,
    );
    const before = dumpPbData(dataDir);
    expect(before.migrations.length).toBe(systemMigrationFiles.length);
    expect(await open(dataDir)).toEqual([]);
    expect(dumpPbData(dataDir)).toEqual(before);
  });

  for (const file of systemMigrationFiles) {
    test(`a missing ${file} row is refused`, async () => {
      const dataDir = fixtureCopy();
      execSQL(join(dataDir, "data.db"), `DELETE FROM _migrations WHERE file = '${file}'`);
      const before = dumpPbData(dataDir);
      const err = await openError(dataDir);
      expect(err).toBeInstanceOf(OlderDataError);
      expect((err as Error).message).toBe(
        "This pb_data was written by an older PocketBase. Run PocketBase v0.41.0 on it once, then start iglo.base.",
      );
      expect(dumpPbData(dataDir)).toEqual(before);
    });
  }

  test("pre-v0.23 data (no v0.23 rows, old tables) is refused", async () => {
    const dataDir = fixtureCopy();
    execSQL(
      join(dataDir, "data.db"),
      "DELETE FROM _migrations WHERE file NOT LIKE '16%' AND file NOT LIKE '%.js'",
    );
    expect(((await openError(dataDir)) as Error).message).toBe(olderDataMessage);
  });

  test("data without a `_migrations` table is refused, and none is created", async () => {
    const dataDir = fixtureCopy();
    execSQL(join(dataDir, "data.db"), "DROP TABLE _migrations");
    expect(((await openError(dataDir)) as Error).message).toBe(olderDataMessage);
    expect(dumpPbData(dataDir).dataSchema.some((r) => r.name === "_migrations")).toBe(false);
  });

  test("a missing system collection is refused", async () => {
    const dataDir = fixtureCopy();
    execSQL(join(dataDir, "data.db"), "DELETE FROM _collections WHERE name = '_otps'");
    expect(((await openError(dataDir)) as Error).message).toBe(olderDataMessage);
  });

  test("unknown newer .go rows produce one warning; every row is kept", async () => {
    const dataDir = fixtureCopy();
    execSQL(
      join(dataDir, "data.db"),
      "INSERT INTO _migrations (file, applied) VALUES ('1790000000_future.go', 1), ('1790000001_future2.go', 2), ('1790000002_user.js', 3), ('1700000000_old_unknown.go', 4)",
    );
    const before = dumpPbData(dataDir);
    expect(await open(dataDir)).toEqual([
      "pb_data has migrations newer than PocketBase v0.41.0 (1790000000_future.go, 1790000001_future2.go); the data may come from a newer PocketBase.",
    ]);
    expect(dumpPbData(dataDir)).toEqual(before);
  });

  test("user and historical rows produce no warning", async () => {
    const dataDir = fixtureCopy();
    // the fixture has .js user migrations and pre-v0.23 system rows
    const before = dumpPbData(dataDir);
    expect(before.migrations.some((m) => m.file.endsWith(".js"))).toBe(true);
    expect(before.migrations.some((m) => m.file === "1673167670_multi_match_migrate.go")).toBe(
      true,
    );
    expect(await open(dataDir)).toEqual([]);
  });

  test("a missing `_logs` table is created again and its row re-recorded (ReapplyCondition)", async () => {
    const dataDir = fixtureCopy();
    rmSync(join(dataDir, "auxiliary.db"));
    const before = dumpPbData(dataDir);
    expect(before.auxSchema).toEqual([]);

    await open(dataDir);

    const after = dumpPbData(dataDir);
    expect(after.auxSchema.map((r) => r.name)).toEqual([
      "_logs",
      "sqlite_autoindex__logs_1",
      "idx_logs_level",
      "idx_logs_message",
      "idx_logs_created_hour",
    ]);
    expect(after.migrations).toEqual([
      ...before.migrations.filter((m) => m.file !== "1640988000_aux_init.go"),
      { file: "1640988000_aux_init.go", applied: fixedTime.getTime() * 1000 },
    ]);
    expect(after.dataSchema).toEqual(before.dataSchema);
  });
});

describe("bootstrap", () => {
  test("removes the pb_data temp directory and keeps other files", async () => {
    const dataDir = fixtureCopy();
    mkdirSync(join(dataDir, LocalTempDirName, "nested"), { recursive: true });
    writeFileSync(join(dataDir, LocalTempDirName, "nested", "file.txt"), "x");
    writeFileSync(join(dataDir, "types.d.ts"), "// kept");
    await open(dataDir);
    expect(existsSync(join(dataDir, LocalTempDirName))).toBe(false);
    expect(existsSync(join(dataDir, "types.d.ts"))).toBe(true);
  });

  test("a refused open writes nothing to pb_data and keeps the temp directory", async () => {
    const dataDir = fixtureCopy();
    mkdirSync(join(dataDir, LocalTempDirName));
    rmSync(join(dataDir, "auxiliary.db"));
    execSQL(
      join(dataDir, "data.db"),
      "DELETE FROM _migrations WHERE file = '1640988000_init.go'",
      "PRAGMA journal_mode = DELETE",
    );
    const before = fileState(dataDir);
    expect(await openError(dataDir)).toBeInstanceOf(OlderDataError);
    expect(fileState(dataDir)).toEqual(before);
  });

  test("clearBootstrap closes the databases: SQLite removes the -wal and -shm files", async () => {
    const dataDir = fixtureCopy();
    const app = await openFixtureApp({ dataDir, clock, readWorkers: 2 });
    expect(existsSync(join(dataDir, "data.db-wal"))).toBe(true);
    await clearBootstrap(app);
    expect(Object.keys(fileState(dataDir)).filter((name) => /\.db-(wal|shm)$/.test(name))).toEqual(
      [],
    );
    await app.cleanup();
  });
});
