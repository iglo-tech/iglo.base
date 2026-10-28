// Upstream: tools/search/filter_test.go

import { describe, expect, test } from "bun:test";

import type { Clock } from "@/app/clock";
import { type DB, newFromDB } from "@/db/dbx/db";
import type { Expression } from "@/db/dbx/expression";
import type { Params } from "@/db/dbx/query";
import {
  type FilterData,
  filterBuildExpr,
  filterBuildExprWithLimit,
  ParsedFilterCache,
} from "@/search/filter";
import { newSimpleFieldResolver } from "@/search/simple-field-resolver";
import { Database } from "bun:sqlite";

const clock: Clock = { now: () => new Date(Date.UTC(2023, 1, 3, 4, 5, 6, 7)) };

function newDB(): DB {
  return newFromDB(new Database(":memory:"), "sqlite");
}

// the SQL dbx logs for `SELECT * WHERE expr` (with the params inlined)
function loggedSelect(expr: Expression): string {
  const db = newDB();
  const calledQueries: string[] = [];
  db.queryLogFunc = (_ms, sql) => calledQueries.push(sql);
  db.execLogFunc = (_ms, sql) => calledQueries.push(sql);
  try {
    db.select().where(expr).build().execute();
  } catch {
    // the columns do not exist; the statement is logged anyway
  }
  expect(calledQueries.length).toBe(1);
  return calledQueries[0] as string;
}

// regexp.QuoteMeta, then TEST as \w+
function expectPatternRegex(expectPattern: string): RegExp {
  const quoted = expectPattern.replace(/[\\.+*?()|[\]{}^$]/g, "\\$&");
  return new RegExp("^" + quoted.replaceAll("TEST", "\\w+") + "$");
}

describe("FilterData.BuildExpr", () => {
  const resolver = newSimpleFieldResolver(
    "test1",
    "test2",
    "test3",
    "^test4_\\w+$",
    "^test5\\.[\\w\\.\\:]*\\w+$",
  );

  // [name, filterData, expectError, expectPattern]
  const scenarios: [string, FilterData, boolean, string][] = [
    ["empty", "", true, ""],
    ["invalid format", "(test1 > 1", true, ""],
    ["invalid operator", "test1 + 123", true, ""],
    ["unknown field", "test1 = 'example' && unknown > 1", true, ""],
    ["simple expression", "test1 > 1", false, "[[test1]] > {:TEST}"],
    ["empty string vs null", "'' = null && null != ''", false, "('' = '' AND '' IS NOT '')"],
    [
      "like with 2 columns",
      "test1 ~ test2",
      false,
      "[[test1]] LIKE ('%' || [[test2]] || '%') ESCAPE '\\'",
    ],
    [
      "like with right column operand",
      "'lorem' ~ test1",
      false,
      "{:TEST} LIKE ('%' || [[test1]] || '%') ESCAPE '\\'",
    ],
    [
      "like with left column operand and text as right operand",
      "test1 ~ 'lorem'",
      false,
      "[[test1]] LIKE {:TEST} ESCAPE '\\'",
    ],
    [
      "not like with 2 columns",
      "test1 !~ test2",
      false,
      "[[test1]] NOT LIKE ('%' || [[test2]] || '%') ESCAPE '\\'",
    ],
    [
      "not like with right column operand",
      "'lorem' !~ test1",
      false,
      "{:TEST} NOT LIKE ('%' || [[test1]] || '%') ESCAPE '\\'",
    ],
    [
      "like with left column operand and text as right operand",
      "test1 !~ 'lorem'",
      false,
      "[[test1]] NOT LIKE {:TEST} ESCAPE '\\'",
    ],
    [
      "nested json no coalesce",
      "test5.a = test5.b || test5.c != test5.d",
      false,
      "(JSON_EXTRACT([[test5]], '$.a') IS JSON_EXTRACT([[test5]], '$.b') OR JSON_EXTRACT([[test5]], '$.c') IS NOT JSON_EXTRACT([[test5]], '$.d'))",
    ],
    [
      "macros",
      "\n\t\t\t\ttest4_1 > @now &&\n\t\t\t\ttest4_2 > @second &&\n\t\t\t\ttest4_3 > @minute &&\n\t\t\t\ttest4_4 > @hour &&\n\t\t\t\ttest4_5 > @day &&\n\t\t\t\ttest4_6 > @year &&\n\t\t\t\ttest4_7 > @month &&\n\t\t\t\ttest4_9 > @weekday &&\n\t\t\t\ttest4_9 > @todayStart &&\n\t\t\t\ttest4_10 > @todayEnd &&\n\t\t\t\ttest4_11 > @monthStart &&\n\t\t\t\ttest4_12 > @monthEnd &&\n\t\t\t\ttest4_13 > @yearStart &&\n\t\t\t\ttest4_14 > @yearEnd\n\t\t\t",
      false,
      "([[test4_1]] > {:TEST} AND [[test4_2]] > {:TEST} AND [[test4_3]] > {:TEST} AND [[test4_4]] > {:TEST} AND [[test4_5]] > {:TEST} AND [[test4_6]] > {:TEST} AND [[test4_7]] > {:TEST} AND [[test4_9]] > {:TEST} AND [[test4_9]] > {:TEST} AND [[test4_10]] > {:TEST} AND [[test4_11]] > {:TEST} AND [[test4_12]] > {:TEST} AND [[test4_13]] > {:TEST} AND [[test4_14]] > {:TEST})",
    ],
    [
      "complex expression",
      "((test1 > 1) || (test2 != 2)) && test3 ~ '%%example' && test4_sub = null",
      false,
      "(([[test1]] > {:TEST} OR [[test2]] IS NOT {:TEST}) AND [[test3]] LIKE {:TEST} ESCAPE '\\' AND ([[test4_sub]] = '' OR [[test4_sub]] IS NULL))",
    ],
    [
      "combination of special literals (null, true, false)",
      "test1=true && test2 != false && null = test3 || null != test4_sub",
      false,
      "([[test1]] = 1 AND [[test2]] IS NOT 0 AND ('' = [[test3]] OR [[test3]] IS NULL) OR ('' IS NOT [[test4_sub]] AND [[test4_sub]] IS NOT NULL))",
    ],
    [
      "all operators",
      "(test1 = test2 || test2 != test3) && (test2 ~ 'example' || test2 !~ '%%abc') && 'switch1%%' ~ test1 && 'switch2' !~ test2 && test3 > 1 && test3 >= 0 && test3 <= 4 && 2 < 5",
      false,
      "((COALESCE([[test1]], '') = COALESCE([[test2]], '') OR COALESCE([[test2]], '') IS NOT COALESCE([[test3]], '')) AND ([[test2]] LIKE {:TEST} ESCAPE '\\' OR [[test2]] NOT LIKE {:TEST} ESCAPE '\\') AND {:TEST} LIKE ('%' || [[test1]] || '%') ESCAPE '\\' AND {:TEST} NOT LIKE ('%' || [[test2]] || '%') ESCAPE '\\' AND [[test3]] > {:TEST} AND [[test3]] >= {:TEST} AND [[test3]] <= {:TEST} AND {:TEST} < {:TEST})",
    ],
    [
      "geoDistance function",
      "geoDistance(1,2,3,4) < 567",
      false,
      "(6371 * acos(min(1, max(-1, cos(radians({:TEST})) * cos(radians({:TEST})) * cos(radians({:TEST}) - radians({:TEST})) + sin(radians({:TEST})) * sin(radians({:TEST})))))) < {:TEST}",
    ],
  ];

  for (const [name, filterData, expectError, expectPattern] of scenarios) {
    test(name, () => {
      let expr: Expression | undefined;
      let err: unknown;
      try {
        expr = filterBuildExpr(filterData, resolver, { clock });
      } catch (e) {
        err = e;
      }

      expect(err !== undefined).toBe(expectError);
      if (expr === undefined) {
        return;
      }

      const rawSql = expr.build(newDB(), {});
      expect(rawSql).toMatch(expectPatternRegex(expectPattern));
    });
  }
});

test("FilterData.BuildExpr with params", () => {
  const date = new Date(Date.UTC(2023, 0, 1));

  const resolver = newSimpleFieldResolver("^test\\w+$");

  const filter: FilterData = `
		test1 = {:test1} ||
		test2 = {:test2} ||
		test3a = {:test3} ||
		test3b = {:test3} ||
		test4 = {:test4} ||
		test5 = {:test5} ||
		test6 = {:test6} ||
		test7 = {:test7} ||
		test8 = {:test8} ||
		test9 = {:test9} ||
		test10 = {:test10} ||
		test11 = {:test11} ||
		test12 = {:test12} ||
		test13 = {:test13}
	`;

  const replacements: Params[] = [
    { test1: true },
    { test2: false },
    { test3: 123.456 },
    { test4: null },
    {
      test5: "",
      test6: "simple",
      test7: `'single_quotes'`,
      test8: `"double_quotes"`,
      test9: "'\"quote_with_backslash\\",
    },
    { test10: date },
    { test11: ["a", "'quote", `"quote`] },
    { test12: { a: 123, b: `quote"` } },
    { test13: "a\nb" },
  ];

  const expr = filterBuildExpr(filter, resolver, { clock }, ...replacements);

  let expectedQuery = `SELECT * WHERE ([[test1]] = 1 OR [[test2]] = 0 OR [[test3a]] = 123.456 OR [[test3b]] = 123.456 OR ([[test4]] = '' OR [[test4]] IS NULL) OR ([[test5]] = '' OR [[test5]] IS NULL) OR [[test6]] = 'simple' OR [[test7]] = '''single_quotes''' OR [[test8]] = '"double_quotes"' OR [[test9]] = '''"quote_with_backslash\\' OR [[test10]] = '2023-01-01 00:00:00 +0000 UTC' OR [[test11]] = '["a","''quote","\\"quote"]' OR [[test12]] = '{"a":123,"b":"quote\\""}' OR [[test13]] = 'a`;
  expectedQuery += "\nb')";
  expect(loggedSelect(expr)).toBe(expectedQuery);
});

describe("FilterData.BuildExpr with params fallback error", () => {
  const resolver = newSimpleFieldResolver("test");

  const filter: FilterData = `test = {:test}`;

  test("non-string type but valid json", () => {
    expect(() =>
      filterBuildExpr(filter, resolver, { clock }, { test: { a: "123" } }),
    ).not.toThrow();
  });

  test("non-string type but invalid json", () => {
    const brokenJSON = {
      marshalJSON(): string {
        throw new Error("test_error");
      },
    };
    expect(() => filterBuildExpr(filter, resolver, { clock }, { test: brokenJSON })).toThrow(
      'failed to serialize param "test": test_error',
    );
  });
});

describe("FilterData.BuildExprWithLimit", () => {
  const resolver = newSimpleFieldResolver("^\\w+$");

  // [limit, filter, expectError]
  const scenarios: [number, FilterData, boolean][] = [
    [1, "1 = 1", false],
    [0, "1 = 1", true], // new cache entry should be created
    [2, "1 = 1 || 1 = 1", false],
    [1, "1 = 1 || 1 = 1", true],
    [3, "1 = 1 || 1 = 1", false],
    [6, "(1=1 || 1=1) && (1=1 || (1=1 || 1=1)) && (1=1)", false],
    [5, "(1=1 || 1=1) && (1=1 || (1=1 || 1=1)) && (1=1)", true],
  ];

  // upstream's cache is shared by all calls; here one cache is passed to
  // every scenario, and every scenario also runs without a cache
  const cache = new ParsedFilterCache();

  for (const [i, [limit, filter, expectError]] of scenarios.entries()) {
    test(`limit_${i}:${limit}`, () => {
      for (const options of [{ clock, cache }, { clock }]) {
        let err: unknown;
        try {
          filterBuildExprWithLimit(filter, resolver, limit, options);
        } catch (e) {
          err = e;
        }
        expect(err !== undefined).toBe(expectError);
      }
    });
  }
});

test("Like params wrapping", () => {
  const resolver = newSimpleFieldResolver("^test\\w+$");

  const filter: FilterData = `
		test1 ~ {:p1} ||
		test2 ~ {:p2} ||
		test3 ~ {:p3} ||
		test4 ~ {:p4} ||
		test5 ~ {:p5} ||
		test6 ~ {:p6} ||
		test7 ~ {:p7} ||
		test8 ~ {:p8} ||
		test9 ~ {:p9} ||
		test10 ~ {:p10} ||
		test11 ~ {:p11} ||
		test12 ~ {:p12} ||
		test13 ~ {:p13}
	`;

  const replacements: Params[] = [
    { p1: String.raw`abc` },
    { p2: String.raw`ab%c` },
    { p3: String.raw`ab\%c` },
    { p4: String.raw`%ab\%c` },
    { p5: String.raw`ab\\%c` },
    { p6: String.raw`ab\\\%c` },
    { p7: String.raw`ab_c` },
    { p8: String.raw`ab\_c` },
    { p9: String.raw`%ab_c` },
    { p10: String.raw`ab\c` },
    { p11: String.raw`_ab\c_` },
    { p12: String.raw`ab\c%` },
    { p13: "a\nb\\" },
  ];

  const expr = filterBuildExpr(filter, resolver, { clock }, ...replacements);

  let expectedQuery = String.raw`SELECT * WHERE ([[test1]] LIKE '%abc%' ESCAPE '\' OR [[test2]] LIKE 'ab%c' ESCAPE '\' OR [[test3]] LIKE '%ab\%c%' ESCAPE '\' OR [[test4]] LIKE '%ab\%c' ESCAPE '\' OR [[test5]] LIKE 'ab\\%c' ESCAPE '\' OR [[test6]] LIKE '%ab\\\%c%' ESCAPE '\' OR [[test7]] LIKE '%ab\_c%' ESCAPE '\' OR [[test8]] LIKE '%ab\_c%' ESCAPE '\' OR [[test9]] LIKE '%ab_c' ESCAPE '\' OR [[test10]] LIKE '%ab\\c%' ESCAPE '\' OR [[test11]] LIKE '%\_ab\\c\_%' ESCAPE '\' OR [[test12]] LIKE 'ab\c%' ESCAPE '\' OR [[test13]] LIKE '%a`;
  expectedQuery += "\n" + String.raw`b\\%' ESCAPE '\')`;
  expect(loggedSelect(expr)).toBe(expectedQuery);
});
