// Upstream: tools/search/identifier_macros_test.go
//
// Upstream replaces its package-level timeNow; here the macros are given
// the time of an injected clock.

import { expect, test } from "bun:test";

import { identifierMacros } from "@/search/identifier-macros";
import { fromDate } from "@/tools/types/cast";

test("IdentifierMacros", () => {
  // time.Date(2023, 2, 3, 4, 5, 6, 7, time.UTC): a Date holds milliseconds,
  // which the macros read as whole milliseconds as well
  const now = new Date(Date.UTC(2023, 1, 3, 4, 5, 6, 0));
  expect(fromDate(now)).toEqual({ sec: 1675397106, nsec: 0 });

  const testMacros = new Map<string, unknown>([
    ["@now", "2023-02-03 04:05:06.000Z"],
    ["@yesterday", "2023-02-02 04:05:06.000Z"],
    ["@tomorrow", "2023-02-04 04:05:06.000Z"],
    ["@second", 6],
    ["@minute", 5],
    ["@hour", 4],
    ["@day", 3],
    ["@month", 2],
    ["@weekday", 5],
    ["@year", 2023],
    ["@todayStart", "2023-02-03 00:00:00.000Z"],
    ["@todayEnd", "2023-02-03 23:59:59.999Z"],
    ["@monthStart", "2023-02-01 00:00:00.000Z"],
    ["@monthEnd", "2023-02-28 23:59:59.999Z"],
    ["@yearStart", "2023-01-01 00:00:00.000Z"],
    ["@yearEnd", "2023-12-31 23:59:59.999Z"],
  ]);

  expect(identifierMacros.size).toBe(testMacros.size);

  for (const [key, expected] of testMacros) {
    const macro = identifierMacros.get(key);
    expect(macro).toBeDefined();
    expect([key, macro?.(now)]).toEqual([key, expected]);
  }
});

test("IdentifierMacros month and year ends", () => {
  // leap years, December and the 31st, as Go's AddDate(0, 1, -1) gives them
  const cases: [Date, string, string][] = [
    [new Date(Date.UTC(2024, 1, 29, 12)), "2024-02-29 23:59:59.999Z", "2024-02-28 12:00:00.000Z"],
    [
      new Date(Date.UTC(2023, 11, 31, 23, 59, 59, 999)),
      "2023-12-31 23:59:59.999Z",
      "2023-12-30 23:59:59.999Z",
    ],
    [new Date(Date.UTC(2023, 2, 1)), "2023-03-31 23:59:59.999Z", "2023-02-28 00:00:00.000Z"],
  ];
  for (const [now, monthEnd, yesterday] of cases) {
    expect(identifierMacros.get("@monthEnd")?.(now)).toBe(monthEnd);
    expect(identifierMacros.get("@yesterday")?.(now)).toBe(yesterday);
  }
  // Sunday is 0
  expect(identifierMacros.get("@weekday")?.(new Date(Date.UTC(2023, 1, 5)))).toBe(0);
});
