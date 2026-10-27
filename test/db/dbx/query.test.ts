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

// Upstream: pocketbase/dbx v1.13.0 query_test.go
//
// Scanning into Go variables becomes the returned rows, values and models
// (src/db/dbx/query.ts). The Go cases about struct reflection (embedded
// structs, unexported fields, sql.Null* and pointer field types, invalid
// scan targets) have no TypeScript counterpart. Go's time.Time columns are
// text in SQLite and stay text here.

import { describe, expect, test } from "bun:test";

import type { SqliteBuilder } from "@/db/dbx/builder-sqlite";
import { HashExp } from "@/db/dbx/expression";
import { Query, replacePlaceholders, type Row } from "@/db/dbx/query";
import { NoRowsError } from "@/db/dbx/rows";
import { Customer, User } from "@test/db/dbx/models";
import { getDB, getPreparedDB } from "@test/db/support";

test("TestNewQuery", () => {
  const db = getDB();
  const sql = "SELECT * FROM users WHERE id={:id}";
  const q = new Query(db, (db.builder as SqliteBuilder).executor(), sql);
  expect(q.sql()).toBe(sql);
  expect(q.rawSQL()).toBe("SELECT * FROM users WHERE id=?");

  expect(Object.keys(q.params()).length).toBe(0);
  q.bind({ id: 1 });
  expect(Object.keys(q.params()).length).toBe(1);
});

test("TestQuery_Execute", () => {
  const db = getPreparedDB();

  const result = db.newQuery("INSERT INTO item (name) VALUES ('test')").execute();
  expect(result.rowsAffected).toBe(1);
  expect(result.lastInsertId).toBe(6);

  db.close();
});

test("TestQuery_Rows", () => {
  const db = getPreparedDB();

  // Query.All()
  let sql = "SELECT * FROM customer ORDER BY id";
  const customers = db.newQuery(sql).all<Customer>(() => new Customer());
  expect(customers.length).toBe(3);
  expect(customers[2]!.id).toBe(3);
  expect(customers[2]!.email).toBe("user3@example.com");
  expect(customers[2]!.status).toBe(2);
  expect(customers.map((c) => c.scanned)).toEqual([true, true, true]);

  // Query.All() into rows (Go: []NullStringMap)
  const customers2 = db.newQuery(sql).all<Row>();
  expect(customers2.length).toBe(3);
  expect(customers2[1]!.id).toBe(2);
  expect(customers2[1]!.email).toBe("user2@example.com");
  expect(customers2[1]!.status).toBe(1);

  const customers5 = db
    .newQuery("SELECT * FROM customer WHERE id=999")
    .all<Customer>(() => new Customer());
  expect(customers5).toEqual([]);

  // One
  sql = "SELECT * FROM customer WHERE id={:id}";
  const customer = db.newQuery(sql).bind({ id: 2 }).one(new Customer());
  expect(customer.id).toBe(2);
  expect(customer.email).toBe("user2@example.com");
  expect(customer.status).toBe(1);
  expect(customer.address).toBeNull();

  const customer2 = db.newQuery(sql).bind({ id: 1 }).one();
  expect(customer2.id).toBe(1);
  expect(customer2.email).toBe("user1@example.com");
  expect(customer2.status).toBe(1);

  // Rows
  sql = "SELECT * FROM customer ORDER BY id DESC";
  const rows = db.newQuery(sql).rows();
  let s = "";
  const emailIndex = rows.columns().indexOf("email");
  for (const values of rows) {
    s += String(values[emailIndex]) + ",";
  }
  expect(s).toBe("user3@example.com,user2@example.com,user1@example.com,");

  // prepared statement
  sql = "SELECT * FROM customer WHERE id={:id}";
  let q = db.newQuery(sql).prepare();
  expect(q.bind({ id: 1 }).one(new Customer()).id).toBe(1);
  expect(() => q.bind({ id: 20 }).one(new Customer())).toThrow(NoRowsError);
  expect(q.bind({ id: 3 }).one(new Customer()).id).toBe(3);
  q.close();

  sql = "SELECT name FROM customer WHERE id={:id}";
  q = db.newQuery(sql).prepare();
  expect(q.bind({ id: 1 }).row()).toEqual(["user1"]);
  expect(() => q.bind({ id: 20 }).row()).toThrow(NoRowsError);
  expect(q.bind({ id: 3 }).row()).toEqual(["user3"]);
  q.close();

  // Query.LastError
  sql = "SELECT * FROM a";
  q = db.newQuery(sql).prepare();
  const target = new Customer();
  target.id = 100;
  expect(q.lastError).not.toBeNull();
  expect(() => q.bind({ id: 1 }).one(target)).toThrow();
  expect(target.id).toBe(100);
  expect(q.lastError).toBeNull();

  // Query.Column
  sql = "SELECT name, id FROM customer ORDER BY id";
  expect(db.newQuery(sql).column<string>()).toEqual(["user1", "user2", "user3"]);

  db.close();
});

test("TestQuery_logSQL", () => {
  const db = getDB();
  const q = db
    .newQuery("SELECT * FROM users WHERE type={:type} AND id={:id} AND bytes={:bytes}")
    .bind({
      id: 1,
      type: "a",
      bytes: new TextEncoder().encode("test"),
    });
  expect(q.logSQL()).toBe("SELECT * FROM users WHERE type='a' AND id=1 AND bytes=0x74657374");
});

test("TestReplacePlaceholders", () => {
  const tests: {
    id: string;
    placeholders: string[];
    params: Record<string, unknown>;
    expectedParams: (number | string)[] | null;
    hasError: boolean;
  }[] = [
    { id: "t1", placeholders: [], params: {}, expectedParams: [], hasError: false },
    {
      id: "t2",
      placeholders: ["id", "name"],
      params: { id: 1, name: "xyz" },
      expectedParams: [1, "xyz"],
      hasError: false,
    },
    {
      id: "t3",
      placeholders: ["id", "name"],
      params: { id: 1 },
      expectedParams: null,
      hasError: true,
    },
    {
      id: "t4",
      placeholders: ["id", "name"],
      params: { id: 1, name: "xyz", age: 30 },
      expectedParams: [1, "xyz"],
      hasError: false,
    },
  ];
  for (const t of tests) {
    if (t.hasError) {
      expect(() => replacePlaceholders(t.placeholders, t.params)).toThrow(
        "Named parameter not found: name",
      );
    } else {
      expect(replacePlaceholders(t.placeholders, t.params)).toEqual(t.expectedParams!);
    }
  }
});

test("TestIssue6", () => {
  const db = getPreparedDB();
  const q = db
    .select("*")
    .from("customer")
    .where(new HashExp({ id: 1 }));
  expect(q.one(new Customer()).id).toBe(1);
});

test("TestIssue13", () => {
  const db = getPreparedDB();
  const user = db
    .select()
    .from("user")
    .where(new HashExp({ id: 1 }))
    .one(new User());
  expect(user.created).not.toBe("");
  expect(user.updated).toBeNull();

  const now = new Date().toISOString();

  const user2 = new User();
  user2.email = "now@example.com";
  user2.created = now;
  db.model(user2).insert();
  expect(user2.id).not.toBe(0);

  const user3 = new User();
  user3.email = "now@example.com";
  user3.created = now;
  user3.updated = now;
  db.model(user3).insert();
  expect(user3.id).not.toBe(0);
});

describe("TestQueryWithExecHook", () => {
  const db = getPreparedDB();

  test("error return", () => {
    expect(() =>
      db
        .newQuery("select * from user")
        .withExecHook(() => {
          throw new Error("test");
        })
        .row(),
    ).toThrow("test");
  });

  test("Row(), One(), All(), Column(), Execute()", () => {
    const resolvers: [string, (q: Query) => unknown][] = [
      ["Row()", (q) => q.row()],
      ["One()", (q) => q.one()],
      ["All()", (q) => q.all()],
      ["Column()", (q) => q.column()],
      ["Execute()", (q) => q.execute()],
    ];
    for (const [name, resolve] of resolvers) {
      let calls = 0;
      resolve(
        db.newQuery("select * from user").withExecHook(() => {
          calls++;
        }),
      );
      expect(calls, name).toBe(1);
    }
  });

  test("op call", () => {
    let calls = 0;
    const [id] = db
      .newQuery("select id from user where id = 2")
      .withExecHook((_q, op) => {
        calls++;
        op();
      })
      .row();
    expect(calls).toBe(1);
    expect(id).toBe(2);
  });
});

describe("TestQueryWithOneHook", () => {
  const db = getPreparedDB();

  test("error return", () => {
    expect(() =>
      db
        .newQuery("select * from user")
        .withOneHook(() => {
          throw new Error("test");
        })
        .one(),
    ).toThrow("test");
  });

  test("hooks call order", () => {
    const hookCalls: string[] = [];
    db.newQuery("select * from user")
      .withExecHook((_q, op) => {
        hookCalls.push("exec");
        op();
      })
      .withOneHook(() => {
        hookCalls.push("one");
        return null;
      })
      .one();
    expect(hookCalls).toEqual(["exec", "one"]);
  });

  test("op call", () => {
    let calls = 0;
    const other = new User();
    const result = db
      .newQuery("select id from user where id = 2")
      .withOneHook((_q, _a, op) => {
        calls++;
        return op(other);
      })
      .one<User>();
    expect(calls).toBe(1);
    expect(other.id).toBe(2);
    expect(result).toBe(other);
  });
});

describe("TestQueryWithAllHook", () => {
  const db = getPreparedDB();

  test("error return", () => {
    expect(() =>
      db
        .newQuery("select * from user")
        .withAllHook(() => {
          throw new Error("test");
        })
        .all(),
    ).toThrow("test");
  });

  test("hooks call order", () => {
    const hookCalls: string[] = [];
    db.newQuery("select * from user")
      .withExecHook((_q, op) => {
        hookCalls.push("exec");
        op();
      })
      .withAllHook(() => {
        hookCalls.push("all");
        return null;
      })
      .all();
    expect(hookCalls).toEqual(["exec", "all"]);
  });

  test("op call", () => {
    let calls = 0;
    const other = db
      .newQuery("select id from user order by id asc")
      .withAllHook((_q, _a, op) => {
        calls++;
        return op(() => new User());
      })
      .all<User>();
    expect(calls).toBe(1);
    expect(other.length).toBe(2);
    expect(other[0]!.id).toBe(1);
    expect(other[1]!.id).toBe(2);
  });
});

// Go's Rows step one row at a time: Row() scans the first row and closes,
// so a later row that fails to evaluate is never reached.
describe("rows are read incrementally", () => {
  const sql = "SELECT 1 AS n UNION ALL SELECT json_extract('x', '$')";

  test("row()", () => {
    expect(getDB().newQuery(sql).row()).toEqual([1]);
  });

  test("one()", () => {
    expect(getDB().newQuery(sql).one()).toEqual({ n: 1 });
  });

  test("an iteration that stops early", () => {
    const db = getDB();
    const seen: unknown[][] = [];
    for (const values of db.newQuery(sql).rows()) {
      seen.push(values);
      break;
    }
    expect(seen).toEqual([[1]]);
    // the cached statement is usable again
    expect(db.newQuery(sql).row()).toEqual([1]);
  });

  test("a later row that fails still fails all() and column()", () => {
    const db = getDB();
    expect(() => db.newQuery(sql).all()).toThrow("malformed JSON");
    expect(() => db.newQuery(sql).column()).toThrow("malformed JSON");
  });

  test("duplicate column names stay distinct", () => {
    const db = getDB();
    expect(db.newQuery("SELECT 1 AS a, 2 AS a").row()).toEqual([1, 2]);
    expect([...db.newQuery("SELECT 1 AS a, 2 AS a UNION ALL SELECT 3, 4").rows()]).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });
});

// Go reads INTEGER columns as int64; safe integers come back as numbers
// and the others as exact bigints.
describe("integers are read losslessly", () => {
  const big = 9007199254740993n;
  const sql =
    "SELECT 9007199254740993 AS big, -9223372036854775808 AS min, 42 AS small, 1.5 AS real";
  const expected = { big, min: -9223372036854775808n, small: 42, real: 1.5 };

  test("every reader", () => {
    const db = getDB();
    expect(db.newQuery(sql).one()).toEqual(expected);
    expect(db.newQuery(sql).all()).toEqual([expected]);
    expect(db.newQuery(sql).row()).toEqual(Object.values(expected));
    expect([...db.newQuery(sql).rows()]).toEqual([Object.values(expected)]);
    expect(db.newQuery(sql).column()).toEqual([big]);
    expect(db.newQuery(sql).prepare().row()).toEqual(Object.values(expected));
    expect(db.newQuery("SELECT 9007199254740991 AS n").row()).toEqual([9007199254740991]);
  });

  test("a bigint is written back exactly", () => {
    const db = getDB();
    db.newQuery("CREATE TABLE t (v)").execute();
    db.insert("t", { v: big }).execute();
    const [v] = db.newQuery("SELECT v FROM t").row();
    expect(v).toBe(big);
    expect(db.newQuery("SELECT CAST(v AS TEXT) FROM t").row()).toEqual(["9007199254740993"]);
  });
});
