// Upstream: ozzo-validation v4.4.1 not_in_test.go

import { describe, expect, test } from "bun:test";

import { type Error as ValidationError, NewError } from "@/validation/error";
import { NotIn } from "@/validation/not-in";

function assertError(expected: string, err: globalThis.Error | null): void {
  if (expected === "") {
    expect(err).toBeNull();
    return;
  }
  expect(err?.message).toBe(expected);
}

describe("TestNotIn", () => {
  const rows = [
    { tag: "t0", values: [1, 2], value: 0, err: "" },
    { tag: "t1", values: [1, 2], value: 1, err: "must not be in list" },
    { tag: "t2", values: [1, 2], value: 2, err: "must not be in list" },
    { tag: "t3", values: [1, 2], value: 3, err: "" },
    { tag: "t4", values: [], value: 3, err: "" },
    { tag: "t5", values: [1, 2], value: "1", err: "" },
    // the pointer to 1 (t6) is the value 1 here
    { tag: "t6", values: [1, 2], value: 1, err: "must not be in list" },
    // a nil pointer (t7) is null here
    { tag: "t7", values: [1, 2], value: null, err: "" },
  ];

  test.each(rows)("$tag", ({ values, value, err }) => {
    assertError(err, NotIn(...values).validate(value));
  });
});

describe("Test_NotInRule_Error", () => {
  test("error() replaces the message", () => {
    const r = NotIn(1, 2, 3);
    expect(r.validate(1)?.message).toBe("must not be in list");
    expect(r.error("123").validate(1)?.message).toBe("123");
  });
});

describe("TestNotInRule_ErrorObject", () => {
  test("errorObject() returns the given error object", () => {
    const err = NewError("code", "abc");
    const out = NotIn(1, 2, 3).errorObject(err).validate(1) as ValidationError;

    expect(out).toBe(err);
    expect(out.code()).toBe("code");
    expect(out.getMessage()).toBe("abc");
  });
});
