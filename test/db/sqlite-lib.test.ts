// D34: on every platform the process runs the SQLite version with the compile
// options of Bun's SQLite on Linux (test/fixtures/sqlite-linux.json). On macOS
// that is the bundled library (IGLO_SQLITE_LIB when running from source), not
// the system one; a missing library is a clear error, never a fallback.

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { bundledSQLiteSourceHash, bundledSQLiteVersion } from "@/db/sqlite-lib";

import { sqliteInfo, type SqliteInfo } from "@test/db/support/sqlite-probe";
import fixture from "@test/fixtures/sqlite-linux.json";

const want: SqliteInfo = { version: fixture.version, options: fixture.compileOptions };

test("the version scripts/build-sqlite.ts builds is the one of Linux", () => {
  expect(bundledSQLiteVersion).toBe(fixture.version);
  expect(fixture.sourceId.endsWith(` ${bundledSQLiteSourceHash}`)).toBe(true);
});

test("the main thread uses the source of Linux's SQLite", () => {
  sqliteInfo();
  const db = new Database(":memory:");
  try {
    expect((db.query("select sqlite_source_id() as s").get() as { s: string }).s).toBe(
      fixture.sourceId,
    );
  } finally {
    db.close();
  }
});

test("the main thread uses the SQLite version and options of Linux", () => {
  expect(sqliteInfo()).toEqual(want);
});

test("a worker thread uses the same SQLite", async () => {
  const worker = new Worker(new URL("support/sqlite-probe-worker.ts", import.meta.url));
  try {
    const info = await new Promise<SqliteInfo>((resolve, reject) => {
      worker.addEventListener("message", (e) => resolve(e.data as SqliteInfo));
      worker.addEventListener("error", (e) => reject(new Error(e.message)));
    });
    expect(info).toEqual(want);
  } finally {
    worker.terminate();
  }
});

test.skipIf(process.platform !== "darwin")(
  "a missing library stops the process with a clear message",
  async () => {
    const proc = Bun.spawn([process.execPath, "test/db/support/sqlite-probe.ts"], {
      cwd: import.meta.dir + "/../..",
      env: { ...process.env, IGLO_SQLITE_LIB: "/nonexistent/libsqlite3.dylib" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).not.toBe(0);
    expect(stderr).toContain("does not fall back to the system SQLite");
  },
);
