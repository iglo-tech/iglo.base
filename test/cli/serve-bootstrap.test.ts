// Upstream: pocketbase.go Execute (Bootstrap before the command, log.Fatal
// of its error) and core/base.go Bootstrap, through the compiled
// executable: `serve` opens or creates pb_data before it listens, refuses
// older data with a nonzero exit, warns once about newer migrations and
// clears the pb_data temp directory.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";
import { crashSQL, dumpPbData, execSQL, fileState } from "@test/migrations/dump";
import { run, startServer, tempDir } from "@test/support/executable";

function fixtureCopy(): string {
  const dataDir = join(tempDir(), "pb_data");
  copyDataDir(fixtureDir, dataDir);
  return dataDir;
}

// the refusal as the executable reports it, and that pb_data is unchanged
// byte for byte: no file created (auxiliary.db, -wal, -shm), none changed
// (data.db keeps its journal mode)
async function expectRefusedWithoutWrites(dataDir: string): Promise<void> {
  const before = fileState(dataDir);
  const result = await run(["serve", "--dir", dataDir, "--http", "127.0.0.1:0"]);
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toMatch(
    /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} This pb_data was written by an older PocketBase\. Run PocketBase v0\.41\.0 on it once, then start iglo\.base\.\n$/,
  );
  expect(fileState(dataDir)).toEqual(before);
}

// a writer killed in an open DELETE-mode transaction whose pages spilled
// to data.db: a hot data.db-journal that a read-only connection cannot
// roll back
function crashInTransaction(dataPath: string): void {
  crashSQL(
    dataPath,
    "PRAGMA cache_size = 5",
    "BEGIN IMMEDIATE",
    "UPDATE _params SET value = zeroblob(1000000)",
  );
}

describe("serve bootstrap", () => {
  test("a new pb_data gets the system schema and serves", async () => {
    const dataDir = join(tempDir(), "pb_data");
    const server = await startServer([], dataDir);
    const res = await fetch(`${server.url}/api/health`);
    expect(res.status).toBe(200);
    const result = await server.stop();
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");

    const dump = dumpPbData(dataDir);
    expect(dump.migrations).toHaveLength(8);
    expect(dump.collections.map((c) => c.name)).toEqual([
      "_mfas",
      "_otps",
      "_externalAuths",
      "_authOrigins",
      "_superusers",
      "users",
    ]);
  });

  test("the fixture opens without any write and loads auth", async () => {
    const dataDir = fixtureCopy();
    const before = dumpPbData(dataDir);
    const server = await startServer([], dataDir);
    const res = await fetch(`${server.url}/api/health`, {
      headers: {
        // upstream's fixture superuser token (test data, expires in 2050)
        Authorization:
          "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6InN5d2JoZWNuaDQ2cmhtMCIsInR5cGUiOiJhdXRoIiwiY29sbGVjdGlvbklkIjoicGJjXzMxNDI2MzU4MjMiLCJleHAiOjI1MjQ2MDQ0NjEsInJlZnJlc2hhYmxlIjp0cnVlfQ.UXgO3j-0BumcugrFjbd7j0M4MQvbrLggLlcu_YNGjoY",
        "X-Forwarded-For": "1.2.3.4",
      },
    });
    expect(await res.json()).toEqual({
      message: "API is healthy.",
      code: 200,
      data: { canBackup: true, possibleProxyHeader: "X-Forwarded-For", realIP: "127.0.0.1" },
    });
    const result = await server.stop();
    expect(result.exitCode).toBe(0);
    expect(dumpPbData(dataDir)).toEqual(before);
  });

  test("older data is refused with the documented message and exit code 1, and nothing is written", async () => {
    const dataDir = fixtureCopy();
    execSQL(
      join(dataDir, "data.db"),
      "DELETE FROM _migrations WHERE file = '1778828400_normalize_indexes.go'",
    );
    await expectRefusedWithoutWrites(dataDir);
  });

  test("a missing system migration row with no auxiliary.db and a DELETE-mode data.db is refused without writes", async () => {
    const dataDir = fixtureCopy();
    rmSync(join(dataDir, "auxiliary.db"));
    execSQL(
      join(dataDir, "data.db"),
      "DELETE FROM _migrations WHERE file = '1778828400_normalize_indexes.go'",
      "PRAGMA journal_mode = DELETE",
    );
    expect(Object.keys(fileState(dataDir)).some((name) => name.startsWith("auxiliary.db"))).toBe(
      false,
    );
    await expectRefusedWithoutWrites(dataDir);
  });

  test("pre-v0.23-shaped data (logs.db, no auxiliary.db) is refused without writes", async () => {
    const dataDir = fixtureCopy();
    rmSync(join(dataDir, "auxiliary.db"));
    // before v0.23 the request logs were in logs.db and _migrations ended
    // with the v0.22 rows
    execSQL(
      join(dataDir, "logs.db"),
      "CREATE TABLE `_requests` (`id` TEXT PRIMARY KEY NOT NULL, `url` TEXT DEFAULT '' NOT NULL)",
      "PRAGMA journal_mode = DELETE",
    );
    execSQL(
      join(dataDir, "data.db"),
      "DELETE FROM _migrations WHERE file NOT LIKE '16%' AND file NOT LIKE '%.js'",
      "PRAGMA journal_mode = DELETE",
    );
    await expectRefusedWithoutWrites(dataDir);
  });

  test("a missing system migration row behind a hot rollback journal is refused without writes", async () => {
    const dataDir = fixtureCopy();
    rmSync(join(dataDir, "auxiliary.db"));
    const dataPath = join(dataDir, "data.db");
    execSQL(
      dataPath,
      "PRAGMA journal_mode = DELETE",
      "DELETE FROM _migrations WHERE file = '1778828400_normalize_indexes.go'",
    );
    crashInTransaction(dataPath);
    expect(
      readdirSync(dataDir)
        .filter((name) => name.startsWith("data.db"))
        .toSorted(),
    ).toEqual(["data.db", "data.db-journal"]);
    await expectRefusedWithoutWrites(dataDir);
  });

  for (const shm of [true, false]) {
    test(`a missing system migration row in a leftover WAL ${shm ? "with" : "without"} -shm is refused without writes`, async () => {
      const dataDir = fixtureCopy();
      const dataPath = join(dataDir, "data.db");
      crashSQL(dataPath, "DELETE FROM _migrations WHERE file = '1778828400_normalize_indexes.go'");
      if (!shm) {
        rmSync(`${dataPath}-shm`);
      }
      expect(
        readdirSync(dataDir)
          .filter((name) => name.startsWith("data.db"))
          .toSorted(),
      ).toEqual(shm ? ["data.db", "data.db-shm", "data.db-wal"] : ["data.db", "data.db-wal"]);
      await expectRefusedWithoutWrites(dataDir);
    });
  }

  test("compatible data with a hot rollback journal or a leftover WAL starts and serves", async () => {
    const journalDir = fixtureCopy();
    execSQL(join(journalDir, "data.db"), "PRAGMA journal_mode = DELETE");
    const journalBefore = dumpPbData(journalDir);
    crashInTransaction(join(journalDir, "data.db"));
    expect(existsSync(join(journalDir, "data.db-journal"))).toBe(true);

    const walDir = fixtureCopy();
    crashSQL(
      join(walDir, "data.db"),
      "INSERT INTO _migrations (file, applied) VALUES ('1700000000_crashed.js', 1)",
    );
    expect(existsSync(join(walDir, "data.db-wal"))).toBe(true);

    for (const dataDir of [journalDir, walDir]) {
      const server = await startServer([], dataDir);
      const res = await fetch(`${server.url}/api/health`);
      expect(res.status).toBe(200);
      const result = await server.stop();
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
    }

    // the interrupted transaction was rolled back; the WAL commit is kept
    expect(dumpPbData(journalDir)).toEqual(journalBefore);
    expect(dumpPbData(walDir).migrations.some((m) => m.file === "1700000000_crashed.js")).toBe(
      true,
    );
  });

  test("a data.db that cannot be read stops the start with SQLite's error and nothing is written", async () => {
    const dataDir = join(tempDir(), "pb_data");
    mkdirSync(dataDir);
    writeFileSync(join(dataDir, "data.db"), "x".repeat(4096));
    const before = fileState(dataDir);
    const result = await run(["serve", "--dir", dataDir, "--http", "127.0.0.1:0"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(
      /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} file is not a database\n$/,
    );
    expect(fileState(dataDir)).toEqual(before);
  });

  test("newer migrations produce one warning", async () => {
    const dataDir = fixtureCopy();
    execSQL(
      join(dataDir, "data.db"),
      "INSERT INTO _migrations (file, applied) VALUES ('1790000000_future.go', 1)",
    );
    const server = await startServer([], dataDir);
    const result = await server.stop();
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toMatch(
      /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2} WARN pb_data has migrations newer than PocketBase v0\.41\.0 \(1790000000_future\.go\); the data may come from a newer PocketBase\.\n$/,
    );
    expect(dumpPbData(dataDir).migrations.some((m) => m.file === "1790000000_future.go")).toBe(
      true,
    );
  });

  test("the pb_data temp directory is removed on start", async () => {
    const dataDir = fixtureCopy();
    mkdirSync(join(dataDir, ".pb_temp_to_delete", "pb_backup_abc"), { recursive: true });
    writeFileSync(join(dataDir, ".pb_temp_to_delete", "pb_backup_abc", "x"), "x");
    const server = await startServer([], dataDir);
    expect(existsSync(join(dataDir, ".pb_temp_to_delete"))).toBe(false);
    await server.stop();
  });
});
