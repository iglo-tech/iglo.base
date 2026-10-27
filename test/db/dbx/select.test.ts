// Upstream: pocketbase/dbx v1.13.0 select_test.go
//
// The SQL text is the SQLite builder's: the same backtick quoting as the
// MySQL builder dbx's tests use, and UNION parts without parentheses
// (builder_sqlite.go). The parenthesised MySQL union text is checked
// against BaseQueryBuilder in query-builder.test.ts. Scanning into Go
// variables becomes the returned rows and models; the Go cases that only
// test invalid scan targets (an int instead of a struct) have no
// TypeScript counterpart.

import { describe, expect, test } from "bun:test";

import { HashExp, newExp } from "@/db/dbx/expression";
import { NoRowsError } from "@/db/dbx/rows";
import { CompositePKError, MissingPKError } from "@/db/dbx/select";
import type { Params, Row } from "@/db/dbx/query";
import { Customer, CustomerPtr } from "@test/db/dbx/models";
import { getDB, getPreparedDB } from "@test/db/support";

test("TestSelectQuery", () => {
  const db = getDB();

  // minimal select query
  let q = db.select().from("users").build();
  expect(q.sql()).toBe("SELECT * FROM `users`");
  expect(Object.keys(q.params()).length).toBe(0);

  // a full select query
  q = db
    .select("id", "name")
    .preFragment("pre")
    .postFragment("post")
    .andSelect("age")
    .distinct(true)
    .selectOption("CALC")
    .from("users")
    .where(newExp("age>30"))
    .andWhere(newExp("status=1"))
    .orWhere(newExp("type=2"))
    .innerJoin("profile", newExp("user.id=profile.id"))
    .leftJoin("team", null)
    .rightJoin("dept", null)
    .orderBy("age DESC", "type")
    .andOrderBy("id")
    .groupBy("id")
    .andGroupBy("age")
    .having(newExp("id>10"))
    .andHaving(newExp("id<20"))
    .orHaving(newExp("type=3"))
    .limit(10)
    .offset(20)
    .bind({ id: 1 })
    .andBind({ age: 30 })
    .build();

  expect(q.sql()).toBe(
    "pre SELECT DISTINCT CALC `id`, `name`, `age` FROM `users` INNER JOIN `profile` ON user.id=profile.id LEFT JOIN `team` RIGHT JOIN `dept` WHERE ((age>30) AND (status=1)) OR (type=2) GROUP BY `id`, `age` HAVING ((id>10) AND (id<20)) OR (type=3) ORDER BY `age` DESC, `type`, `id` LIMIT 10 OFFSET 20 post",
  );
  expect(Object.keys(q.params()).length).toBe(2);

  const q3 = db.select().andBind({ id: 1 }).build();
  expect(Object.keys(q3.params()).length).toBe(1);

  // union (SQLite: no parentheses around the parts)
  const q1 = db.select().from("users").preFragment("pre_q1").build();
  const q2 = db.select().from("posts").postFragment("post_q2").build();
  q = db
    .select()
    .from("profiles")
    .union(q1)
    .unionAll(q2)
    .preFragment("pre")
    .postFragment("post")
    .build();
  expect(q.sql()).toBe(
    "pre SELECT * FROM `profiles` post UNION pre_q1 SELECT * FROM `users` UNION ALL SELECT * FROM `posts` post_q2",
  );
});

test("TestSelectQuery_Data", () => {
  const db = getPreparedDB();

  const q = db.select("id", "email").from("customer").orderBy("id");

  const customer = q.one(new Customer());
  expect(customer.email).toBe("user1@example.com");

  const customers = q.all<Customer>(() => new Customer());
  expect(customers.length).toBe(3);

  const rows = q.rows();
  expect(rows.columns()).toEqual(["id", "email"]);
  expect([...rows][0]).toEqual([1, "user1@example.com"]);

  const [id, email] = q.row();
  expect(String(id)).toBe("1");
  expect(email).toBe("user1@example.com");

  const emails = db.select("email").from("customer").column<string>();
  expect(emails.length).toBe(3);

  // row objects without a model
  const row = db.select().from("customer").orderBy("id").one();
  expect(row).toEqual({
    id: 1,
    email: "user1@example.com",
    name: "user1",
    address: "address1",
    status: 1,
  });
  expect(db.select().from("customer").all<Row>().length).toBe(3);

  db.close();
});

test("TestSelectQuery_Model", () => {
  const db = getPreparedDB();

  {
    // One without specifying FROM
    const customer = db.select().orderBy("id").one(new CustomerPtr());
    expect(customer.email).toBe("user1@example.com");
  }

  {
    // All without specifying FROM
    const customers = db
      .select()
      .orderBy("id")
      .all(() => new CustomerPtr());
    expect(customers.length).toBe(3);
  }

  {
    // Model without specifying FROM
    const customer = new CustomerPtr();
    db.select().model(2, customer);
    expect(customer.email).toBe("user2@example.com");
  }

  {
    // Model with WHERE
    const customer = new CustomerPtr();
    expect(() =>
      db
        .select()
        .where(new HashExp({ id: 1 }))
        .model(2, customer),
    ).toThrow(NoRowsError);

    db.select()
      .where(new HashExp({ id: 2 }))
      .model(2, customer);
    expect(customer.id).toBe(2);
  }

  {
    // errors
    const noPK = {
      name: "",
      tableName: () => "customer",
      dbColumns: (): Params => ({ name: "" }),
      dbScan: () => {},
    };
    expect(() => db.select().model(1, noPK)).toThrow(MissingPKError);

    const compositePK = {
      tableName: () => "customer",
      dbPrimaryKey: () => ["id1", "id2"],
      dbColumns: (): Params => ({ id1: "", id2: "" }),
      dbScan: () => {},
    };
    expect(() => db.select().model(1, compositePK)).toThrow(CompositePKError);
  }

  db.close();
});

test("TestSelectWithBuildHook", () => {
  const db = getPreparedDB();

  let buildSQL = "";

  db.select("id")
    .from("user")
    .withBuildHook((q) => {
      buildSQL = q.sql();
    })
    .build();

  expect(buildSQL).toBe("SELECT `id` FROM `user`");

  db.close();
});

describe("clone (Go's SelectQuery struct copy)", () => {
  test("changing the copy leaves the original unchanged", () => {
    const db = getDB();
    const q = db.select("id").from("users").where(newExp("a=1")).orderBy("id").limit(5);
    const copy = q.clone().distinct(true).select("COUNT(*)").orderBy().andWhere(newExp("b=2"));

    expect(copy.build().sql()).toBe(
      "SELECT DISTINCT COUNT(*) FROM `users` WHERE (a=1) AND (b=2) LIMIT 5",
    );
    expect(q.build().sql()).toBe("SELECT `id` FROM `users` WHERE a=1 ORDER BY `id` LIMIT 5");
  });

  test("AndWhere on an empty expression gives upstream's empty parentheses", () => {
    // AndOrExp joins no parts into "()" (expression.go)
    const db = getDB();
    expect(db.select().from("users").andWhere(newExp("")).build().sql()).toBe(
      "SELECT * FROM `users` WHERE ()",
    );
  });
});
