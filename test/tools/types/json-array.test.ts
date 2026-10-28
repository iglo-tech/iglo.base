// Upstream: tools/types/json_array_test.go
//
// A JSONArray is a plain array; JSONArray[int]/[string]/[any] differ only in
// the GoType given to scanJSONArray. Go's invalid UTF-8 byte "\xc3" is a
// lone surrogate in a JS string.

import { describe, expect, test } from "bun:test";

import {
  jsonArrayMarshalJSON,
  jsonArrayString,
  jsonArrayValue,
  scanJSONArray,
} from "@/tools/types/json-array";
import { anyType, intType, marshal, stringType } from "@/tools/types/go-json";

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("JSONArrayMarshalJSON", () => {
  const scenarios: [unknown[] | undefined, string][] = [
    [undefined, "[]"], // new(types.JSONArray[any]): a nil slice
    [[], `[]`],
    [[1, 2, 3], `[1,2,3]`],
    [["test1", "test2", "test3"], `["test1","test2","test3"]`],
    [[1, "test\ud800" /* invalid utf8 char to test mangling */], `[1,"test\ufffd"]`],
  ];

  scenarios.forEach(([json, expected], i) => {
    test(`${i}_${expected}`, () => {
      expect(jsonArrayMarshalJSON(json)).toBe(expected);
    });
  });
});

describe("JSONArrayString", () => {
  const scenarios: [unknown[] | undefined, string][] = [
    [undefined, "[]"],
    [[], `[]`],
    [[1, 2, 3], `[1,2,3]`],
    [["test1", "test2", "test3"], `["test1","test2","test3"]`],
    [[1, "test"], `[1,"test"]`],
  ];

  scenarios.forEach(([json, expected], i) => {
    test(`${i}_${expected}`, () => {
      expect(jsonArrayString(json)).toBe(expected);
    });
  });

  test("keeps the bytes json.Marshal wrote before an error", () => {
    // checked against the upstream binary
    expect(jsonArrayString([1, NaN])).toBe(`[1`);
    expect(jsonArrayString([NaN])).toBe(`[`);
    expect(jsonArrayString([1, [2, NaN]])).toBe(`[1,[2`);
    expect(jsonArrayString([1, { a: NaN }])).toBe(`[1,{"a"`);
  });
});

describe("JSONArrayValue", () => {
  const scenarios: [unknown[] | undefined, string][] = [
    [undefined, `[]`],
    [[], `[]`],
    [[1, 2, 3], `[1,2,3]`],
    [["test1", "test2", "test3"], `["test1","test2","test3"]`],
    [[1, "test"], `[1,"test"]`],
  ];

  scenarios.forEach(([json, expected], i) => {
    test(`${i}_${expected}`, () => {
      expect(jsonArrayValue(json)).toBe(expected);
    });
  });
});

describe("JSONArrayScan", () => {
  const scenarios: [unknown, boolean, string][] = [
    [``, false, `[]`],
    [new Uint8Array(), false, `[]`],
    [null, false, `[]`],
    [123, true, `[]`],
    [`""`, true, `[]`],
    [`invalid_json`, true, `[]`],
    [`"test"`, true, `[]`],
    [`1,2,3`, true, `[]`],
    [`[1, 2, 3`, true, `[]`],
    [`[1, 2, 3]`, false, `[1,2,3]`],
    [bytes(`[1, 2, 3]`), false, `[1,2,3]`],
    [`[1, "test"]`, false, `[1,"test"]`],
    [`[]`, false, `[]`],
  ];

  scenarios.forEach(([value, expectError, expectJSON], i) => {
    test(`${i}_${String(value)}`, () => {
      let arr: unknown[] = [];
      let hasErr = false;
      try {
        arr = scanJSONArray(value, anyType);
      } catch {
        hasErr = true; // Go resets the array to empty
      }
      expect(hasErr).toBe(expectError);
      expect(marshal(arr)).toBe(expectJSON);
    });
  });
});

// Not in upstream's tests: Go json v2 decoding into typed elements.
describe("JSONArrayScan typed", () => {
  const scenarios: [string, string, typeof anyType, boolean, unknown[]][] = [
    ["string elements", `["a","b"]`, stringType, false, ["a", "b"]],
    ["null string element is the zero value", `["a",null]`, stringType, false, ["a", ""]],
    ["number into string fails", `["a",1]`, stringType, true, []],
    ["int elements", `[1,-2,3]`, intType, false, [1, -2, 3]],
    ["int rejects a fraction", `[1.0]`, intType, true, []],
    ["int rejects an exponent", `[1e2]`, intType, true, []],
    ["int rejects overflow", `[9223372036854775808]`, intType, true, []],
    ["null array is empty", `null`, anyType, false, []],
    ["duplicate names fail", `[{"a":1,"a":2}]`, anyType, true, []],
    ["float64 overflow fails", `[1e400]`, anyType, true, []],
    ["lone surrogate escape fails", `["\\ud800"]`, anyType, true, []],
    ["trailing data fails", `[1] [2]`, anyType, true, []],
  ];

  for (const [name, value, elem, expectError, expected] of scenarios) {
    test(name, () => {
      let arr: unknown[] = [];
      let hasErr = false;
      try {
        arr = scanJSONArray(value, elem);
      } catch {
        hasErr = true;
      }
      expect(hasErr).toBe(expectError);
      expect(arr).toEqual(expected);
    });
  }

  test("invalid UTF-8 bytes fail", () => {
    expect(() => scanJSONArray(new Uint8Array([0x5b, 0x22, 0xff, 0x22, 0x5d]))).toThrow();
  });
});
