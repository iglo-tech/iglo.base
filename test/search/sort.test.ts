// Upstream: tools/search/sort_test.go

import { expect, test } from "bun:test";

import { newSimpleFieldResolver } from "@/search/simple-field-resolver";
import {
  parseSortFromString,
  type SortField,
  SortAsc,
  SortDesc,
  sortFieldBuildExpr,
} from "@/search/sort";
import { marshalStruct } from "@/fields/field";

test("SortField.BuildExpr", () => {
  const resolver = newSimpleFieldResolver("test1", "test2", "test3", "test4.sub");

  // [sortField, expectError, expectExpression]
  const scenarios: [SortField, boolean, string][] = [
    // empty
    [{ name: "", direction: SortDesc }, true, ""],
    // unknown field
    [{ name: "unknown", direction: SortAsc }, true, ""],
    // placeholder field
    [{ name: "'test'", direction: SortAsc }, true, ""],
    // null field
    [{ name: "null", direction: SortAsc }, true, ""],
    // allowed field - asc
    [{ name: "test1", direction: SortAsc }, false, "[[test1]] ASC"],
    // allowed field - desc
    [{ name: "test1", direction: SortDesc }, false, "[[test1]] DESC"],
    // special @random field (ignore direction)
    [{ name: "@random", direction: SortDesc }, false, "RANDOM()"],
    // special _rowid_ field
    [{ name: "@rowid", direction: SortDesc }, false, "[[_rowid_]] DESC"],
  ];

  for (const [sortField, expectError, expectExpression] of scenarios) {
    let result = "";
    let err: unknown;
    try {
      result = sortFieldBuildExpr(sortField, resolver);
    } catch (e) {
      err = e;
    }

    expect([sortField.name, err !== undefined]).toEqual([sortField.name, expectError]);
    expect(result).toBe(expectExpression);
  }

  expect(() => sortFieldBuildExpr({ name: "unknown", direction: SortAsc }, resolver)).toThrow(
    'invalid sort field "unknown"',
  );
});

// json.Marshal of []SortField
export function marshalSort(fields: readonly SortField[]): string {
  return (
    "[" +
    fields
      .map((f) =>
        marshalStruct([
          ["name", f.name],
          ["direction", f.direction],
        ]),
      )
      .join(",") +
    "]"
  );
}

test("ParseSortFromString", () => {
  // [value, expected]
  const scenarios: [string, string][] = [
    ["", `[{"name":"","direction":"ASC"}]`],
    ["test", `[{"name":"test","direction":"ASC"}]`],
    ["+test", `[{"name":"test","direction":"ASC"}]`],
    ["-test", `[{"name":"test","direction":"DESC"}]`],
    [
      "test1,-test2,+test3",
      `[{"name":"test1","direction":"ASC"},{"name":"test2","direction":"DESC"},{"name":"test3","direction":"ASC"}]`,
    ],
    ["@random,-test", `[{"name":"@random","direction":"ASC"},{"name":"test","direction":"DESC"}]`],
    ["-@rowid,-test", `[{"name":"@rowid","direction":"DESC"},{"name":"test","direction":"DESC"}]`],
  ];

  for (const [value, expected] of scenarios) {
    expect([value, marshalSort(parseSortFromString(value))]).toEqual([value, expected]);
  }

  // only one sign is removed; whitespace is trimmed first
  expect(parseSortFromString(" --a , ++b,\t-c\n")).toEqual([
    { name: "-a", direction: SortDesc },
    { name: "+b", direction: SortAsc },
    { name: "c", direction: SortDesc },
  ]);
});
