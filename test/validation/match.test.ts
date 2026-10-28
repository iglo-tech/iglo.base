// Upstream: ozzo-validation v4.4.1 match_test.go

import { describe, expect, test } from "bun:test";

import { mustCompile } from "@/tools/regexp/regexp";
import { type Error as ValidationError, NewError } from "@/validation/error";
import { Match } from "@/validation/match";

function assertError(expected: string, err: globalThis.Error | null): void {
  if (expected === "") {
    expect(err).toBeNull();
    return;
  }
  expect(err?.message).toBe(expected);
}

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("TestMatch", () => {
  const rows = [
    { tag: "t1", value: "abc", err: "" },
    { tag: "t2", value: "", err: "" },
    // a nil *string (t3) is null here
    { tag: "t3", value: null, err: "" },
    { tag: "t4", value: "123", err: "must be in a valid format" },
    { tag: "t5", value: bytes("abc"), err: "" },
    { tag: "t6", value: bytes("123"), err: "must be in a valid format" },
    { tag: "t7", value: bytes(""), err: "" },
    { tag: "t8", value: null, err: "" },
  ];

  test.each(rows)("$tag", ({ value, err }) => {
    assertError(err, Match(mustCompile("[a-z]+")).validate(value));
  });
});

describe("Test_MatchRule_Error", () => {
  test("error() replaces the message", () => {
    const r = Match(mustCompile("[a-z]+"));
    expect(r.validate("13")?.message).toBe("must be in a valid format");
    expect(r.error("123").validate("13")?.message).toBe("123");
  });
});

describe("TestMatchRule_ErrorObject", () => {
  test("errorObject() returns the given error object", () => {
    const err = NewError("code", "abc");
    const out = Match(mustCompile("[a-z]+")).errorObject(err).validate("13") as ValidationError;

    expect(out).toBe(err);
    expect(out.code()).toBe("code");
    expect(out.getMessage()).toBe("abc");
  });
});
