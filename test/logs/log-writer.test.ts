// Upstream: core/base.go (initLogger) write path, run on the log writer
// thread (D31). Read back through auxiliary.db and the HTTP API.

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBackup } from "@/backups/create";
import { extract } from "@/tools/archive/extract";
import type { Logger } from "@/logs/logger";
import { LogWriter, type LogRow } from "@/logs/log-writer";

import { openFixtureApp, type TestApp } from "@test/app/app";
import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";
import { startServer } from "@test/support/executable";

let dirs: string[] = [];
let apps: TestApp[] = [];

afterEach(async () => {
  for (const app of apps) {
    await app.cleanup();
  }
  apps = [];
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs = [];
});

function freshDir(): string {
  const root = mkdtempSync(join(tmpdir(), "iglo-base-logwriter-"));
  dirs.push(root);
  return root;
}

function logRows(auxPath: string): { message: string; level: number; data: string }[] {
  const db = new Database(auxPath, { readonly: true });
  try {
    return db.query("SELECT message, level, data FROM _logs ORDER BY rowid").all() as {
      message: string;
      level: number;
      data: string;
    }[];
  } finally {
    db.close();
  }
}

describe("the log writer thread", () => {
  test("a batch waits for a lock held by the main thread and is not dropped", async () => {
    const root = freshDir();
    const dataDir = join(root, "pb_data");
    copyDataDir(fixtureDir, dataDir);
    const auxPath = join(dataDir, "auxiliary.db");
    const main = new Database(auxPath);
    main.run("PRAGMA journal_mode = WAL");
    main.run("DELETE FROM _logs");
    const writer = new LogWriter(auxPath, () => {});
    try {
      main.run("BEGIN IMMEDIATE");
      const rows: LogRow[] = [
        ["a".repeat(15), "2026-01-01 00:00:00.000Z", 0, "held back", "{}"],
        ["b".repeat(15), "2026-01-01 00:00:01.000Z", 4, "second", '{"x":1}'],
      ];
      writer.write(rows);
      const flushed = writer.flush();
      await Bun.sleep(300);
      expect((main.query("SELECT COUNT(*) AS n FROM _logs").get() as { n: number }).n).toBe(0);
      main.run("COMMIT");
      await flushed;
      expect(logRows(auxPath)).toEqual([
        { message: "held back", level: 0, data: "{}" },
        { message: "second", level: 4, data: '{"x":1}' },
      ]);
    } finally {
      writer.stopSync();
      main.close();
    }
  }, 30_000);

  test("stop writes what was posted, and a later batch starts the thread again", async () => {
    const root = freshDir();
    const dataDir = join(root, "pb_data");
    copyDataDir(fixtureDir, dataDir);
    const auxPath = join(dataDir, "auxiliary.db");
    const writer = new LogWriter(auxPath, () => {});
    try {
      writer.write([["c".repeat(15), "2026-01-01 00:00:00.000Z", 0, "one", "{}"]]);
      await writer.stop();
      writer.write([["d".repeat(15), "2026-01-01 00:00:00.000Z", 0, "two", "{}"]]);
      writer.stopSync();
      expect(logRows(auxPath).map((r) => r.message)).toContain("two");
      expect(logRows(auxPath).map((r) => r.message)).toContain("one");
    } finally {
      writer.stopSync();
    }
  }, 30_000);

  test("stop gives up on a thread that does not answer, ends it and reports", async () => {
    const root = freshDir();
    const dataDir = join(root, "pb_data");
    copyDataDir(fixtureDir, dataDir);
    const auxPath = join(dataDir, "auxiliary.db");
    const main = new Database(auxPath);
    main.run("PRAGMA journal_mode = WAL");
    const reported: string[] = [];
    const writer = new LogWriter(auxPath, (text) => reported.push(text), 200);
    try {
      // the thread waits for this lock and so never reaches the close
      main.run("BEGIN IMMEDIATE");
      writer.write([["e".repeat(15), "2026-01-01 00:00:00.000Z", 0, "stuck", "{}"]]);
      await writer.stop();
      expect(reported).toHaveLength(1);
      expect(reported[0]).toContain("Failed to stop the log writer");
    } finally {
      main.run("ROLLBACK");
      main.close();
    }

    // the writer is usable again: a later batch starts a new thread
    writer.write([["f".repeat(15), "2026-01-01 00:00:00.000Z", 0, "after", "{}"]]);
    await writer.stop();
    const messages = logRows(auxPath).map((r) => r.message);
    expect(messages).toContain("after");
    expect(messages).not.toContain("stuck");
  }, 30_000);

  test("a backup taken while logs are written holds a consistent auxiliary.db", async () => {
    const app = await openFixtureApp({ ownLogger: true });
    apps.push(app);
    const logger = app.logger as Logger;
    app.databases.auxNonconcurrentDB().newQuery("DELETE FROM _logs").execute();

    const state = { stop: false };
    let count = 0;
    const logging = (async () => {
      while (!state.stop) {
        logger.info(`during backup ${count++}`);
        await Bun.sleep(1);
      }
    })();
    await createBackup(app, "during.zip");
    state.stop = true;
    await logging;
    await logger.suspend();
    logger.resume();
    await logger.flush();

    const out = freshDir();
    await extract(join(app.dataDir, "backups", "during.zip"), join(out, "pb_data"));
    const aux = new Database(join(out, "pb_data", "auxiliary.db"), { readonly: true });
    try {
      expect(aux.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally {
      aux.close();
    }
  }, 60_000);
});

test("logs written just before SIGTERM are in _logs after the executable stopped", async () => {
  const root = freshDir();
  const dataDir = join(root, "pb_data");
  copyDataDir(fixtureDir, dataDir);
  const server = await startServer([], dataDir);
  for (let i = 0; i < 5; i++) {
    expect((await fetch(`${server.url}/api/health`)).status).toBe(200);
  }
  const result = await server.stop();
  expect(result.exitCode).toBe(0);
  const messages = logRows(join(dataDir, "auxiliary.db")).map((r) => r.message);
  expect(messages.filter((m) => m === "GET /api/health").length).toBeGreaterThanOrEqual(5);
}, 60_000);
