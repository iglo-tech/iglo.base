// Matching runs in time linear in the input, as Go's NFA does: patterns
// that take exponential time in a backtracking engine (JS RegExp included)
// against inputs that fail at the end.
//
// Each input size is measured over at least 100 ms of repeated runs, and
// the time per input byte of the 3,000-character input is compared with
// that of the 30-character input. Linear time gives a ratio near 1;
// the bound is generous (5) so that a loaded machine does not fail it,
// while quadratic time would give about 100 and backtracking would not
// finish.

import { describe, expect, test } from "bun:test";

import { compile } from "@/tools/regexp/regexp";

// ms per byte of s, over at least 100 ms
function perByte(run: () => void, bytes: number): number {
  run();
  let n = 0;
  const start = performance.now();
  let now = start;
  while (now - start < 100) {
    run();
    n++;
    now = performance.now();
  }
  return (now - start) / n / bytes;
}

const cases: [string, (n: number) => string][] = [
  ["(a+)+$", (n) => "a".repeat(n - 1) + "b"],
  ["(a|aa)*b", (n) => "a".repeat(n)],
  ["(x+x+)+y", (n) => "x".repeat(n)],
  ["^(a|a?)+$", (n) => "a".repeat(n - 1) + "b"],
];

describe("linear time", () => {
  test.each(cases)("%s", (pattern, input) => {
    const re = compile(pattern);
    const small = input(30);
    const large = input(3000);
    expect(re.matchString(large)).toBe(false);
    expect(re.findStringSubmatchIndex(large)).toBeNull();

    const run = (s: string) => () => {
      re.matchString(s);
      re.findStringSubmatchIndex(s);
    };
    const smallPerByte = perByte(run(small), small.length);
    const largePerByte = perByte(run(large), large.length);
    expect(largePerByte / smallPerByte).toBeLessThan(5);
  });
});
