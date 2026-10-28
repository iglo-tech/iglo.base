// Upstream: ozzo-validation v4.4.1 in_test.go

import { describe, expect, test } from "bun:test";

import { In } from "@/validation/in";
import { type Error as ValidationError, NewError } from "@/validation/error";

function assertError(expected: string, err: globalThis.Error | null): void {
  if (expected === "") {
    expect(err).toBeNull();
    return;
  }
  expect(err?.message).toBe(expected);
}

describe("TestIn", () => {
  const rows = [
    { tag: "t0", values: [1, 2], value: 0, err: "" },
    { tag: "t1", values: [1, 2], value: 1, err: "" },
    { tag: "t2", values: [1, 2], value: 2, err: "" },
    { tag: "t3", values: [1, 2], value: 3, err: "must be a valid value" },
    { tag: "t4", values: [], value: 3, err: "must be a valid value" },
    { tag: "t5", values: [1, 2], value: "1", err: "must be a valid value" },
    // the pointer to 1 (t6) is the value 1 here
    { tag: "t6", values: [1, 2], value: 1, err: "" },
    // a nil pointer (t7) is null here
    { tag: "t7", values: [1, 2], value: null, err: "" },
    {
      tag: "t8",
      values: [new Uint8Array([1]), 1, 2],
      value: new Uint8Array([1]),
      err: "",
    },
  ];

  test.each(rows)("$tag", ({ values, value, err }) => {
    assertError(err, In(...values).validate(value));
  });
});

describe("Test_InRule_Error", () => {
  test("error() replaces the message", () => {
    const r = In(1, 2, 3);
    expect(r.validate(4)?.message).toBe("must be a valid value");
    expect(r.error("123").validate(4)?.message).toBe("123");
  });
});

describe("TestInRule_ErrorObject", () => {
  test("errorObject() returns the given error object", () => {
    const err = NewError("code", "abc");
    const out = In(1, 2, 3).errorObject(err).validate(4) as ValidationError;

    expect(out).toBe(err);
    expect(out.code()).toBe("code");
    expect(out.getMessage()).toBe("abc");
  });
});
