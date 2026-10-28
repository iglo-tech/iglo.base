// Upstream: core/validators/db_test.go
//
// UniqueId runs on a copy of upstream's tests/data (test/fixtures), opened
// with src/db's Databases as tests.NewTestApp opens it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Databases } from "@/db/base";
import { Errors } from "@/validation/error";
import { NormalizeUniqueIndexError, UniqueId } from "@/validators/db";
import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";

describe("TestUniqueId", () => {
  let app: Databases;

  beforeAll(() => {
    const dataDir = join(mkdtempSync(join(tmpdir(), "iglo-base-validators-")), "pb_data");
    copyDataDir(fixtureDir, dataDir);
    app = Databases.open({ dataDir });
  });

  afterAll(() => {
    app?.close();
  });

  const scenarios: [id: string, tableName: string, expectError: boolean][] = [
    ["", "", false],
    ["test", "", true],
    ["wsmn24bux7wo113", "_collections", true],
    ["test_unique_id", "unknown_table", true],
    ["test_unique_id", "_collections", false],
  ];

  for (const [i, [id, tableName, expectError]] of scenarios.entries()) {
    test(`${i}_${id}_${tableName}`, () => {
      const err = UniqueId(app.db(), tableName)(id);
      expect(err !== null).toBe(expectError);
    });
  }
});

describe("TestNormalizeUniqueIndexError", () => {
  const scenarios: [
    name: string,
    err: Error | null,
    table: string,
    names: string[],
    expectedKeys: string[] | null,
  ][] = [
    ["nil error (no changes)", null, "test", ["a", "b"], null],
    ["non-unique index error (no changes)", new Error("abc"), "test", ["a", "b"], null],
    [
      "validation error (no changes)",
      new Errors({ c: new Error("abc") }),
      "test",
      ["a", "b"],
      ["c"],
    ],
    [
      "unique index error but mismatched table name",
      new Error("UNIQUE constraint failed for fields test.a,test.b"),
      "example",
      ["a", "b"],
      null,
    ],
    [
      "unique index error with table name suffix matching the specified one",
      new Error("UNIQUE constraint failed for fields test_suffix.a,test_suffix.b"),
      "suffix",
      ["a", "b", "c"],
      null,
    ],
    [
      "unique index error but mismatched fields",
      new Error("UNIQUE constraint failed for fields test.a,test.b"),
      "test",
      ["c", "d"],
      null,
    ],
    [
      "unique index error with matching table name and fields",
      new Error("UNIQUE constraint failed for fields test.a,test.b"),
      "test",
      ["a", "b", "c"],
      ["a", "b"],
    ],
    [
      "unique index error with matching table name and field starting with the name of another non-unique field",
      new Error("UNIQUE constraint failed for fields test.a_2,test.c"),
      "test",
      ["a", "a_2", "c"],
      ["a_2", "c"],
    ],
  ];

  for (const [name, err, table, names, expectedKeys] of scenarios) {
    test(name, () => {
      const result = NormalizeUniqueIndexError(err, table, names);

      if (expectedKeys === null) {
        expect(result).toBe(err);
        return;
      }

      // tests.TestValidationErrors
      expect(result).toBeInstanceOf(Errors);
      expect(Object.keys((result as Errors).errors).toSorted()).toEqual(expectedKeys.toSorted());
    });
  }

  test("the normalized error is validation_not_unique", () => {
    const result = NormalizeUniqueIndexError(
      new Error("UNIQUE constraint failed: test.a"),
      "test",
      ["a"],
    ) as Errors;
    const err = result.errors.a as Error & { code(): string };
    expect(err.code()).toBe("validation_not_unique");
    expect(err.message).toBe("Value must be unique");
  });
});
