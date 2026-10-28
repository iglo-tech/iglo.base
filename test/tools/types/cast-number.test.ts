// Upstream: github.com/spf13/cast v1.10.0 basic_test.go (TestBool) and
// number_test.go (the float64 cases of TestNumber), for ToBoolE and
// ToFloat64E. Go's typed integers are bigints here, float64 is a number;
// the cases JS has no type for (float32, time.Duration, json.Number,
// aliases) are left out.

import { describe, expect, test } from "bun:test";

import { toBool, toBoolE, toFloat64, toFloat64E } from "@/tools/types/cast";

describe("ToFloat64E", () => {
  const cases: [unknown, number, boolean][] = [
    // positive numbers
    [8n, 8, false],
    [8, 8, false],
    [8.31, 8.31, false],
    ["1.7976931348623157e+308", Number.MAX_VALUE, false],
    // negative numbers
    [-8n, -8, false],
    [-8.31, -8.31, false],
    // other basic types
    [true, 1, false],
    [false, 0, false],
    ["8", 8, false],
    ["-8", -8, false],
    ["8.31", 8.31, false],
    ["-8.31", -8.31, false],
    ["", 0, false],
    [null, 0, false],
    [undefined, 0, false],
    // failure cases
    ["test", 0, true],
    [{}, 0, true],
    ["10...17", 0, true],
    ["10.foobar", 0, true],
    ["10.0i", 0, true],
    ["10.0E9", 10000000000, false],
    // strconv.ParseFloat forms (not in cast's table)
    ["0x10", 0, true], // a hex mantissa needs a p exponent
    ["0x1p-2", 0.25, false],
    ["1_000", 1000, false],
    ["inf", Infinity, false],
    ["-Infinity", -Infinity, false],
    ["1e400", 0, true],
  ];

  for (const [input, expected, fails] of cases) {
    test(String(input), () => {
      if (fails) {
        expect(() => toFloat64E(input)).toThrow();
      } else {
        expect(toFloat64E(input)).toBe(expected);
      }
      expect(toFloat64(input)).toBe(expected);
    });
  }

  test("NaN", () => {
    expect(toFloat64("NaN")).toBeNaN();
    expect(toFloat64(Number.NaN)).toBeNaN();
  });
});

describe("ToBoolE", () => {
  const cases: [unknown, boolean, boolean][] = [
    [0, false, false],
    [0n, false, false],
    [0.0, false, false],
    [null, false, false],
    [undefined, false, false],
    ["false", false, false],
    ["FALSE", false, false],
    ["False", false, false],
    ["f", false, false],
    ["F", false, false],
    ["0", false, false],
    [false, false, false],

    ["true", true, false],
    ["TRUE", true, false],
    ["True", true, false],
    ["t", true, false],
    ["T", true, false],
    ["1", true, false],

    [1, true, false],
    [1n, true, false],
    [1.0, true, false],
    [true, true, false],
    [-1, true, false],
    [-1n, true, false],
    [0.5, true, false],

    // failure cases
    ["test", false, true],
    ["", false, true],
    ["yes", false, true],
    [{}, false, true],
    [[true], false, true],
  ];

  for (const [input, expected, fails] of cases) {
    test(`${typeof input} ${String(input)}`, () => {
      if (fails) {
        expect(() => toBoolE(input)).toThrow();
      } else {
        expect(toBoolE(input)).toBe(expected);
      }
      expect(toBool(input)).toBe(expected);
    });
  }
});
