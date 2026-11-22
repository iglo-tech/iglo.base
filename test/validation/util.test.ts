// Upstream: ozzo-validation v4.4.1 util_test.go
//
// Dropped rows: pointer values
// (&x, a nil *T, a *T struct field) collapse to the value they point to;
// typed integers, floats and named string types are the same JS values
// (JS has one number type and no named string types); a sql.Null* value is
// a driver.Valuer that is not ported (only JSONRaw and GeoPoint are).

import { describe, expect, test } from "bun:test";

import { Float64 } from "@/validation/error";
import {
  EnsureString,
  IsEmpty,
  Indirect,
  LengthOfValue,
  StringOrBytes,
  ToFloat,
  ToInt,
  ToUint,
} from "@/validation/util";
import { DateTime } from "@/tools/types/datetime";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

// a Go struct value (not a map, not a slice)
class Struct {
  readonly kind = "struct";
}

describe("util", () => {
  test.each([
    { tag: "t1", value: "abc", expected: "abc", hasError: false },
    { tag: "t3", value: enc("abc"), expected: "abc", hasError: false },
    { tag: "t5", value: 100, expected: "", hasError: true },
  ])("TestEnsureString $tag", ({ value, expected, hasError }) => {
    const [s, err] = EnsureString(value);
    if (hasError) {
      expect(err).not.toBeNull();
    } else {
      expect(err).toBeNull();
      expect(s).toBe(expected);
    }
  });

  test.each([
    { tag: "t1", value: "abc", str: "abc", bs: null, isString: true, isBytes: false },
    {
      tag: "t3",
      value: enc("abc"),
      str: "",
      bs: enc("abc"),
      isString: false,
      isBytes: true,
    },
    { tag: "t5", value: 100, str: "", bs: null, isString: false, isBytes: false },
    { tag: "t6", value: "", str: "", bs: null, isString: true, isBytes: false },
    { tag: "t12", value: null, str: "", bs: null, isString: false, isBytes: false },
  ])("TestStringOrBytes $tag", ({ value, str, bs, isString, isBytes }) => {
    const [gotIsString, gotStr, gotIsBytes, gotBs] = StringOrBytes(value);
    expect(gotStr).toBe(str);
    if (bs === null) {
      expect(gotBs).toBeNull();
    } else {
      expect(gotBs).toEqual(bs);
    }
    expect(gotIsString).toBe(isString);
    expect(gotIsBytes).toBe(isBytes);
  });

  test.each([
    { tag: "t1", value: "abc", length: 3, err: "" },
    { tag: "t2", value: [1, 2], length: 2, err: "" },
    { tag: "t3", value: { A: 1, B: 2 }, length: 2, err: "" },
    { tag: "t4", value: [0, 0, 0], length: 3, err: "" },
    { tag: "t6", value: 123, length: 0, err: "cannot get the length of int" },
  ])("TestLengthOfValue $tag", ({ value, length, err }) => {
    const [l, gotErr] = LengthOfValue(value);
    expect(l).toBe(length);
    if (err === "") {
      expect(gotErr).toBeNull();
    } else {
      expect(gotErr?.message).toBe(err);
    }
  });

  test.each([
    { tag: "t1", value: 1, result: 1n, err: "" },
    { tag: "t5", value: 1n, result: 1n, err: "" },
    {
      tag: "t8",
      value: new Float64(1),
      result: 0n,
      err: "cannot convert float64 to int64",
    },
    { tag: "t9", value: "abc", result: 0n, err: "cannot convert string to int64" },
    { tag: "t10", value: [1, 2], result: 0n, err: "cannot convert slice to int64" },
    { tag: "t11", value: { A: 1 }, result: 0n, err: "cannot convert map to int64" },
  ])("TestToInt $tag", ({ value, result, err }) => {
    const [l, gotErr] = ToInt(value);
    expect(l).toBe(result);
    if (err === "") {
      expect(gotErr).toBeNull();
    } else {
      expect(gotErr?.message).toBe(err);
    }
  });

  test.each([
    { tag: "t1", value: 1, result: 1n, err: "" },
    { tag: "t5", value: 1n, result: 1n, err: "" },
    {
      tag: "t9",
      value: new Float64(1),
      result: 0n,
      err: "cannot convert float64 to uint64",
    },
    { tag: "t10", value: "abc", result: 0n, err: "cannot convert string to uint64" },
    { tag: "t11", value: [1, 2], result: 0n, err: "cannot convert slice to uint64" },
    { tag: "t12", value: { A: 1 }, result: 0n, err: "cannot convert map to uint64" },
  ])("TestToUint $tag", ({ value, result, err }) => {
    const [l, gotErr] = ToUint(value);
    expect(l).toBe(result);
    if (err === "") {
      expect(gotErr).toBeNull();
    } else {
      expect(gotErr?.message).toBe(err);
    }
  });

  test.each([
    { tag: "t2", value: new Float64(1), result: 1, err: "" },
    { tag: "t7", value: "abc", result: 0, err: "cannot convert string to float64" },
    { tag: "t8", value: [1, 2], result: 0, err: "cannot convert slice to float64" },
    { tag: "t9", value: { A: 1 }, result: 0, err: "cannot convert map to float64" },
  ])("TestToFloat $tag", ({ value, result, err }) => {
    const [l, gotErr] = ToFloat(value);
    expect(l).toBe(result);
    if (err === "") {
      expect(gotErr).toBeNull();
    } else {
      expect(gotErr?.message).toBe(err);
    }
  });

  test.each([
    { tag: "t0", value: null, empty: true },
    { tag: "t1.1", value: "", empty: true },
    { tag: "t1.2", value: "1", empty: false },
    { tag: "t2.1", value: enc(""), empty: true },
    { tag: "t2.2", value: enc("1"), empty: false },
    { tag: "t3.1", value: {}, empty: true },
    { tag: "t3.2", value: { a: 1 }, empty: false },
    { tag: "t4.1", value: false, empty: true },
    { tag: "t4.2", value: true, empty: false },
    { tag: "t5.1", value: 0, empty: true },
    { tag: "t5.5", value: 0n, empty: true },
    { tag: "t5.6", value: 1, empty: false },
    { tag: "t5.10", value: 1n, empty: false },
    { tag: "t7.2", value: new Float64(0), empty: true },
    { tag: "t7.4", value: new Float64(1), empty: false },
    { tag: "t9.1", value: new Struct(), empty: false },
    { tag: "t10.1", value: DateTime.fromDate(new Date()), empty: false },
    { tag: "t10.3", value: new DateTime(), empty: true },
  ])("TestIsEmpty $tag", ({ value, empty }) => {
    expect(IsEmpty(value)).toBe(empty);
  });

  test.each([
    { tag: "t1", value: 100, result: 100, isNil: false },
    { tag: "t4", value: null, result: null, isNil: true },
  ])("TestIndirect $tag", ({ value, result, isNil }) => {
    const [r, gotNil] = Indirect(value);
    expect(r).toEqual(result);
    expect(gotNil).toBe(isNil);
  });
});
