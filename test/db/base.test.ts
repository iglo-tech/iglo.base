// Upstream: core/base.go (initDataDB, initAuxDB, DB/AuxDB routing,
// ClearBootstrap closing the databases, normalizeSQLLog), core/db_connect.go
// (the pragmas) and core/db_builder.go (dualDBBuilder routing).

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { auxDBFilename, Databases, dataDBFilename, normalizeSQLLog } from "@/db/base";
import { DualDBBuilder, hasPrefixFold, trimLeftSpaces } from "@/db/dual-builder";
import { runInTransaction } from "@/db/tx";

import { getDB, openTempDatabases, tempDir } from "@test/db/support";

// the values upstream's DSN pragmas leave on a connection
const expectedPragmas: Record<string, unknown> = {
  busy_timeout: 10000,
  journal_mode: "wal",
  journal_size_limit: 200000000,
  synchronous: 1, // NORMAL
  foreign_keys: 1,
  temp_store: 2, // MEMORY
  cache_size: -32000,
};

describe("open", () => {
  test("creates both files with upstream's pragmas on every builder", () => {
    const dataDir = tempDir();
    const app = Databases.open({ dataDir });
    expect(existsSync(join(dataDir, dataDBFilename))).toBe(true);
    expect(existsSync(join(dataDir, auxDBFilename))).toBe(true);

    for (const db of [
      app.concurrentDB(),
      app.nonconcurrentDB(),
      app.auxConcurrentDB(),
      app.auxNonconcurrentDB(),
    ]) {
      for (const [pragma, value] of Object.entries(expectedPragmas)) {
        expect(db.newQuery(`PRAGMA ${pragma}`).row(), pragma).toEqual([value]);
      }
    }
    app.close();
  });

  test("creates no tables", () => {
    const { app } = openTempDatabases();
    // only the test helper's tables
    expect(app.concurrentDB().newQuery("SELECT name FROM sqlite_schema").column()).toEqual([
      "demo",
      "sqlite_autoindex_demo_1",
    ]);
    app.close();
  });

  test("a missing data directory fails", () => {
    expect(() => Databases.open({ dataDir: join(tempDir(), "missing") })).toThrow();
  });
});

describe("routing", () => {
  test("DB() routes SELECTs to the concurrent builder and the rest to the nonconcurrent one", () => {
    const { app } = openTempDatabases();
    const db = app.db();
    expect(db).toBeInstanceOf(DualDBBuilder);
    const dual = db as DualDBBuilder;
    expect(dual.concurrentDB).toBe(app.concurrentDB());
    expect(dual.nonconcurrentDB).toBe(app.nonconcurrentDB());
    expect(app.concurrentDB()).not.toBe(app.nonconcurrentDB());

    const aux = app.auxDB() as DualDBBuilder;
    expect(aux.concurrentDB).toBe(app.auxConcurrentDB());
    expect(aux.nonconcurrentDB).toBe(app.auxNonconcurrentDB());
    app.close();
  });

  test("NewQuery routing", () => {
    const concurrent = getDB();
    const nonconcurrent = getDB();
    const dual = new DualDBBuilder(concurrent, nonconcurrent);
    const route = (sql: string) => {
      const used: string[] = [];
      concurrent.execLogFunc = () => used.push("concurrent");
      concurrent.queryLogFunc = () => used.push("concurrent");
      nonconcurrent.execLogFunc = () => used.push("nonconcurrent");
      nonconcurrent.queryLogFunc = () => used.push("nonconcurrent");
      dual.newQuery(sql).execute();
      return used[0];
    };
    expect(route("SELECT 1")).toBe("concurrent");
    expect(route(" \n\tselect 1")).toBe("concurrent");
    expect(route("WITH a AS (SELECT 1) SELECT * FROM a")).toBe("concurrent");
    expect(route("CREATE TABLE t (id)")).toBe("nonconcurrent");
    expect(route("PRAGMA user_version")).toBe("nonconcurrent");
  });

  test("trimLeftSpaces and hasPrefixFold", () => {
    expect(trimLeftSpaces(" \t\n\v\f\r 　x y ")).toBe("x y ");
    expect(hasPrefixFold("select", "SELECT")).toBe(true);
    expect(hasPrefixFold("SeLeCt *", "SELECT")).toBe(true);
    expect(hasPrefixFold("SEL", "SELECT")).toBe(false);
    // Go compares bytes: a non-ASCII letter does not fold to an ASCII one
    expect(hasPrefixFold("ſELECT", "SELECT")).toBe(false);
  });
});

describe("close", () => {
  test("closes both files once", () => {
    const { app } = openTempDatabases();
    app.close();
    app.close();
    expect(() => app.concurrentDB()).toThrow("the databases are closed");
    expect(() => app.auxDB()).toThrow("the databases are closed");
  });
});

describe("--dev SQL log", () => {
  test("logs data.db statements as upstream prints them", () => {
    const dataDir = tempDir();
    const lines: string[] = [];
    const app = Databases.open({ dataDir, devSQLLog: (line) => lines.push(line) });

    app.nonconcurrentDB().newQuery("CREATE TABLE {{demo}} ([[id]] TEXT)").execute();
    app
      .concurrentDB()
      .newQuery("SELECT * FROM {{demo}} WHERE [[demo.id]]={:id}")
      .bind({ id: null })
      .all();
    app.auxNonconcurrentDB().newQuery("CREATE TABLE aux (id TEXT)").execute();

    expect(lines.map((line) => line.replace(/^\[\d+\.00ms\] /, ""))).toEqual([
      "CREATE TABLE `demo` (`id` TEXT)",
      "SELECT * FROM `demo` WHERE `demo`.`id`=NULL",
    ]);
    app.close();
  });

  test("normalizeSQLLog", () => {
    expect(normalizeSQLLog("SELECT {{a}}.* FROM {{a.b}} WHERE [[c.d]]=1 AND x=<nil>")).toBe(
      "SELECT `a`.* FROM `a`.`b` WHERE `c`.`d`=1 AND x=NULL",
    );
  });
});

function titles(dbs: Databases): string[] {
  return dbs.concurrentDB().newQuery("SELECT title FROM demo ORDER BY id").column<string>();
}

describe("committedReads", () => {
  test("reads data.db as last committed while a transaction runs", () => {
    const { app } = openTempDatabases();

    app.nonconcurrentDB().newQuery("INSERT INTO demo (id, title) VALUES ('a', 'old')").execute();
    expect(app.committedReads()).toBe(app);

    runInTransaction(app, (txApp) => {
      txApp.nonconcurrentDB().newQuery("UPDATE demo SET title = 'new'").execute();
      txApp.nonconcurrentDB().newQuery("INSERT INTO demo (id, title) VALUES ('b', 'b')").execute();
      expect(titles(txApp)).toEqual(["new", "b"]);

      const committed = txApp.committedReads();
      expect(committed.isTransactional()).toBe(false);
      expect(titles(committed)).toEqual(["old"]);
      // the same connection on later calls
      expect(committed.concurrentDB()).toBe(txApp.committedReads().concurrentDB());
    });

    runInTransaction(app, (txApp) => {
      expect(titles(txApp.committedReads())).toEqual(["new", "b"]);
    });
    app.close();
  });
});
