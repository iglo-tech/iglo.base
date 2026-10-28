// Patterns that upstream accepts whose programs chain tens of thousands of
// empty-width instructions at one input position. Go's NFA follows them
// with recursion on growing goroutine stacks; the matcher here must not
// overflow the fixed JS call stack on them.

import { describe, expect, test } from "bun:test";

import { compile, compilePOSIX } from "@/tools/regexp/regexp";

const nest = (open: string, inner: string, close: string, n: number) =>
  open.repeat(n) + inner + close.repeat(n);

describe("deep empty-width chains", () => {
  test("(?:a??){1000} thirty times, then b", () => {
    const pattern = "(?:a??){1000}".repeat(30) + "b";
    expect(pattern.length).toBe(391);
    const re = compile(pattern);
    expect(re.matchString("b")).toBe(true);
    expect(re.matchString("ab")).toBe(true);
    expect(re.matchString("c")).toBe(false);
    expect(re.findStringIndex("xaab")).toEqual([1, 4]);
  });

  test("(?:a?){1000} thirty times, then b", () => {
    const pattern = "(?:a?){1000}".repeat(30) + "b";
    const re = compile(pattern);
    expect(re.matchString("b")).toBe(true);
    expect(re.findStringIndex("xaab")).toEqual([1, 4]);
    // POSIX syntax has no (?:
    expect(compilePOSIX("(a?){1000}".repeat(30) + "b").findStringIndex("xaab")).toEqual([1, 4]);
  });

  test("captures are restored after each capture's chain", () => {
    // Every a?? prefers empty, so the one a goes to the last iteration of
    // the last group; each group reports its last iteration.
    const re = compile("(a??){1000}".repeat(30) + "b");
    const want = [0, 2, ...Array.from({ length: 29 }, () => [0, 0]).flat(), 0, 1];
    expect(re.findStringSubmatchIndex("ab")).toEqual(want);
    expect(re.findStringSubmatchIndex("c")).toBeNull();
  });

  test("lazy captures repeated, then b", () => {
    // the greedy {0,1000} takes one empty iteration of each group
    const re = compile("(a??){0,1000}".repeat(10) + "b");
    expect(re.matchString("b")).toBe(true);
    expect(re.findStringSubmatchIndex("b")).toEqual([0, 1, ...Array.from({ length: 20 }, () => 0)]);
  });

  test("the deepest nesting with a counted repetition inside", () => {
    // 990 groups around a{2,1000}, which Simplify turns into 998 nested
    // optional groups
    const re = compile(nest("(", "a{2,1000}", ")", 990));
    expect(re.matchString("a")).toBe(false);
    const m = re.findStringSubmatchIndex("a".repeat(1200)) as number[];
    expect(m.length).toBe(2 * 991);
    expect(m.slice(0, 4)).toEqual([0, 1000, 0, 1000]);
    expect(compile(nest("(?:", "a{0,1000}", ")", 990)).matchString("")).toBe(true);
  });

  test("the deepest nesting of stars and optional groups", () => {
    expect(compile(nest("(?:", "a", ")*", 999)).matchString("")).toBe(true);
    expect(compile(nest("(?:", "a", ")??", 999)).findStringIndex("a")).toEqual([0, 0]);
    expect(compile("(?:" + nest("(?:", "a", ")?", 998) + "){1000}").matchString("")).toBe(true);
  });
});
