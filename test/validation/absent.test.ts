// Upstream: ozzo-validation v4.4.1 absent_test.go

import { describe, expect, test } from "bun:test";

import { DateTime } from "@/tools/types/datetime";
import { type Error as ValidationError, NewError } from "@/validation/error";
import { Empty, Nil } from "@/validation/absent";
import { Validate } from "@/validation/validation";

function assertError(expected: string, err: globalThis.Error | null): void {
  if (expected === "") {
    expect(err).toBeNull();
    return;
  }
  expect(err?.message).toBe(expected);
}

describe("TestNil", () => {
  const rows = [
    { tag: "t1", value: 123, err: "must be blank" },
    { tag: "t2", value: "", err: "must be blank" },
    { tag: "t3", value: "123", err: "must be blank" },
    { tag: "t4", value: "", err: "must be blank" },
    { tag: "t5", value: null, err: "" },
    { tag: "t6", value: new DateTime(), err: "must be blank" },
  ];

  test.each(rows)("$tag", ({ value, err }) => {
    assertError(err, Nil.validate(value));
  });
});

describe("TestEmpty", () => {
  const time1 = DateTime.fromInstant({ sec: Math.floor(globalThis.Date.now() / 1000), nsec: 0 });
  const rows = [
    { tag: "t1", value: 123, err: "must be blank" },
    { tag: "t2", value: "", err: "" },
    { tag: "t3", value: "123", err: "must be blank" },
    { tag: "t4", value: "", err: "" },
    { tag: "t5", value: null, err: "" },
    { tag: "t6", value: time1, err: "must be blank" },
    { tag: "t7", value: new DateTime(), err: "" },
  ];

  test.each(rows)("$tag", ({ value, err }) => {
    assertError(err, Empty.validate(value));
  });
});

describe("TestAbsentRule_When", () => {
  test("disabled condition skips the check", () => {
    expect(Validate(42, Nil.when(false))).toBeNull();
  });

  test("enabled condition reports ErrNil", () => {
    expect(Validate(42, Nil.when(true))?.message).toBe("must be blank");
  });
});

describe("Test_absentRule_Error", () => {
  test("Nil keeps the default message until error() sets one", () => {
    expect(Nil.validate("42")?.message).toBe("must be blank");
    const r2 = Nil.error("123");
    expect(Nil.validate("42")?.message).toBe("must be blank");
    expect(r2.validate("42")?.message).toBe("123");
    // skipNil is false: a nil value is still checked (and is valid)
    expect(r2.validate(null)).toBeNull();
  });

  test("Empty accepts empty values and keeps the default message", () => {
    expect(Empty.validate("42")?.message).toBe("must be blank");
    const r2 = Empty.error("123");
    expect(Empty.validate("42")?.message).toBe("must be blank");
    expect(r2.validate("42")?.message).toBe("123");
    // skipNil is true: an empty value is valid
    expect(r2.validate("")).toBeNull();
  });
});

describe("TestAbsentRule_Error", () => {
  test("errorObject() returns the given error object", () => {
    const err = NewError("code", "abc");
    const out = Nil.errorObject(err).validate("42") as ValidationError;

    expect(out).toBe(err);
    expect(out.code()).toBe("code");
    expect(out.getMessage()).toBe("abc");
    expect(Nil.validate("42")).not.toBe(err);
  });
});
