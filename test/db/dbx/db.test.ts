// Upstream: pocketbase/dbx v1.13.0 db_test.go
//
// dbx's tests run on MySQL; these run the same cases on SQLite, whose
// builder quotes and binds like the MySQL one (backticks, "?"). Go's
// Wrap/BeginTx variants and the PostgreSQL/OCI placeholder columns have no
// counterpart (one connection, no other drivers). Thrown errors replace
// returned ones.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { DB, Errors, newFromDB } from "@/db/dbx/db";
import { TxDoneError } from "@/db/dbx/tx";
import { getDB, getPreparedDB } from "@test/db/support";

test("TestDB_NewFromDB", () => {
  const conn = new Database(":memory:");
  const db = newFromDB(conn, "sqlite");
  expect(db.conn()).toBe(conn);
  expect(db.driverName()).toBe("sqlite");

  const db2 = db.clone();
  expect(db2).not.toBe(db);
  expect(db2.driverName()).toBe(db.driverName());
  expect(db2.conn()).toBe(conn);
});

test("TestDB_Close", () => {
  const db = getDB();
  db.close();
  expect(() => db.newQuery("SELECT 1").row()).toThrow();
});

test("TestDB_DriverName", () => {
  expect(getDB().driverName()).toBe("sqlite");
});

test("TestDB_QuoteTableName", () => {
  const tests = [
    { input: "users", output: "`users`" },
    { input: "`users`", output: "`users`" },
    { input: "(select)", output: "(select)" },
    { input: "{{users}}", output: "{{users}}" },
    { input: "public.db1.users", output: "`public`.`db1`.`users`" },
  ];
  const db = getDB();
  for (const t of tests) {
    expect(db.quoteTableName(t.input), t.input).toBe(t.output);
  }
});

test("TestDB_QuoteColumnName", () => {
  const tests = [
    { input: "*", output: "*" },
    { input: "users.*", output: "`users`.*" },
    { input: "name", output: "`name`" },
    { input: "`name`", output: "`name`" },
    { input: "(select)", output: "(select)" },
    { input: "{{name}}", output: "{{name}}" },
    { input: "[[name]]", output: "[[name]]" },
    { input: "public.db1.users", output: "`public`.`db1`.`users`" },
  ];
  const db = getDB();
  for (const t of tests) {
    expect(db.quoteColumnName(t.input), t.input).toBe(t.output);
  }
});

test("TestDB_ProcessSQL", () => {
  const tests: { tag: string; sql: string; sqlite: string; params: string[] }[] = [
    {
      tag: "normal case",
      sql: "INSERT INTO employee (id, name, age) VALUES ({:id}, {:name}, {:age})",
      sqlite: "INSERT INTO employee (id, name, age) VALUES (?, ?, ?)",
      params: ["id", "name", "age"],
    },
    {
      tag: "the same placeholder is used twice",
      sql: "SELECT * FROM employee WHERE first_name LIKE {:keyword} OR last_name LIKE {:keyword}",
      sqlite: "SELECT * FROM employee WHERE first_name LIKE ? OR last_name LIKE ?",
      params: ["keyword", "keyword"],
    },
    {
      tag: "non-matching placeholder",
      sql: 'SELECT * FROM employee WHERE first_name LIKE "{:key?word}" OR last_name LIKE {:keyword}',
      sqlite: 'SELECT * FROM employee WHERE first_name LIKE "{:key?word}" OR last_name LIKE ?',
      params: ["keyword"],
    },
    {
      tag: "quote table/column names",
      sql: "SELECT * FROM {{public.user}} WHERE [[user.id]]=1",
      sqlite: "SELECT * FROM `public`.`user` WHERE `user`.`id`=1",
      params: [],
    },
  ];

  const db = getDB();
  for (const t of tests) {
    const [s, names] = db.processSQL(t.sql);
    expect(s, t.tag).toBe(t.sqlite);
    expect(names, t.tag).toEqual(t.params);
  }
});

test("TestDB_Begin", () => {
  const db = getPreparedDB();

  const [lastID] = db.newQuery("SELECT MAX(id) FROM item").row() as [number];

  let tx = db.begin();
  tx.insert("item", { name: "name1" }).execute();
  tx.insert("item", { name: "name2" }).execute();
  tx.commit();

  const q = db.newQuery("SELECT name FROM item WHERE id={:id}");
  expect(q.bind({ id: lastID + 1 }).row()).toEqual(["name1"]);
  expect(q.bind({ id: lastID + 2 }).row()).toEqual(["name2"]);

  tx = db.begin();
  tx.newQuery("DELETE FROM item WHERE id=7").execute();
  expect(() => tx.newQuery("DELETE FROM items WHERE id=7").execute()).toThrow();
  tx.rollback();

  expect(db.newQuery("SELECT name FROM item WHERE id=7").row()).toEqual(["name2"]);
});

describe("TestDB_Transactional", () => {
  test("commit", () => {
    const db = getPreparedDB();
    const [lastID] = db.newQuery("SELECT MAX(id) FROM item").row() as [number];

    db.transactional((tx) => {
      tx.insert("item", { name: "name1" }).execute();
      tx.insert("item", { name: "name2" }).execute();
    });

    const q = db.newQuery("SELECT name FROM item WHERE id={:id}");
    expect(q.bind({ id: lastID + 1 }).row()).toEqual(["name1"]);
    expect(q.bind({ id: lastID + 2 }).row()).toEqual(["name2"]);
  });

  test("an error rolls back", () => {
    const db = getPreparedDB();
    expect(() =>
      db.transactional((tx) => {
        tx.newQuery("DELETE FROM item WHERE id=2").execute();
        tx.newQuery("DELETE FROM items WHERE id=2").execute();
      }),
    ).toThrow("no such table: items");
    expect(db.newQuery("SELECT name FROM item WHERE id=2").row()).toEqual(["Go in Action"]);
  });

  test("Rollback called within Transactional and return error", () => {
    const db = getPreparedDB();
    expect(() =>
      db.transactional((tx) => {
        tx.newQuery("DELETE FROM item WHERE id=2").execute();
        try {
          tx.newQuery("DELETE FROM items WHERE id=2").execute();
        } catch (err) {
          tx.rollback();
          throw err;
        }
      }),
    ).toThrow("no such table: items");
    expect(db.newQuery("SELECT name FROM item WHERE id=2").row()).toEqual(["Go in Action"]);
  });

  test("Rollback called within Transactional without returning error", () => {
    const db = getPreparedDB();
    db.transactional((tx) => {
      tx.newQuery("DELETE FROM item WHERE id=2").execute();
      try {
        tx.newQuery("DELETE FROM items WHERE id=2").execute();
      } catch {
        tx.rollback();
      }
    });
    expect(db.newQuery("SELECT name FROM item WHERE id=2").row()).toEqual(["Go in Action"]);
  });

  test("a finished transaction can't be used (sql.ErrTxDone)", () => {
    const db = getPreparedDB();
    const tx = db.begin();
    tx.commit();
    expect(() => tx.newQuery("SELECT 1").row()).toThrow(TxDoneError);
    expect(() => tx.commit()).toThrow(TxDoneError);
    expect(() => tx.rollback()).toThrow(TxDoneError);
  });

  test("a commit failure is reported and leaves no open transaction", () => {
    const db = deferredFKDB();
    expect(() =>
      db.transactional((tx) => {
        tx.insert("child", { parent_id: 404 }).execute();
      }),
    ).toThrow("FOREIGN KEY constraint failed");
    expect(db.conn().inTransaction).toBe(false);
    expect(db.newQuery("SELECT COUNT(*) FROM child").row()).toEqual([0]);
  });

  test("a function returning a promise is rolled back", () => {
    const db = getPreparedDB();
    expect(() =>
      db.transactional(((tx: Parameters<Parameters<DB["transactional"]>[0]>[0]) => {
        tx.newQuery("DELETE FROM item WHERE id=2").execute();
        return Promise.resolve();
      }) as never),
    ).toThrow("transaction function must be synchronous");
    expect(db.newQuery("SELECT name FROM item WHERE id=2").row()).toEqual(["Go in Action"]);
  });
});

test("TestErrors_Error", () => {
  expect(new Errors([]).message).toBe("");
  expect(new Errors([new Error("a")]).message).toBe("a");
  expect(new Errors([new Error("a"), new Error("b")]).message).toBe("a\nb");
});

// a database whose COMMIT fails: a deferred foreign key checked at commit
function deferredFKDB(): DB {
  const db = getDB();
  db.conn().run(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE parent (id INTEGER PRIMARY KEY);
    CREATE TABLE child (
      id INTEGER PRIMARY KEY,
      parent_id INTEGER REFERENCES parent (id) DEFERRABLE INITIALLY DEFERRED
    );
  `);
  return db;
}
