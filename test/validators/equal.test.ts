// Upstream: core/validators/equal_test.go
//
// Go's pointers are their values here: &strA, &strB and the nil *string
// rows become the string or null itself.

import { expect, test } from "bun:test";

import { Equal } from "@/validators/equal";

test("Equal", () => {
  const strA = "abc";
  const strB = "abc";
  const strC = "123";
  const strNilPtr = null;
  const strNilPtr2 = null;

  const scenarios: [valA: unknown, valB: unknown, expectError: boolean][] = [
    [null, null, false],
    ["", "", false],
    ["", "456", true],
    ["123", "", true],
    ["123", "456", true],
    ["123", "123", false],
    [true, false, true],
    [false, true, true],
    [false, false, false],
    [true, true, false],
    [0, 0, false],
    [0, 1, true],
    [1, 2, true],
    [1, 1, false],
    [strA, strA, false],
    [strA, strB, false],
    [strA, strC, true],
    ["abc", strA, false],
    [strA, "abc", false],
    ["abc", strC, true],
    ["test", 123, true],
    [null, 123, true],
    [null, strA, true],
    [null, strA, true],
    [null, strNilPtr, false],
    [strNilPtr, strNilPtr2, false],
  ];

  for (const [i, [valA, valB, expectError]] of scenarios.entries()) {
    const err = Equal(valA)(valB);
    expect(err !== null, `${i}_${String(valA)}_${String(valB)}`).toBe(expectError);
  }
});

test("Equal error", () => {
  const err = Equal("a")("b") as Error & { code(): string };
  expect(err.code()).toBe("validation_values_mismatch");
  expect(err.message).toBe("Values don't match.");
});
