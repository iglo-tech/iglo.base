// The error texts of fexpr's scanner and parser and of tools/search, which
// reach API error bodies. Upstream's own tests only check that an error
// occurs; the expected texts here follow the fmt.Errorf calls in fexpr
// v0.7.0 scanner.go and parser.go and in tools/search (filter.go,
// token_functions.go, simple_field_resolver.go, sort.go, provider.go),
// with Go's %q quoting.

import { describe, expect, test } from "bun:test";

import type { Clock } from "@/app/clock";
import { ErrEmpty, ErrIncomplete, parse } from "@/search/fexpr/parser";
import { ErrInvalidComment } from "@/search/fexpr/scanner";
import { filterBuildExpr, filterBuildExprWithLimit } from "@/search/filter";
import { ErrFilterExprLimit } from "@/search/provider";
import { newSimpleFieldResolver } from "@/search/simple-field-resolver";

const clock: Clock = { now: () => new Date(0) };

function errorOf(fn: () => unknown): Error | undefined {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  return undefined;
}

describe("fexpr errors", () => {
  // [filter, error text]
  const cases: [string, string][] = [
    ["a = 1 \r", `unexpected character '\\r'`],
    ["a = 1 $", `unexpected character '$'`],
    ["a = 1 ä", `unexpected character 'ä'`],
    ["a = 1 \u0001", `unexpected character '\\x01'`],
    ["a = 1  ", `unexpected character '\\u00a0'`],
    ["a = 1 \\", `unexpected character '\\\\'`],
    // an invalid UTF-8 byte (a lone surrogate in a Go string) is U+FFFD
    ["a = 1 \udc80", `unexpected character '�'`],
    ["a = -", `invalid number "-"`],
    ["a = 1.", `invalid number "1."`],
    ["a = 'x", `invalid quoted text "'x"`],
    ['a = "x\n', `invalid quoted text "\\"x\\n"`],
    ["a. = 1", `invalid identifier "a."`],
    ["@ = 1", `invalid identifier "@"`],
    ["a =! 1", `invalid sign operator "=!"`],
    ["a = 1 &&& b = 2", `invalid join operator "&&&"`],
    ["(a = 1", "invalid formatted group - missing 1 closing bracket(s)"],
    ["((a = 1)", "invalid formatted group - missing 1 closing bracket(s)"],
    ["(a = 'x)", `invalid quoted text "'x)"`],
    ["a.() = 1", `invalid function name "a."`],
    ["f(a,,b) = 1", `unexpected comma in function "f"`],
    ["f(a b) = 1", `expected comma after the last argument in function "f"`],
    ["f(a", `invalid or incomplete function "f" (expected ')')`],
    ["f(a = 1", `expected comma after the last argument in function "f"`],
    ["f(%) = 1", `unsupported argument character '%' in function "f"`],
    ["f(a /x) = 1", `failed to scan comment in function "f": invalid comment`],
    ["f(a.) = 1", `invalid identifier argument "a." in function "f": invalid identifier "a."`],
    ["f(1.) = 1", `invalid number argument "1." in function "f": invalid number "1."`],
    ["f('a) = 1", `invalid text argument "'a) = 1" in function "f": invalid quoted text "'a) = 1"`],
    [
      "a(b(c(d(1)))) = 1",
      `invalid identifier argument "b" in function "a": invalid identifier argument "c" in function "b": invalid identifier argument "d" in function "c": max nested function arguments reached (max: 3)`,
    ],
    ["a = / b", "invalid comment"],
    ["= 1", `expected left operand (identifier, function, text or number), got "=" (sign)`],
    ["1 1", `expected a sign operator, got "1" (number)`],
    ["a = &&", `expected right operand (identifier, function text or number), got "&&" (join)`],
    ["a = 1 b", `expected && or ||, got "b" (identifier)`],
    ["", "empty filter expression"],
    [" // comment", "empty filter expression"],
    ["()", "empty filter expression"],
    ["a =", "invalid or incomplete filter expression"],
    ["a = 1 &&", "invalid or incomplete filter expression"],
  ];

  for (const [filter, message] of cases) {
    test(JSON.stringify(filter), () => {
      expect(errorOf(() => parse(filter))?.message).toBe(message);
    });
  }

  test("sentinel errors", () => {
    expect(errorOf(() => parse(""))).toBe(ErrEmpty);
    expect(errorOf(() => parse("a = 1 ||"))).toBe(ErrIncomplete);
    expect(errorOf(() => parse("a = / b"))).toBe(ErrInvalidComment);
    expect(errorOf(() => parse("f(a /x) = 1"))?.cause).toBe(ErrInvalidComment);
  });

  test("NUL is Go's eof rune", () => {
    // read by Scan itself, it ends the input
    expect(errorOf(() => parse("a = 'x'\u0000 garbage"))).toBeUndefined();
    expect(errorOf(() => parse("(a = 1)\u0000 garbage"))).toBeUndefined();
    // read by a token scanner, it ends that token and is skipped
    expect(errorOf(() => parse("a = 1\u0000 garbage"))?.message).toBe(
      `expected && or ||, got "garbage" (identifier)`,
    );
  });
});

describe("filter errors", () => {
  const resolver = newSimpleFieldResolver("a");

  // [filter, error text]
  const cases: [string, string][] = [
    ["b = 1", `invalid left operand "b" - failed to resolve field "b"`],
    ["a = b", `invalid right operand "b" - failed to resolve field "b"`],
    ["foo() = 1", `invalid left operand "foo" - unknown function "foo"`],
    [
      "geoDistance(1,2,3) = 1",
      `invalid left operand "geoDistance" - [geoDistance] expected 4 arguments, got 3`,
    ],
    [
      "geoDistance(1,2,3,'x') = 1",
      `invalid left operand "geoDistance" - [geoDistance] argument 3 must be an identifier or number`,
    ],
    [
      "geoDistance(1,2,3,b) = 1",
      `invalid left operand "geoDistance" - [geoDistance] failed to resolve argument 3: failed to resolve field "b"`,
    ],
    [
      "1 = strftime()",
      `invalid right operand "strftime" - [strftime] expected at least 1 arguments, got 0`,
    ],
    [
      "strftime(1) = 1",
      `invalid left operand "strftime" - [strftime] expects the first argument to be a format string`,
    ],
    [
      "strftime('%Y', b) = 1",
      `invalid left operand "strftime" - [strftime] failed to resolve time-value argument: failed to resolve field "b"`,
    ],
    [
      "strftime('%Y', a, 1) = 1",
      `invalid left operand "strftime" - [strftime] invalid modifier argument 0 - can be only string`,
    ],
    [
      "strftime('%Y', a, '1', '2', '3', '4', '5', '6', '7', '8', '9') = 1",
      `invalid left operand "strftime" - [strftime] too many arguments (max allowed 10, got 11)`,
    ],
  ];

  for (const [filter, message] of cases) {
    test(filter, () => {
      expect(errorOf(() => filterBuildExpr(filter, resolver, { clock }))?.message).toBe(message);
    });
  }

  test("the expression limit", () => {
    expect(errorOf(() => filterBuildExprWithLimit("a = 1 || a = 2", resolver, 1, { clock }))).toBe(
      ErrFilterExprLimit,
    );
    expect(ErrFilterExprLimit.message).toBe("max filter expressions limit reached");
  });

  test("null, true and false need no field", () => {
    expect(
      errorOf(() => filterBuildExpr("NULL = TRUE || False != nuLL", resolver, { clock })),
    ).toBe(undefined);
  });

  test("a resolver result without an identifier and without an error", () => {
    const empty = { updateQuery: () => {}, resolve: () => ({ identifier: "" }) };
    // upstream reads the nil result's Identifier: a nil pointer panic, not an error
    expect(errorOf(() => filterBuildExpr("x = 1", empty, { clock }))?.message).toBe(
      "runtime error: invalid memory address or nil pointer dereference",
    );
    // null, true and false are still normalized
    expect(errorOf(() => filterBuildExpr("null = 1", empty, { clock }))).toBeUndefined();
  });
});
