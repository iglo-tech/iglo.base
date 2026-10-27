// Upstream: pocketbase/dbx v1.13.0 builder_sqlite_test.go
// getSqliteBuilder() is getDB().builder, which is already a SqliteBuilder.

import { describe, expect, test } from "bun:test";

import type { Builder } from "@/db/dbx/builder";
import { getDB } from "@test/db/support";

function getSqliteBuilder(): Builder {
  return getDB().builder;
}

describe("sqlite builder", () => {
  test("TestSqliteBuilder_QuoteSimpleTableName", () => {
    const b = getSqliteBuilder();
    expect(b.quoteSimpleTableName("abc")).toBe("`abc`");
    expect(b.quoteSimpleTableName("`abc`")).toBe("`abc`");
    expect(b.quoteSimpleTableName("{{abc}}")).toBe("`{{abc}}`");
    expect(b.quoteSimpleTableName("a.bc")).toBe("`a.bc`");
  });

  test("TestSqliteBuilder_QuoteSimpleColumnName", () => {
    const b = getSqliteBuilder();
    expect(b.quoteSimpleColumnName("abc")).toBe("`abc`");
    expect(b.quoteSimpleColumnName("`abc`")).toBe("`abc`");
    expect(b.quoteSimpleColumnName("{{abc}}")).toBe("`{{abc}}`");
    expect(b.quoteSimpleColumnName("a.bc")).toBe("`a.bc`");
    expect(b.quoteSimpleColumnName("*")).toBe("*");
  });

  test("TestSqliteBuilder_DropIndex", () => {
    const b = getSqliteBuilder();
    const q = b.dropIndex("users", "idx");
    expect(q.sql()).toBe("DROP INDEX `idx`");
  });

  test("TestSqliteBuilder_TruncateTable", () => {
    const b = getSqliteBuilder();
    const q = b.truncateTable("users");
    expect(q.sql()).toBe("DELETE FROM `users`");
  });

  test("TestSqliteBuilder_RenameTable", () => {
    const b = getSqliteBuilder();
    const q = b.renameTable("usersOld", "usersNew");
    expect(q.sql()).toBe("ALTER TABLE `usersOld` RENAME TO `usersNew`");
  });

  test("TestSqliteBuilder_AlterColumn", () => {
    const b = getSqliteBuilder();
    const q = b.alterColumn("users", "name", "int");
    expect(q.lastError).not.toBeNull();
  });

  test("TestSqliteBuilder_AddPrimaryKey", () => {
    const b = getSqliteBuilder();
    const q = b.addPrimaryKey("users", "pk", "id1", "id2");
    expect(q.lastError).not.toBeNull();
  });

  test("TestSqliteBuilder_DropPrimaryKey", () => {
    const b = getSqliteBuilder();
    const q = b.dropPrimaryKey("users", "pk");
    expect(q.lastError).not.toBeNull();
  });

  test("TestSqliteBuilder_AddForeignKey", () => {
    const b = getSqliteBuilder();
    const q = b.addForeignKey("users", "fk", ["p1", "p2"], ["f1", "f2"], "profile", "opt");
    expect(q.lastError).not.toBeNull();
  });

  test("TestSqliteBuilder_DropForeignKey", () => {
    const b = getSqliteBuilder();
    const q = b.dropForeignKey("users", "fk");
    expect(q.lastError).not.toBeNull();
  });

  test("TestSqliteBuilder_BuildUnion", () => {
    const b = getSqliteBuilder();
    const qb = b.queryBuilder();

    let params = {};
    let ui = { all: false, query: b.newQuery("SELECT names").bind({ id: 1 }) };
    let sql = qb.buildUnion([ui], params);
    let expected = "UNION SELECT names";
    expect(sql).toBe(expected);
    expect(Object.keys(params).length).toBe(1);

    params = {};
    ui = { all: true, query: b.newQuery("SELECT names") };
    sql = qb.buildUnion([ui], params);
    expected = "UNION ALL SELECT names";
    expect(sql).toBe(expected);
    expect(Object.keys(params).length).toBe(0);

    sql = qb.buildUnion([], {});
    expected = "";
    expect(sql).toBe(expected);

    ui = { all: true, query: b.newQuery("SELECT names") };
    const ui2 = { all: false, query: b.newQuery("SELECT ages") };
    sql = qb.buildUnion([ui, ui2], {});
    expected = "UNION ALL SELECT names UNION SELECT ages";
    expect(sql).toBe(expected);
  });

  test("TestSqliteBuilder_CombineUnion", () => {
    const b = getSqliteBuilder();
    const qb = b.queryBuilder();

    let sql = qb.combineUnion("p1", "");
    expect(sql).toBe("p1");

    sql = qb.combineUnion("p1", "p2");
    expect(sql).toBe("p1 p2");
  });
});
