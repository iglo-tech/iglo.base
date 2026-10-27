// Upstream: pocketbase/dbx v1.13.0 builder_standard_test.go
// getStandardBuilder() builds the StandardBuilder on a getDB() connection, as the Go helper does.

import { describe, expect, test } from "bun:test";

import type { Builder } from "@/db/dbx/builder";
import { SqliteBuilder } from "@/db/dbx/builder-sqlite";
import { StandardBuilder } from "@/db/dbx/builder-standard";
import { newExp } from "@/db/dbx/expression";
import { getDB } from "@test/db/support";

function getStandardBuilder(): Builder {
  const db = getDB();
  const executor = (db.builder as SqliteBuilder).executor();
  const b = new StandardBuilder(db, executor);
  db.builder = b;
  return b;
}

describe("standard builder", () => {
  test("TestStandardBuilder_Quote", () => {
    const b = getStandardBuilder();
    expect(b.quote("abc")).toBe("'abc'");
    expect(b.quote("I'm")).toBe("'I''m'");
    expect(b.quote("")).toBe("''");
  });

  test("TestStandardBuilder_QuoteSimpleTableName", () => {
    const b = getStandardBuilder();
    expect(b.quoteSimpleTableName("abc")).toBe('"abc"');
    expect(b.quoteSimpleTableName('"abc"')).toBe('"abc"');
    expect(b.quoteSimpleTableName("{{abc}}")).toBe('"{{abc}}"');
    expect(b.quoteSimpleTableName("a.bc")).toBe('"a.bc"');
  });

  test("TestStandardBuilder_QuoteSimpleColumnName", () => {
    const b = getStandardBuilder();
    expect(b.quoteSimpleColumnName("abc")).toBe('"abc"');
    expect(b.quoteSimpleColumnName('"abc"')).toBe('"abc"');
    expect(b.quoteSimpleColumnName("{{abc}}")).toBe('"{{abc}}"');
    expect(b.quoteSimpleColumnName("a.bc")).toBe('"a.bc"');
    expect(b.quoteSimpleColumnName("*")).toBe("*");
  });

  test("TestStandardBuilder_Insert", () => {
    const b = getStandardBuilder();
    let q = b.insert("users", { name: "James", age: 30 });
    expect(q.sql()).toBe('INSERT INTO "users" ("age", "name") VALUES ({:p0}, {:p1})');
    expect(q.params()["p0"]).toBe(30);
    expect(q.params()["p1"]).toBe("James");

    q = b.insert("users", {});
    expect(q.sql()).toBe('INSERT INTO "users" DEFAULT VALUES');
  });

  test("TestStandardBuilder_Upsert", () => {
    const b = getStandardBuilder();
    const q = b.upsert("users", { name: "James", age: 30 });
    expect(q.lastError).not.toBeNull();
  });

  test("TestStandardBuilder_Update", () => {
    const b = getStandardBuilder();
    let q = b.update("users", { name: "James", age: 30 }, newExp("id=10"));
    expect(q.sql()).toBe('UPDATE "users" SET "age"={:p0}, "name"={:p1} WHERE id=10');
    expect(q.params()["p0"]).toBe(30);
    expect(q.params()["p1"]).toBe("James");

    q = b.update("users", { name: "James", age: 30 }, null);
    expect(q.sql()).toBe('UPDATE "users" SET "age"={:p0}, "name"={:p1}');
  });

  test("TestStandardBuilder_Delete", () => {
    const b = getStandardBuilder();
    let q = b.delete("users", newExp("id=10"));
    expect(q.sql()).toBe('DELETE FROM "users" WHERE id=10');
    q = b.delete("users", null);
    expect(q.sql()).toBe('DELETE FROM "users"');
  });

  test("TestStandardBuilder_CreateTable", () => {
    const b = getStandardBuilder();
    const q = b.createTable(
      "users",
      { id: "int primary key", name: "varchar(255)" },
      "ON DELETE CASCADE",
    );
    expect(q.sql()).toBe(
      'CREATE TABLE "users" ("id" int primary key, "name" varchar(255)) ON DELETE CASCADE',
    );
  });

  test("TestStandardBuilder_RenameTable", () => {
    const b = getStandardBuilder();
    const q = b.renameTable("users", "user");
    expect(q.sql()).toBe('RENAME TABLE "users" TO "user"');
  });

  test("TestStandardBuilder_DropTable", () => {
    const b = getStandardBuilder();
    const q = b.dropTable("users");
    expect(q.sql()).toBe('DROP TABLE "users"');
  });

  test("TestStandardBuilder_TruncateTable", () => {
    const b = getStandardBuilder();
    const q = b.truncateTable("users");
    expect(q.sql()).toBe('TRUNCATE TABLE "users"');
  });

  test("TestStandardBuilder_AddColumn", () => {
    const b = getStandardBuilder();
    const q = b.addColumn("users", "age", "int");
    expect(q.sql()).toBe('ALTER TABLE "users" ADD "age" int');
  });

  test("TestStandardBuilder_DropColumn", () => {
    const b = getStandardBuilder();
    const q = b.dropColumn("users", "age");
    expect(q.sql()).toBe('ALTER TABLE "users" DROP COLUMN "age"');
  });

  test("TestStandardBuilder_RenameColumn", () => {
    const b = getStandardBuilder();
    const q = b.renameColumn("users", "name", "username");
    expect(q.sql()).toBe('ALTER TABLE "users" RENAME COLUMN "name" TO "username"');
  });

  test("TestStandardBuilder_AlterColumn", () => {
    const b = getStandardBuilder();
    const q = b.alterColumn("users", "name", "int");
    expect(q.sql()).toBe('ALTER TABLE "users" CHANGE "name" "name" int');
  });

  test("TestStandardBuilder_AddPrimaryKey", () => {
    const b = getStandardBuilder();
    const q = b.addPrimaryKey("users", "pk", "id1", "id2");
    expect(q.sql()).toBe('ALTER TABLE "users" ADD CONSTRAINT "pk" PRIMARY KEY ("id1", "id2")');
  });

  test("TestStandardBuilder_DropPrimaryKey", () => {
    const b = getStandardBuilder();
    const q = b.dropPrimaryKey("users", "pk");
    expect(q.sql()).toBe('ALTER TABLE "users" DROP CONSTRAINT "pk"');
  });

  test("TestStandardBuilder_AddForeignKey", () => {
    const b = getStandardBuilder();
    const q = b.addForeignKey("users", "fk", ["p1", "p2"], ["f1", "f2"], "profile", "opt");
    expect(q.sql()).toBe(
      'ALTER TABLE "users" ADD CONSTRAINT "fk" FOREIGN KEY ("p1", "p2") REFERENCES "profile" ("f1", "f2") opt',
    );
  });

  test("TestStandardBuilder_DropForeignKey", () => {
    const b = getStandardBuilder();
    const q = b.dropForeignKey("users", "fk");
    expect(q.sql()).toBe('ALTER TABLE "users" DROP CONSTRAINT "fk"');
  });

  test("TestStandardBuilder_CreateIndex", () => {
    const b = getStandardBuilder();
    const q = b.createIndex("users", "idx", "id1", "id2");
    expect(q.sql()).toBe('CREATE INDEX "idx" ON "users" ("id1", "id2")');
  });

  test("TestStandardBuilder_CreateUniqueIndex", () => {
    const b = getStandardBuilder();
    const q = b.createUniqueIndex("users", "idx", "id1", "id2");
    expect(q.sql()).toBe('CREATE UNIQUE INDEX "idx" ON "users" ("id1", "id2")');
  });

  test("TestStandardBuilder_DropIndex", () => {
    const b = getStandardBuilder();
    const q = b.dropIndex("users", "idx");
    expect(q.sql()).toBe('DROP INDEX "idx" ON "users"');
  });
});
