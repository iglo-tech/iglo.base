// SQL identifiers are arbitrary names: "__proto__" is a valid table, index,
// column and parameter name, and the maps keyed by them (Go maps upstream)
// keep it as an ordinary key.

import { expect, test } from "bun:test";

import { newExp } from "@/db/dbx/expression";
import type { Params, Row } from "@/db/dbx/query";
import type { StructModel } from "@/db/dbx/struct";
import { tableIndexes } from "@/db/table";
import { getDB, openTempDatabases } from "@test/db/support";

const name = "__proto__";

function own(key: string, value: unknown): Record<string, unknown> {
  return { [key]: value };
}

test("tableIndexes keeps an index named __proto__", () => {
  const { app } = openTempDatabases();
  try {
    app.nonconcurrentDB().newQuery('CREATE INDEX "__proto__" ON demo (title)').execute();
    const indexes = tableIndexes(app, "demo");
    expect(Object.keys(indexes)).toEqual([name]);
    expect(indexes[name]).toBe('CREATE INDEX "__proto__" ON demo (title)');
  } finally {
    app.close();
  }
});

test("a model column named __proto__ is inserted", () => {
  class Odd implements StructModel {
    tableName(): string {
      return "odd";
    }

    dbColumns(): Params {
      return { id: "a", ...own(name, "stored") };
    }

    dbScan(_row: Row): void {}
  }

  const db = getDB();
  db.newQuery('CREATE TABLE odd (id TEXT PRIMARY KEY, "__proto__" TEXT)').execute();
  db.model(new Odd()).insert("id", name);
  expect(db.newQuery('SELECT "__proto__" FROM odd').row()).toEqual(["stored"]);
});

test("a result column named __proto__ is read", () => {
  const db = getDB();
  const expected = own(name, 1);
  expect(db.newQuery('SELECT 1 AS "__proto__"').one()).toEqual(expected);
  expect(db.newQuery('SELECT 1 AS "__proto__"').all()).toEqual([expected]);
  expect(db.newQuery('SELECT 0 AS "__proto__", 1 AS "__proto__"').one()).toEqual(expected);
});

test("a parameter named __proto__ is bound", () => {
  const db = getDB();
  expect(
    db
      .select("(1)")
      .where(newExp("1 = {:__proto__}", own(name, 1)))
      .row(),
  ).toEqual([1]);
  expect(db.newQuery("SELECT {:__proto__}").bind(own(name, 2)).bind({ x: 0 }).row()).toEqual([2]);
});
