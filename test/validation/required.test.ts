// Upstream: ozzo-validation v4.4.1 required_test.go

import { describe, expect, test } from "bun:test";

import { DateTime } from "@/tools/types/datetime";
import { type Error as ValidationError, NewError } from "@/validation/error";
import { NilOrNotEmpty, Required } from "@/validation/required";
import { Validate } from "@/validation/validation";

function assertError(expected: string, err: globalThis.Error | null): void {
  if (expected === "") {
    expect(err).toBeNull();
    return;
  }
  expect(err?.message).toBe(expected);
}

describe("TestRequired", () => {
  const rows = [
    { tag: "t1", value: 123, err: "" },
    { tag: "t2", value: "", err: "cannot be blank" },
    { tag: "t3", value: "123", err: "" },
    { tag: "t4", value: "", err: "cannot be blank" },
    { tag: "t5", value: null, err: "cannot be blank" },
    { tag: "t6", value: new DateTime(), err: "cannot be blank" },
  ];

  test.each(rows)("$tag", ({ value, err }) => {
    assertError(err, Required.validate(value));
  });
});

describe("TestRequiredRule_When", () => {
  test("disabled condition skips the check", () => {
    const r = Required.when(false);
    expect(Validate(null, r)).toBeNull();
  });

  test("enabled condition reports ErrRequired", () => {
    const r = Required.when(true);
    expect(Validate(null, r)?.message).toBe("cannot be blank");
  });
});

describe("TestNilOrNotEmpty", () => {
  const rows = [
    { tag: "t1", value: 123, err: "" },
    { tag: "t2", value: "", err: "cannot be blank" },
    { tag: "t3", value: "123", err: "" },
    { tag: "t4", value: "", err: "cannot be blank" },
    { tag: "t5", value: null, err: "" },
  ];

  test.each(rows)("$tag", ({ value, err }) => {
    assertError(err, NilOrNotEmpty.validate(value));
  });
});

describe("Test_requiredRule_Error", () => {
  test("Required keeps the default message until error() sets one", () => {
    expect(Required.validate(null)?.message).toBe("cannot be blank");
    const r2 = Required.error("123");
    expect(Required.validate(null)?.message).toBe("cannot be blank");
    expect(r2.validate(null)?.message).toBe("123");
    // skipNil is false: a nil value is still rejected
    expect(r2.validate(null)).not.toBeNull();
  });

  test("NilOrNotEmpty accepts nil and keeps the default message", () => {
    expect(NilOrNotEmpty.validate("")?.message).toBe("cannot be blank");
    const r2 = NilOrNotEmpty.error("123");
    expect(NilOrNotEmpty.validate("")?.message).toBe("cannot be blank");
    expect(r2.validate("")?.message).toBe("123");
    // skipNil is true: a nil value is valid
    expect(r2.validate(null)).toBeNull();
  });
});

describe("TestRequiredRule_Error", () => {
  test("errorObject() returns the given error object", () => {
    const err = NewError("code", "abc");
    const out = Required.errorObject(err).validate(null) as ValidationError;

    expect(out).toBe(err);
    expect(out.code()).toBe("code");
    expect(out.getMessage()).toBe("abc");
    expect(Required.validate(null)).not.toBe(err);
  });
});
