// Upstream: pocketbase/dbx v1.13.0 query_builder_test.go
// Table cases compare [tag, actual] with [tag, expected] so a failure names the case.
// Query builders come from getDB() (SQLite builder); the base-behavior tests use BaseQueryBuilder directly.

import { describe, expect, test } from "bun:test";

import { BaseQueryBuilder, type JoinInfo, type UnionInfo } from "@/db/dbx/query-builder";
import type { Expression } from "@/db/dbx/expression";
import { HashExp, newExp } from "@/db/dbx/expression";
import { getDB } from "@test/db/support";

describe("query builder", () => {
  test("TestQB_BuildSelect", () => {
    const tests = [
      { tag: "empty", cols: [], distinct: false, option: "", expected: "SELECT *" },
      {
        tag: "empty distinct",
        cols: [],
        distinct: true,
        option: "CALC_ROWS",
        expected: "SELECT DISTINCT CALC_ROWS *",
      },
      {
        tag: "multi-columns",
        cols: ["name", "DOB1"],
        distinct: false,
        option: "",
        expected: "SELECT `name`, `DOB1`",
      },
      {
        tag: "aliased columns",
        cols: ["name As Name", "users.last_name", "u.first1 first"],
        distinct: false,
        option: "",
        expected: "SELECT `name` AS `Name`, `users`.`last_name`, `u`.`first1` AS `first`",
      },
    ];

    const db = getDB();
    const qb = db.queryBuilder();
    for (const tc of tests) {
      const s = qb.buildSelect(tc.cols, tc.distinct, tc.option);
      expect([tc.tag, s]).toEqual([tc.tag, tc.expected]);
    }
    expect(new BaseQueryBuilder(db).db()).toBe(db);
  });

  test("TestQB_BuildFrom", () => {
    const tests = [
      { tag: "empty", tables: [], expected: "" },
      { tag: "single table", tables: ["users"], expected: "FROM `users`" },
      {
        tag: "multiple tables",
        tables: ["users", "posts"],
        expected: "FROM `users`, `posts`",
      },
      {
        tag: "table alias",
        tables: ["users u", "posts as p"],
        expected: "FROM `users` `u`, `posts` `p`",
      },
      {
        tag: "table prefix and alias",
        tables: ["pub.users p.u", "posts AS p1"],
        expected: "FROM `pub`.`users` `p.u`, `posts` `p1`",
      },
    ];

    const qb = getDB().queryBuilder();
    for (const tc of tests) {
      const s = qb.buildFrom(tc.tables);
      expect([tc.tag, s]).toEqual([tc.tag, tc.expected]);
    }
  });

  test("TestQB_BuildGroupBy", () => {
    const tests = [
      { tag: "empty", cols: [], expected: "" },
      { tag: "single column", cols: ["name"], expected: "GROUP BY `name`" },
      {
        tag: "multiple columns",
        cols: ["name", "age"],
        expected: "GROUP BY `name`, `age`",
      },
    ];

    const qb = getDB().queryBuilder();
    for (const tc of tests) {
      const s = qb.buildGroupBy(tc.cols);
      expect([tc.tag, s]).toEqual([tc.tag, tc.expected]);
    }
  });

  test("TestQB_BuildWhere", () => {
    const tests: { exp: Expression | null; expected: string; count: number; tag: string }[] = [
      {
        exp: new HashExp({ age: 30, dept: "marketing" }),
        expected: "WHERE `age`={:p0} AND `dept`={:p1}",
        count: 2,
        tag: "t1",
      },
      { exp: null, expected: "", count: 0, tag: "t2" },
      { exp: newExp(""), expected: "", count: 0, tag: "t3" },
    ];

    const qb = getDB().queryBuilder();
    for (const tc of tests) {
      const params = {};
      const s = qb.buildWhere(tc.exp, params);
      expect([tc.tag, s]).toEqual([tc.tag, tc.expected]);
      expect([tc.tag, Object.keys(params).length]).toEqual([tc.tag, tc.count]);
    }
  });

  test("TestQB_BuildHaving", () => {
    const tests: { exp: Expression | null; expected: string; count: number; tag: string }[] = [
      {
        exp: new HashExp({ age: 30, dept: "marketing" }),
        expected: "HAVING `age`={:p0} AND `dept`={:p1}",
        count: 2,
        tag: "t1",
      },
      { exp: null, expected: "", count: 0, tag: "t2" },
      { exp: newExp(""), expected: "", count: 0, tag: "t3" },
    ];

    const qb = getDB().queryBuilder();
    for (const tc of tests) {
      const params = {};
      const s = qb.buildHaving(tc.exp, params);
      expect([tc.tag, s]).toEqual([tc.tag, tc.expected]);
      expect([tc.tag, Object.keys(params).length]).toEqual([tc.tag, tc.count]);
    }
  });

  test("TestQB_BuildOrderBy", () => {
    const tests = [
      { tag: "empty", cols: [], expected: "" },
      { tag: "single column", cols: ["name"], expected: "ORDER BY `name`" },
      {
        tag: "multiple columns",
        cols: ["name ASC", "age DESC", "id desc"],
        expected: "ORDER BY `name` ASC, `age` DESC, `id` desc",
      },
    ];
    const qb = new BaseQueryBuilder(getDB());
    for (const tc of tests) {
      const s = qb.buildOrderBy(tc.cols);
      expect([tc.tag, s]).toEqual([tc.tag, tc.expected]);
    }
  });

  test("TestQB_BuildLimit", () => {
    const tests = [
      { tag: "t1", limit: 10, offset: -1, expected: "LIMIT 10" },
      { tag: "t2", limit: 10, offset: 0, expected: "LIMIT 10" },
      { tag: "t3", limit: 10, offset: 2, expected: "LIMIT 10 OFFSET 2" },
      { tag: "t4", limit: 0, offset: 2, expected: "LIMIT 0 OFFSET 2" },
      { tag: "t5", limit: -1, offset: 2, expected: "LIMIT 9223372036854775807 OFFSET 2" },
      { tag: "t6", limit: -1, offset: 0, expected: "" },
    ];
    const qb = new BaseQueryBuilder(getDB());
    for (const tc of tests) {
      const s = qb.buildLimit(tc.limit, tc.offset);
      expect([tc.tag, s]).toEqual([tc.tag, tc.expected]);
    }
  });

  test("TestQB_BuildOrderByAndLimit", () => {
    const qb = getDB().queryBuilder();

    let sql = qb.buildOrderByAndLimit("SELECT *", ["name"], 10, 2);
    let expected = "SELECT * ORDER BY `name` LIMIT 10 OFFSET 2";
    expect(sql).toBe(expected);

    sql = qb.buildOrderByAndLimit("SELECT *", [], -1, -1);
    expected = "SELECT *";
    expect(sql).toBe(expected);

    sql = qb.buildOrderByAndLimit("SELECT *", ["name"], -1, -1);
    expected = "SELECT * ORDER BY `name`";
    expect(sql).toBe(expected);

    sql = qb.buildOrderByAndLimit("SELECT *", [], 10, -1);
    expected = "SELECT * LIMIT 10";
    expect(sql).toBe(expected);
  });

  test("TestQB_BuildJoin", () => {
    const db = getDB();
    const qb = db.queryBuilder();

    let params = {};
    let ji: JoinInfo = { join: "LEFT JOIN", table: "users u", on: newExp("id=u.id", { id: 1 }) };
    let sql = qb.buildJoin([ji], params);
    let expected = "LEFT JOIN `users` `u` ON id=u.id";
    expect(sql).toBe(expected);
    expect(Object.keys(params).length).toBe(1);

    params = {};
    ji = { join: "INNER JOIN", table: "users", on: null };
    sql = qb.buildJoin([ji], params);
    expected = "INNER JOIN `users`";
    expect(sql).toBe(expected);
    expect(Object.keys(params).length).toBe(0);

    sql = qb.buildJoin([], {});
    expected = "";
    expect(sql).toBe(expected);

    ji = { join: "INNER JOIN", table: "users", on: null };
    const ji2: JoinInfo = { join: "LEFT JOIN", table: "posts", on: null };
    sql = qb.buildJoin([ji, ji2], {});
    expected = "INNER JOIN `users` LEFT JOIN `posts`";
    expect(sql).toBe(expected);
  });

  test("TestQB_BuildUnion", () => {
    const db = getDB();
    const qb = new BaseQueryBuilder(db);

    let params = {};
    let ui: UnionInfo = { all: false, query: db.newQuery("SELECT names").bind({ id: 1 }) };
    let sql = qb.buildUnion([ui], params);
    let expected = "UNION (SELECT names)";
    expect(sql).toBe(expected);
    expect(Object.keys(params).length).toBe(1);

    params = {};
    ui = { all: true, query: db.newQuery("SELECT names") };
    sql = qb.buildUnion([ui], params);
    expected = "UNION ALL (SELECT names)";
    expect(sql).toBe(expected);
    expect(Object.keys(params).length).toBe(0);

    sql = qb.buildUnion([], {});
    expected = "";
    expect(sql).toBe(expected);

    ui = { all: true, query: db.newQuery("SELECT names") };
    const ui2: UnionInfo = { all: false, query: db.newQuery("SELECT ages") };
    sql = qb.buildUnion([ui, ui2], {});
    expected = "UNION ALL (SELECT names) UNION (SELECT ages)";
    expect(sql).toBe(expected);
  });

  test("TestQB_CombineUnion", () => {
    const db = getDB();
    const qb = new BaseQueryBuilder(db);

    let sql = qb.combineUnion("p1", "");
    expect(sql).toBe("p1");

    sql = qb.combineUnion("p1", "p2");
    expect(sql).toBe("(p1) p2");
  });
});
