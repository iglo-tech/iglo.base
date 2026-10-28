// Upstream: tools/search/simple_field_resolver_test.go

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { newFromDB } from "@/db/dbx/db";
import { type ResolverResult, newSimpleFieldResolver } from "@/search/simple-field-resolver";

test("SimpleFieldResolver.UpdateQuery", () => {
  const r = newSimpleFieldResolver("test");

  // [fieldName, expectQuery]
  const scenarios: [string, string][] = [
    // missing field (the query shouldn't change)
    ["", `SELECT "id" FROM "test"`],
    // unknown field (the query shouldn't change)
    ["unknown", `SELECT "id" FROM "test"`],
    // allowed field (the query shouldn't change)
    ["test", `SELECT "id" FROM "test"`],
  ];

  for (const [i, [fieldName, expectQuery]] of scenarios.entries()) {
    const db = newFromDB(new Database(":memory:"), "");
    const query = db.select("id").from("test");

    try {
      r.resolve(fieldName);
    } catch {
      // the error does not matter here
    }

    r.updateQuery(query);

    expect([i, query.build().sql()]).toEqual([i, expectQuery]);
  }
});

test("SimpleFieldResolver.Resolve", () => {
  const r = newSimpleFieldResolver("test", "^test_regex\\d+$", "Test columnify!", "data.test");

  // [fieldName, expectError, expectName]
  const scenarios: [string, boolean, string][] = [
    ["", true, ""],
    [" ", true, ""],
    ["unknown", true, ""],
    ["test", false, "[[test]]"],
    ["test.sub", true, ""],
    ["test_regex", true, ""],
    ["test_regex1", false, "[[test_regex1]]"],
    ["Test columnify!", false, "[[Testcolumnify]]"],
    ["data.test", false, "JSON_EXTRACT([[data]], '$.test')"],
  ];

  for (const [i, [fieldName, expectError, expectName]] of scenarios.entries()) {
    let result: ResolverResult | undefined;
    let err: unknown;
    try {
      result = r.resolve(fieldName);
    } catch (e) {
      err = e;
    }

    expect([i, err !== undefined]).toEqual([i, expectError]);
    if (result === undefined) {
      continue;
    }

    expect([i, result.identifier]).toEqual([i, expectName]);
    expect(Object.keys(result.params ?? {}).length).toBe(0);
  }
});

test("SimpleFieldResolver.Resolve json paths and errors", () => {
  const r = newSimpleFieldResolver("^\\w+[\\w\\.]*$");

  expect(r.resolve("data.a.0.b").identifier).toBe("JSON_EXTRACT([[data]], '$.a[0].b')");
  // strconv.Atoi accepts a sign and leading zeros, not digits past int64
  expect(r.resolve("data.01").identifier).toBe("JSON_EXTRACT([[data]], '$[01]')");
  expect(r.resolve("data.99999999999999999999").identifier).toBe(
    "JSON_EXTRACT([[data]], '$.99999999999999999999')",
  );
  expect(r.resolve("data.a").nullFallback).toBe(1);
  expect(r.resolve("data").nullFallback).toBeUndefined();
  expect(() => r.resolve("data:x")).toThrow('failed to resolve field "data:x"');
});
