// Upstream: ozzo-validation v4.4.1 length_test.go
//
// The sql.NullString rows are dropped (driver.Valuer values, not portable).

import { describe, expect, test } from "bun:test";

import { type Error as ValidationError, NewError } from "@/validation/error";
import { Length, RuneLength } from "@/validation/length";

function assertError(expected: string, err: globalThis.Error | null): void {
  if (expected === "") {
    expect(err).toBeNull();
    return;
  }
  expect(err?.message).toBe(expected);
}

describe("TestLength", () => {
  const rows = [
    { tag: "t1", min: 2, max: 4, value: "abc", err: "" },
    { tag: "t2", min: 2, max: 4, value: "", err: "" },
    { tag: "t3", min: 2, max: 4, value: "abcdf", err: "the length must be between 2 and 4" },
    { tag: "t4", min: 0, max: 4, value: "ab", err: "" },
    { tag: "t5", min: 0, max: 4, value: "abcde", err: "the length must be no more than 4" },
    { tag: "t6", min: 2, max: 0, value: "ab", err: "" },
    { tag: "t7", min: 2, max: 0, value: "a", err: "the length must be no less than 2" },
    { tag: "t8", min: 2, max: 0, value: null, err: "" },
    { tag: "t9", min: 2, max: 0, value: 123, err: "cannot get the length of int" },
    { tag: "t13", min: 2, max: 2, value: "abcdf", err: "the length must be exactly 2" },
    { tag: "t14", min: 2, max: 2, value: "ab", err: "" },
    { tag: "t15", min: 0, max: 0, value: "", err: "" },
    { tag: "t16", min: 0, max: 0, value: "ab", err: "the value must be empty" },
  ];

  test.each(rows)("$tag", ({ min, max, value, err }) => {
    assertError(err, Length(min, max).validate(value));
  });
});

describe("TestRuneLength", () => {
  const rows = [
    { tag: "t1", min: 2, max: 4, value: "abc", err: "" },
    { tag: "t1.1", min: 2, max: 3, value: "💥💥", err: "" },
    { tag: "t1.2", min: 2, max: 3, value: "💥💥💥", err: "" },
    { tag: "t1.3", min: 2, max: 3, value: "💥", err: "the length must be between 2 and 3" },
    { tag: "t1.4", min: 2, max: 3, value: "💥💥💥💥", err: "the length must be between 2 and 3" },
    { tag: "t2", min: 2, max: 4, value: "", err: "" },
    { tag: "t3", min: 2, max: 4, value: "abcdf", err: "the length must be between 2 and 4" },
    { tag: "t4", min: 0, max: 4, value: "ab", err: "" },
    { tag: "t5", min: 0, max: 4, value: "abcde", err: "the length must be no more than 4" },
    { tag: "t6", min: 2, max: 0, value: "ab", err: "" },
    { tag: "t7", min: 2, max: 0, value: "a", err: "the length must be no less than 2" },
    { tag: "t8", min: 2, max: 0, value: null, err: "" },
    { tag: "t9", min: 2, max: 0, value: 123, err: "cannot get the length of int" },
  ];

  test.each(rows)("$tag", ({ min, max, value, err }) => {
    assertError(err, RuneLength(min, max).validate(value));
  });
});

describe("Test_LengthRule_Error", () => {
  test("messages for each range shape", () => {
    expect(Length(10, 20).validate("abc")?.message).toBe("the length must be between 10 and 20");
    expect(Length(0, 20).validate(Array.from({ length: 21 }, () => ""))?.message).toBe(
      "the length must be no more than 20",
    );
    expect(Length(10, 0).validate(Array.from({ length: 9 }, () => ""))?.message).toBe(
      "the length must be no less than 10",
    );
  });

  test("Length(0, 0) has the empty-required code and error() replaces the message", () => {
    const err = Length(0, 0).validate("x") as ValidationError;
    expect(err.code()).toBe("validation_length_empty_required");

    const r = Length(0, 0).error("123");
    expect((r.validate("x") as ValidationError).getMessage()).toBe("123");
  });
});

describe("TestLengthRule_ErrorObject", () => {
  test("errorObject() returns the given error object", () => {
    const err = NewError("code", "abc");
    const out = Length(10, 20).errorObject(err).validate("abc") as ValidationError;

    expect(out).toBe(err);
    expect(out.code()).toBe("code");
    expect(out.getMessage()).toBe("abc");
  });
});
