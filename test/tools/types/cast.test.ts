// Not an upstream test file: spf13/cast v1.10.0 behavior the ported tools
// rely on (ToString's float text, ToStringSlice).

import { describe, expect, test } from "bun:test";

import { formatFloatF, toString, toStringSlice } from "@/tools/types/cast";

describe("ToString float64", () => {
  // strconv.FormatFloat(f, 'f', -1, 64)
  const scenarios: [number, string][] = [
    [1, "1"],
    [1.5, "1.5"],
    [-0, "-0"],
    [1641024040, "1641024040"],
    [1e21, "1000000000000000000000"],
    [1.5e-7, "0.00000015"],
    [123.456, "123.456"],
    [0.1 + 0.2, "0.30000000000000004"],
    [Number.NaN, "NaN"],
    [Number.POSITIVE_INFINITY, "+Inf"],
    [Number.NEGATIVE_INFINITY, "-Inf"],
  ];

  for (const [value, expected] of scenarios) {
    test(String(value), () => {
      expect(formatFloatF(value)).toBe(expected);
    });
  }
});

describe("ToString", () => {
  const scenarios: [unknown, string][] = [
    ["a", "a"],
    [true, "true"],
    [12n, "12"],
    [null, ""],
    [new TextEncoder().encode("abc"), "abc"],
    [{ string: () => "stringer" }, "stringer"],
    [new Error("boom"), "boom"],
    [{ a: 1 }, ""], // unsupported: cast.ToString ignores the error
  ];

  scenarios.forEach(([value, expected], i) => {
    test(`${i}`, () => {
      expect(toString(value)).toBe(expected);
    });
  });
});

describe("ToStringSlice", () => {
  const scenarios: [unknown, string[]][] = [
    [null, []],
    [
      [1, "a", true, null],
      ["1", "a", "true", ""],
    ],
    [[{ a: 1 }], []],
    [" a\tb\u00a0 c ", ["a", "b", "c"]], // strings.Fields
    [12n, ["12"]],
  ];

  scenarios.forEach(([value, expected], i) => {
    test(`${i}`, () => {
      expect(toStringSlice(value)).toEqual(expected);
    });
  });
});
