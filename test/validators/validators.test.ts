// Upstream: core/validators/validators_test.go
//
// fmt's %v of a nil error is "<nil>": a null result here.

import { describe, expect, test } from "bun:test";

import { Errors } from "@/validation/error";
import { JoinValidationErrors } from "@/validators/validators";

describe("TestJoinValidationErrors", () => {
  const scenarios: [errA: Error | null, errB: Error | null, expected: string][] = [
    [null, null, "<nil>"],
    [new Error("abc"), null, "abc"],
    [null, new Error("abc"), "abc"],
    [new Error("abc"), new Error("456"), "abc\n456"],
    [new Errors({ test1: new Error("test1_err") }), null, "test1: test1_err."],
    [null, new Errors({ test2: new Error("test2_err") }), "test2: test2_err."],
    [new Errors(), new Error("456"), "\n456"],
    [new Error("456"), new Errors(), "456\n"],
    [new Errors({ test1: new Error("test1_err") }), new Error("456"), "test1: test1_err."],
    [new Error("456"), new Errors({ test2: new Error("test2_err") }), "test2: test2_err."],
    [
      new Errors({ test1: new Error("test1_err") }),
      new Errors({ test2: new Error("test2_err") }),
      "test1: test1_err; test2: test2_err.",
    ],
  ];

  for (const [i, [errA, errB, expected]] of scenarios.entries()) {
    test(`${i}`, () => {
      const result = JoinValidationErrors(errA, errB);
      expect(result === null ? "<nil>" : result.message).toBe(expected);
    });
  }
});
