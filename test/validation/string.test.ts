// Upstream: ozzo-validation v4.4.1 string_test.go
//
// Dropped: TestGetErrorFieldName (struct tags), the
// sql.NullString rows (a driver.Valuer that is not ported), and the &value
// pointer rows (they are the same JS values as the rows kept). The
// accessors of the rule's private fields (v.err, v.validate) are checked
// through the errors the rule returns.

import { describe, expect, test } from "bun:test";

import { NewError, type Error as ValidationError } from "@/validation/error";
import { NewStringRule, NewStringRuleWithError } from "@/validation/string";

function validateMe(s: string): boolean {
  return s === "me";
}

describe("string", () => {
  test("TestNewStringRule", () => {
    const err = NewStringRule(validateMe, "abc").validate("not me") as ValidationError;
    expect(err.code()).toBe("");
    expect(err.getMessage()).toBe("abc");
  });

  test("TestNewStringRuleWithError", () => {
    const err = NewError("C", "abc");
    const v = NewStringRuleWithError(validateMe, err);

    const got = v.validate("not me");
    expect(got).toBe(err);
    expect((got as ValidationError).code()).toBe("C");
    expect((got as ValidationError).getMessage()).toBe("abc");
  });

  test("TestStringRule_Error", () => {
    const err = NewError("code", "abc");
    const v = NewStringRuleWithError(validateMe, err).error("abc");
    const got = v.validate("not me") as ValidationError;
    expect(got.code()).toBe("code");
    expect(got.getMessage()).toBe("abc");

    const v2 = v.error("correct");
    const got2 = v2.validate("not me") as ValidationError;
    expect(got.code()).toBe("code");
    expect(got2.getMessage()).toBe("correct");
    expect(got.getMessage()).toBe("abc");
  });

  test("TestStringValidator_Validate", () => {
    const v = NewStringRule(validateMe, "wrong_rule").error("wrong");

    expect(v.validate("me")).toBeNull();
    expect(v.validate("")).toBeNull();
    expect(v.validate(null)).toBeNull();

    let err = v.validate("not me");
    expect(err?.message).toBe("wrong");

    err = v.validate(100);
    expect(err).not.toBeNull();
    expect(err?.message).not.toBe("wrong");

    const v2 = v.error("Wrong!");
    err = v2.validate("not me");
    expect(err?.message).toBe("Wrong!");
  });

  test("TestStringRule_ErrorObject", () => {
    const r = NewStringRule(validateMe, "wrong_rule");

    const err = NewError("code", "abc");
    const r2 = r.errorObject(err);

    const got = r2.validate("not me");
    expect(got).toBe(err);
    expect((got as ValidationError).code()).toBe("code");
    expect((got as ValidationError).getMessage()).toBe("abc");
  });
});
