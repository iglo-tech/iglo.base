// Upstream: pocketbase/dbx v1.13.0 expression_test.go
// Nil db and params from the Go calls are replaced by getDB() and fresh objects.

import { describe, expect, test } from "bun:test";

import {
  and,
  between,
  enclose,
  exists,
  HashExp,
  inExp,
  like,
  newExp,
  not,
  notBetween,
  notExists,
  notIn,
  notLike,
  or,
  orLike,
  orNotLike,
} from "@/db/dbx/expression";
import type { Params } from "@/db/dbx/query";
import { getDB } from "@test/db/support";

describe("expression", () => {
  test("TestExp", () => {
    const db = getDB();
    const params: Params = { k2: "v2" };

    const e1 = newExp("s1");
    expect(e1.build(db, params)).toBe("s1");
    expect(Object.keys(params).length).toBe(1);

    const e2 = newExp("s2", { k1: "v1" });
    expect(e2.build(db, params)).toBe("s2");
    expect(Object.keys(params).length).toBe(2);
  });

  test("TestHashExp", () => {
    const e1 = new HashExp({});
    expect(e1.build(getDB(), {})).toBe("");

    const e2 = new HashExp({
      k1: null,
      k2: newExp("s1", { ka: "va" }),
      k3: 1.1,
      k4: "abc",
      k5: [1, 2],
    });
    const db = getDB();
    const params: Params = { k0: "v0" };
    const expected =
      "`k1` IS NULL AND (s1) AND `k3`={:p2} AND `k4`={:p3} AND `k5` IN ({:p4}, {:p5})";

    expect(e2.build(db, params)).toBe(expected);
    expect(Object.keys(params).length).toBe(6);
    expect(params["p5"]).toBe(2);
  });

  test("TestNotExp", () => {
    const db = getDB();
    const e1 = not(newExp("s1"));
    expect(e1.build(db, {})).toBe("NOT (s1)");

    const e2 = not(newExp(""));
    expect(e2.build(db, {})).toBe("");
  });

  test("TestAndOrExp", () => {
    const db = getDB();
    const e1 = and(newExp("s1", { k1: "v1" }), newExp(""), newExp("s2", { k2: "v2" }));
    const params: Params = {};
    expect(e1.build(db, params)).toBe("(s1) AND (s2)");
    expect(Object.keys(params).length).toBe(2);

    const e2 = or(newExp("s1"), newExp("s2"));
    expect(e2.build(db, {})).toBe("(s1) OR (s2)");

    const e3 = and();
    expect(e3.build(db, {})).toBe("");

    const e4 = and(newExp("s1"));
    expect(e4.build(db, {})).toBe("s1");

    const e5 = and(newExp("s1"), null);
    expect(e5.build(db, {})).toBe("s1");
  });

  test("TestInExp", () => {
    const db = getDB();

    const e1 = inExp("age", 1, 2, 3);
    let params: Params = {};
    expect(e1.build(db, params)).toBe("`age` IN ({:p0}, {:p1}, {:p2})");
    expect(Object.keys(params).length).toBe(3);

    const e2 = inExp("age", 1);
    params = {};
    expect(e2.build(db, params)).toBe("`age`={:p0}");
    expect(Object.keys(params).length).toBe(1);

    const e3 = notIn("age", 1, 2, 3);
    params = {};
    expect(e3.build(db, params)).toBe("`age` NOT IN ({:p0}, {:p1}, {:p2})");
    expect(Object.keys(params).length).toBe(3);

    const e4 = notIn("age", 1);
    params = {};
    expect(e4.build(db, params)).toBe("`age`<>{:p0}");
    expect(Object.keys(params).length).toBe(1);

    const e5 = inExp("age");
    expect(e5.build(db, {})).toBe("0=1");

    const e6 = notIn("age");
    expect(e6.build(db, {})).toBe("");
  });

  test("TestLikeExp", () => {
    const db = getDB();

    const e1 = like("name", "a", "b", "c");
    let params: Params = {};
    expect(e1.build(db, params)).toBe(
      "`name` LIKE {:p0} AND `name` LIKE {:p1} AND `name` LIKE {:p2}",
    );
    expect(Object.keys(params).length).toBe(3);

    const e2 = like("name", "a");
    params = {};
    expect(e2.build(db, params)).toBe("`name` LIKE {:p0}");
    expect(Object.keys(params).length).toBe(1);

    const e3 = like("name");
    expect(e3.build(db, {})).toBe("");

    const e4 = notLike("name", "a", "b", "c");
    params = {};
    expect(e4.build(db, params)).toBe(
      "`name` NOT LIKE {:p0} AND `name` NOT LIKE {:p1} AND `name` NOT LIKE {:p2}",
    );
    expect(Object.keys(params).length).toBe(3);

    const e5 = orLike("name", "a", "b", "c");
    params = {};
    expect(e5.build(db, params)).toBe(
      "`name` LIKE {:p0} OR `name` LIKE {:p1} OR `name` LIKE {:p2}",
    );
    expect(Object.keys(params).length).toBe(3);

    const e6 = orNotLike("name", "a", "b", "c");
    params = {};
    expect(e6.build(db, params)).toBe(
      "`name` NOT LIKE {:p0} OR `name` NOT LIKE {:p1} OR `name` NOT LIKE {:p2}",
    );
    expect(Object.keys(params).length).toBe(3);

    // Go literal "a_\\%" is the four characters a _ \ %
    const e7 = like("name", "a_\\%");
    params = {};
    e7.build(db, params);
    // Go literal "%a\\_\\\\\\%%" is the characters % a \ _ \ \ \ % %
    expect(params["p0"]).toBe("%a\\_\\\\\\%%");

    const e8 = like("name", "a").match(false, true);
    params = {};
    e8.build(db, params);
    expect(params["p0"]).toBe("a%");

    const e9 = like("name", "a").match(true, false);
    params = {};
    e9.build(db, params);
    expect(params["p0"]).toBe("%a");

    const e10 = like("name", "a").match(false, false);
    params = {};
    e10.build(db, params);
    expect(params["p0"]).toBe("a");

    const e11 = like("name", "%a").match(false, false).escape();
    params = {};
    e11.build(db, params);
    expect(params["p0"]).toBe("%a");
  });

  test("TestBetweenExp", () => {
    const db = getDB();

    const e1 = between("age", 30, 40);
    let params: Params = {};
    expect(e1.build(db, params)).toBe("`age` BETWEEN {:p0} AND {:p1}");
    expect(Object.keys(params).length).toBe(2);

    const e2 = notBetween("age", 30, 40);
    params = {};
    expect(e2.build(db, params)).toBe("`age` NOT BETWEEN {:p0} AND {:p1}");
    expect(Object.keys(params).length).toBe(2);
  });

  test("TestExistsExp", () => {
    const db = getDB();

    const e1 = exists(newExp("s1"));
    expect(e1.build(db, {})).toBe("EXISTS (s1)");

    const e2 = notExists(newExp("s1"));
    expect(e2.build(db, {})).toBe("NOT EXISTS (s1)");

    const e3 = exists(newExp(""));
    expect(e3.build(db, {})).toBe("0=1");

    const e4 = notExists(newExp(""));
    expect(e4.build(db, {})).toBe("");
  });

  test("TestEncloseExp", () => {
    const db = getDB();

    const e1 = enclose(newExp(""));
    expect(e1.build(db, {})).toBe("");

    const e2 = enclose(newExp("s1"));
    expect(e2.build(db, {})).toBe("(s1)");

    const e3 = enclose(newExp("(s1)"));
    expect(e3.build(db, {})).toBe("((s1))");
  });
});
