// Translated from pocketbase/dbx v1.13.0, whose license follows:
//
// The MIT License (MIT)
//
// Copyright (c) 2016, Qiang Xue
// Copyright (c) 2022-present Gani Georgiev
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software
// and associated documentation files (the "Software"), to deal in the Software without restriction,
// including without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom the Software
// is furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or
// substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
// BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

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
