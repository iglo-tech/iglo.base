// The db layer on a copy of upstream's tests/data: the connection pragmas
// compared with the reference binary's own connection, queries on the
// fixture rows, and core/db_table_test.go, core/view_test.go
// (TestDeleteView) and core/db_tx_test.go (TestRunInTransaction) on the
// fixture they were written for. Not part of `bun test`: run
// `bun run test:reference`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { Databases } from "@/db/base";
import { connectPragmas } from "@/db/connect";
import type { DB } from "@/db/dbx/db";
import { HashExp } from "@/db/dbx/expression";
import type { Params, Row } from "@/db/dbx/query";
import { deleteModel, modelQuery } from "@/db/db";
import { BaseModel } from "@/db/model";
import {
  auxHasTable,
  auxVacuum,
  deleteTable,
  deleteView,
  hasTable,
  tableColumns,
  tableIndexes,
  tableInfo,
  vacuum,
} from "@/db/table";
import { runInTransaction } from "@/db/tx";
import {
  copyFixture,
  fixtureChecksums,
  serveUpstream,
  upstreamSQL,
  type FixtureCopy,
} from "@test/differential/db/fixture";

const collectionNameSuperusers = "_superusers";

class Superuser extends BaseModel {
  email = "";

  tableName(): string {
    return collectionNameSuperusers;
  }

  override dbColumns(): Params {
    return { ...super.dbColumns(), email: this.email };
  }

  override dbScan(row: Row): void {
    super.dbScan(row);
    if ("email" in row) this.email = String(row.email);
  }
}

// app.FindAuthRecordByEmail, without the record layer (M1.8)
function findSuperuserByEmail(app: Databases, email: string): Superuser | null {
  const m = new Superuser();
  try {
    return modelQuery(app, m).andWhere(new HashExp({ email })).limit(1).one(m);
  } catch {
    return null;
  }
}

// tests.NewTestApp: a fresh copy of tests/data per test
const copies: FixtureCopy[] = [];
const apps: Databases[] = [];
function newTestApp(): Databases {
  const copy = copyFixture();
  copies.push(copy);
  const app = Databases.open({ dataDir: copy.dataDir });
  apps.push(app);
  return app;
}

let checksumsBefore: Record<string, string>;

beforeAll(() => {
  checksumsBefore = fixtureChecksums();
});

afterAll(() => {
  for (const app of apps) app.close();
  for (const copy of copies) copy.remove();
  // the fixture itself is never written
  expect(fixtureChecksums()).toEqual(checksumsBefore);
});

describe("pragmas", () => {
  const names = connectPragmas.map((p) => p.slice(0, p.indexOf("(")));

  test("are the reference binary's connection values", async () => {
    const upstreamCopy = copyFixture();
    copies.push(upstreamCopy);
    const server = await serveUpstream(upstreamCopy);
    const upstream: Record<string, string> = {};
    try {
      for (const name of names) {
        const rows = await upstreamSQL(server, `PRAGMA ${name}`);
        upstream[name] = String(rows[0]![0]);
      }
    } finally {
      await server.stop();
    }

    const app = newTestApp();
    for (const db of [
      app.concurrentDB(),
      app.nonconcurrentDB(),
      app.auxConcurrentDB(),
      app.auxNonconcurrentDB(),
    ]) {
      const ours: Record<string, string> = {};
      for (const name of names) {
        ours[name] = String(db.newQuery(`PRAGMA ${name}`).row()[0]);
      }
      expect(ours).toEqual(upstream);
    }
    expect(upstream).toEqual({
      busy_timeout: "10000",
      journal_mode: "wal",
      journal_size_limit: "200000000",
      synchronous: "1",
      foreign_keys: "1",
      legacy_alter_table: "0",
      temp_store: "2",
      cache_size: "-32000",
    });
  });
});

describe("fixture rows", () => {
  test("data.db", () => {
    const app = newTestApp();
    expect(
      app.db().select("email").from(collectionNameSuperusers).orderBy("email").column<string>(),
    ).toEqual(["test2@example.com", "test3@example.com", "test4@example.com", "test@example.com"]);

    const superuser = findSuperuserByEmail(app, "test@example.com");
    expect(superuser?.id).toBe("sywbhecnh46rhm0");
    expect(superuser?.isNew()).toBe(false);

    const [count] = app.db().newQuery("SELECT COUNT(*) FROM {{_migrations}}").row();
    expect(count).toBe(77);
  });

  test("auxiliary.db", () => {
    const app = newTestApp();
    const log = app
      .auxDB()
      .select("id", "message")
      .from("_logs")
      .where(new HashExp({ id: "zqj48gjhf7zj0nk" }))
      .one();
    expect(log).toEqual({ id: "zqj48gjhf7zj0nk", message: "PATCH /api/settings" });
  });
});

// Upstream: core/db_table_test.go
describe("db_table_test", () => {
  test("TestHasTable", () => {
    const app = newTestApp();
    const scenarios: [string, boolean][] = [
      ["", false],
      ["test", false],
      [collectionNameSuperusers, true],
      ["demo3", true],
      ["DEMO3", true], // table names are case insensitives by default
      ["view1", true], // view
    ];
    for (const [tableName, expected] of scenarios) {
      expect([tableName, hasTable(app, tableName)]).toEqual([tableName, expected]);
    }
  });

  test("TestAuxHasTable", () => {
    const app = newTestApp();
    const scenarios: [string, boolean][] = [
      ["", false],
      ["test", false],
      ["_lOGS", true], // table names are case insensitives by default
    ];
    for (const [tableName, expected] of scenarios) {
      expect([tableName, auxHasTable(app, tableName)]).toEqual([tableName, expected]);
    }
  });

  test("TestTableColumns", () => {
    const app = newTestApp();
    expect(tableColumns(app, "")).toEqual([]);
    expect(tableColumns(app, "_params").toSorted()).toEqual(
      ["id", "value", "created", "updated"].toSorted(),
    );
  });

  test("TestTableInfo", () => {
    const app = newTestApp();
    expect(() => tableInfo(app, "")).toThrow("empty table info");
    expect(() => tableInfo(app, "missing")).toThrow(
      "empty table info probably due to invalid or missing table missing",
    );
    expect(tableInfo(app, "_params")).toEqual([
      { pk: 0, index: 0, name: "created", type: "TEXT", notNull: true, defaultValue: "''" },
      {
        pk: 1,
        index: 1,
        name: "id",
        type: "TEXT",
        notNull: true,
        defaultValue: "'r'||lower(hex(randomblob(7)))",
      },
      { pk: 0, index: 2, name: "updated", type: "TEXT", notNull: true, defaultValue: "''" },
      { pk: 0, index: 3, name: "value", type: "JSON", notNull: false, defaultValue: "NULL" },
    ]);
  });

  test("TestTableIndexes", () => {
    const app = newTestApp();
    expect(tableIndexes(app, "")).toEqual({});
    expect(tableIndexes(app, "missing")).toEqual({});

    const indexes = tableIndexes(app, collectionNameSuperusers);
    expect(Object.keys(indexes).toSorted()).toEqual([
      "idx_email__pbc_3323866339",
      "idx_tokenKey__pbc_3323866339",
    ]);
    for (const sql of Object.values(indexes)) {
      expect(sql).not.toBe("");
    }
  });

  test("TestDeleteTable", () => {
    const app = newTestApp();
    const scenarios: [string, boolean][] = [
      ["", true],
      ["test", false], // missing tables are ignored
      ["_admins", false],
      ["demo3", false],
    ];
    for (const [tableName, expectError] of scenarios) {
      let hasErr = false;
      try {
        deleteTable(app, tableName);
      } catch {
        hasErr = true;
      }
      expect([tableName, hasErr]).toEqual([tableName, expectError]);
    }
    expect(hasTable(app, "demo3")).toBe(false);
  });

  test("TestVacuum", () => {
    const app = newTestApp();
    const calledQueries: string[] = [];
    const db = app.nonconcurrentDB() as DB;
    db.queryLogFunc = (_ms, sql) => calledQueries.push(sql);
    db.execLogFunc = (_ms, sql) => calledQueries.push(sql);

    vacuum(app);

    expect(calledQueries).toEqual(["VACUUM"]);
  });

  test("TestAuxVacuum", () => {
    const app = newTestApp();
    const calledQueries: string[] = [];
    const db = app.auxNonconcurrentDB() as DB;
    db.queryLogFunc = (_ms, sql) => calledQueries.push(sql);
    db.execLogFunc = (_ms, sql) => calledQueries.push(sql);

    auxVacuum(app);

    expect(calledQueries).toEqual(["VACUUM"]);
  });
});

// Upstream: core/view_test.go TestDeleteView
test("TestDeleteView", () => {
  const app = newTestApp();
  const scenarios: [string, boolean][] = [
    ["", true],
    ["demo1", true], // not a view table
    ["missing", false], // missing or already deleted
    ["view1", false], // existing
    ["VieW1", false], // view names are case insensitives
  ];
  for (const [viewName, expectError] of scenarios) {
    let hasErr = false;
    try {
      deleteView(app, viewName);
    } catch {
      hasErr = true;
    }
    expect([viewName, hasErr]).toEqual([viewName, expectError]);
  }
  expect(hasTable(app, "view1")).toBe(false);
});

// Upstream: core/db_tx_test.go TestRunInTransaction
describe("TestRunInTransaction", () => {
  const app = newTestApp();

  test("failed nested transaction", () => {
    expect(() =>
      runInTransaction(app, (txApp) => {
        const superuser = findSuperuserByEmail(txApp, "test@example.com")!;

        runInTransaction(txApp, (tx2Dao) => {
          deleteModel(tx2Dao, superuser);
          throw new Error("test error");
        });
      }),
    ).toThrow("test error");

    // superuser should still exist
    expect(findSuperuserByEmail(app, "test@example.com")).not.toBeNull();
  });

  test("successful nested transaction", () => {
    runInTransaction(app, (txApp) => {
      const superuser = findSuperuserByEmail(txApp, "test@example.com")!;

      runInTransaction(txApp, (tx2Dao) => {
        deleteModel(tx2Dao, superuser);
      });
    });

    // superuser should have been deleted
    expect(findSuperuserByEmail(app, "test@example.com")).toBeNull();
  });
});
