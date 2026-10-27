// Upstream: core/db_test.go (TestGenerateDefaultRandomId, TestModelQuery)
// and the save and delete SQL paths of core/db.go, without hooks and
// validation. TestValidate and TestValidateWithContext test the
// validation hooks, which are not ported (D5); validation belongs to the
// fields and collections tasks.

import { describe, expect, test } from "bun:test";

import type { DB } from "@/db/dbx/db";
import { HashExp } from "@/db/dbx/expression";
import { NoRowsError } from "@/db/dbx/rows";
import {
  auxDeleteModel,
  auxModelQuery,
  auxSaveNoValidate,
  crc32Checksum,
  defaultIdRegex,
  deleteModel,
  generateDefaultRandomId,
  modelQuery,
  saveNoValidate,
} from "@/db/db";
import { BaseModel } from "@/db/model";
import { Demo, ExportedDemo, Log } from "@test/db/models";
import { openTempDatabases } from "@test/db/support";

class Collection extends BaseModel {
  tableName(): string {
    return "_collections";
  }
}

test("TestGenerateDefaultRandomId", () => {
  const id1 = generateDefaultRandomId();
  const id2 = generateDefaultRandomId();

  expect(id1).not.toBe(id2);
  expect(id1.length).toBe(15);
  expect(id2.length).toBe(15);
  expect(id1).toMatch(/^[a-z0-9]{15}$/);
  expect(defaultIdRegex.test(id1)).toBe(true);
});

test("crc32Checksum matches Go's crc32.ChecksumIEEE", () => {
  // upstream's tests/data names the _superusers indexes with this checksum
  expect(crc32Checksum("_superusers")).toBe("3323866339");
  expect(crc32Checksum("")).toBe("0");
});

test("TestModelQuery", () => {
  const { app } = openTempDatabases();

  const modelsQuery = modelQuery(app, new Collection());
  const logsModelQuery = auxModelQuery(app, new Collection());

  // the select query keeps the DB's builder (Go: the *dbx.DB embeds it)
  expect(modelsQuery.info().builder).toBe((app.concurrentDB() as DB).builder);
  expect(logsModelQuery.info().builder).toBe((app.auxConcurrentDB() as DB).builder);

  const expectedSQL = "SELECT {{_collections}}.* FROM `_collections`";
  for (const q of [modelsQuery, logsModelQuery]) {
    expect(q.build().sql()).toBe(expectedSQL);
  }

  app.close();
});

describe("model queries retry and report the failed query", () => {
  test("a missing table names the query", () => {
    const { app } = openTempDatabases();
    expect(() => modelQuery(app, new Collection()).all()).toThrow(
      "no such table: _collections; failed query: SELECT {{_collections}}.* FROM `_collections`",
    );
    app.close();
  });

  test("no rows stays a NoRowsError", () => {
    const { app } = openTempDatabases();
    const m = new Demo();
    expect(() => modelQuery(app, m).model("missing", m)).toThrow(NoRowsError);
    app.close();
  });
});

describe("Save and Delete", () => {
  test("create, update and delete through the model's columns", () => {
    const { app } = openTempDatabases();

    const m = new Demo();
    m.id = "demo1";
    m.title = "created";
    expect(m.isNew()).toBe(true);
    saveNoValidate(app, m);
    expect(m.isNew()).toBe(false);
    expect(m.lastSavedPK()).toBe("demo1");

    m.title = "updated";
    saveNoValidate(app, m);

    const loaded = new Demo();
    modelQuery(app, loaded).model("demo1", loaded);
    expect(loaded.title).toBe("updated");
    expect(loaded.isNew()).toBe(false);

    deleteModel(app, loaded);
    expect(app.concurrentDB().newQuery("SELECT COUNT(*) FROM demo").row()).toEqual([0]);

    app.close();
  });

  test("create, update and delete through DBExporter", () => {
    const { app } = openTempDatabases();

    const m = new ExportedDemo();
    m.id = "exp1";
    m.title = "created";
    // the id is added to the exported data when missing
    saveNoValidate(app, m);
    expect(m.isNew()).toBe(false);

    m.exported = { id: "exp1", title: "updated" };
    saveNoValidate(app, m);
    expect(
      app
        .concurrentDB()
        .select("title")
        .from("demo")
        .where(new HashExp({ id: "exp1" }))
        .row(),
    ).toEqual(["updated"]);

    // note: for now disallow primary key change for consistency with dbx.ModelQuery.Update()
    m.exported = { id: "changed", title: "x" };
    expect(() => saveNoValidate(app, m)).toThrow("primary key change is not allowed");

    deleteModel(app, m);
    expect(app.concurrentDB().newQuery("SELECT COUNT(*) FROM demo").row()).toEqual([0]);

    app.close();
  });

  test("DBExporter with an empty primary key", () => {
    const { app } = openTempDatabases();
    const m = new ExportedDemo();
    expect(() => saveNoValidate(app, m)).toThrow(
      "empty primary key is not allowed when using the DBExporter interface",
    );
    expect(m.isNew()).toBe(true);
    app.close();
  });

  test("a failed create resets the new state", () => {
    const { app } = openTempDatabases();
    const first = new Demo();
    first.id = "dup";
    saveNoValidate(app, first);

    const second = new Demo();
    second.id = "dup";
    second.markAsNotNew();
    second.markAsNew();
    expect(() => saveNoValidate(app, second)).toThrow("UNIQUE constraint failed: demo.id");
    expect(second.isNew()).toBe(true);
    app.close();
  });

  test("deleting a model that was never saved", () => {
    const { app } = openTempDatabases();
    const m = new Demo();
    m.id = "unsaved";
    expect(() => deleteModel(app, m)).toThrow(
      "the model can be deleted only if it is existing and has a non-empty primary key",
    );
    app.close();
  });

  test("the auxiliary database", () => {
    const { app } = openTempDatabases();

    const log = new Log();
    log.id = "log1";
    log.message = "hello";
    auxSaveNoValidate(app, log);

    const loaded = new Log();
    auxModelQuery(app, loaded).model("log1", loaded);
    expect(loaded.message).toBe("hello");

    auxDeleteModel(app, loaded);
    expect(app.auxConcurrentDB().newQuery("SELECT COUNT(*) FROM logs").row()).toEqual([0]);
    // data.db has no logs table
    expect(() => app.concurrentDB().newQuery("SELECT COUNT(*) FROM logs").row()).toThrow(
      "no such table: logs",
    );

    app.close();
  });
});
