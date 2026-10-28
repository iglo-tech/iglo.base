// Upstream: fexpr v0.7.0 parser_test.go (TestExprIzZero, TestParse)

import { describe, expect, test } from "bun:test";

import { type Expr, exprIsZero, type ExprGroup, parse } from "@/search/fexpr/parser";
import { SignAnyEq, type Token, TokenWS } from "@/search/fexpr/scanner";

import { printGroups } from "@test/search/fexpr/go-print";

function tok(t: Partial<Token>): Token {
  return { meta: null, type: "", literal: "", ...t };
}

function expr(e: Partial<Expr>): Expr {
  return { left: tok({}), op: "", right: tok({}), ...e };
}

test("Expr.IsZero", () => {
  const scenarios: [Expr, boolean][] = [
    [expr({}), true],
    [expr({ op: SignAnyEq }), false],
    [expr({ left: tok({ literal: "123" }) }), false],
    [expr({ left: tok({ type: TokenWS }) }), false],
    [expr({ right: tok({ literal: "123" }) }), false],
    [expr({ right: tok({ type: TokenWS }) }), false],
  ];
  for (const [i, [e, result]] of scenarios.entries()) {
    expect([i, exprIsZero(e)]).toEqual([i, result]);
  }
});

// [input, expected error, %v of the result]
const scenarios: [string, boolean, string][] = [
  ["> 1", true, "[]"],
  ["a >", true, "[]"],
  ["a > >", true, "[]"],
  ["a > %", true, "[]"],
  ["a ! 1", true, "[]"],
  ["a - 1", true, "[]"],
  ["a + 1", true, "[]"],
  ["1 - 1", true, "[]"],
  ["1 + 1", true, "[]"],
  ["> a 1", true, "[]"],
  ["a || 1", true, "[]"],
  ["a && 1", true, "[]"],
  ["test > 1 &&", true, "[]"],
  ["|| test = 1", true, "[]"],
  ["test = 1 && ||", true, "[]"],
  ["test = 1 && a", true, "[]"],
  ["test = 1 && a", true, "[]"],
  ['test = 1 && "a"', true, "[]"],
  ["test = 1 a", true, "[]"],
  ["test = 1 a", true, "[]"],
  ['test = 1 "a"', true, "[]"],
  ["test = 1@test", true, "[]"],
  ["test = .@test", true, "[]"],
  // mismatched text quotes
  ["test = \"demo'", true, "[]"],
  ["test = 'demo\"", true, "[]"],
  ["test = 'demo'\"", true, "[]"],
  ["test = 'demo''", true, "[]"],
  ['test = "demo"\'', true, "[]"],
  ['test = "demo""', true, "[]"],
  ['test = ""demo""', true, "[]"],
  ["test = ''demo''", true, "[]"],
  ["test = `demo`", true, "[]"],
  // control and esc chars
  ["demo='a\\b\\c\\d'", false, "[{{{<nil> identifier demo} = {<nil> text a\\b\\c\\d}} &&}]"],
  ["demo='a\\n'", false, "[{{{<nil> identifier demo} = {<nil> text a\n}} &&}]"],
  ["demo='a\\r'", false, "[{{{<nil> identifier demo} = {<nil> text a\r}} &&}]"],
  ["demo='a\\t'", false, "[{{{<nil> identifier demo} = {<nil> text a\t}} &&}]"],
  ["demo='a\\r\\n'", false, "[{{{<nil> identifier demo} = {<nil> text a\r\n}} &&}]"],
  ["demo='a\\nb'", false, "[{{{<nil> identifier demo} = {<nil> text a\nb}} &&}]"],
  ["demo='a\\tb'", false, "[{{{<nil> identifier demo} = {<nil> text a\tb}} &&}]"],
  ["demo='te\\'st'", false, "[{{{<nil> identifier demo} = {<nil> text te'st}} &&}]"],
  ["(demo='te\\'st')", false, "[{[{{{<nil> identifier demo} = {<nil> text te'st}} &&}] &&}]"],
  ["demo='te\\\\'st'", true, "[]"],
  ["(demo='te\\\\'st')", true, "[]"],
  ['demo="te\\"st"', false, '[{{{<nil> identifier demo} = {<nil> text te"st}} &&}]'],
  ['(demo="te\\"st")', false, '[{[{{{<nil> identifier demo} = {<nil> text te"st}} &&}] &&}]'],
  ['demo="te\\\\\\"st"', false, '[{{{<nil> identifier demo} = {<nil> text te\\"st}} &&}]'],
  ['demo="te\\\\"st"', true, "[]"],
  ['demo="te\\\\\\\\"st"', true, "[]"],
  ['(demo="te\\\\"st")', true, "[]"],
  ['demo="te\\\'st"', false, "[{{{<nil> identifier demo} = {<nil> text te'st}} &&}]"],
  ['(demo="te\\\'st")', false, "[{[{{{<nil> identifier demo} = {<nil> text te'st}} &&}] &&}]"],
  ['demo="te\\\\\'st"', false, "[{{{<nil> identifier demo} = {<nil> text te\\'st}} &&}]"],
  ['(demo="te\\\\\'st")', false, "[{[{{{<nil> identifier demo} = {<nil> text te\\'st}} &&}] &&}]"],
  ['demo="te\\\\\\\'st"', false, "[{{{<nil> identifier demo} = {<nil> text te\\'st}} &&}]"],
  ["demo = 'a\\\\'", false, "[{{{<nil> identifier demo} = {<nil> text a\\}} &&}]"],
  ["(demo = 'a\\\\')", false, "[{[{{{<nil> identifier demo} = {<nil> text a\\}} &&}] &&}]"],
  ["demo = 'a\\'\\\\'", false, "[{{{<nil> identifier demo} = {<nil> text a'\\}} &&}]"],
  ["demo1 = 'a\\' && demo2 = 2", true, "[]"],
  ["(demo1 = 'a\\' && demo2 = 2)", true, "[]"],
  [
    "demo1 = 'a\\\\' && demo2 = 2",
    false,
    "[{{{<nil> identifier demo1} = {<nil> text a\\}} &&} {{{<nil> identifier demo2} = {<nil> number 2}} &&}]",
  ],
  [
    "(demo1 = 'a\\\\' && demo2 = 2)",
    false,
    "[{[{{{<nil> identifier demo1} = {<nil> text a\\}} &&} {{{<nil> identifier demo2} = {<nil> number 2}} &&}] &&}]",
  ],
  [
    "demo1 = 'a\\\\\\\\' && demo2 = 2",
    false,
    "[{{{<nil> identifier demo1} = {<nil> text a\\\\}} &&} {{{<nil> identifier demo2} = {<nil> number 2}} &&}]",
  ],
  [
    "(demo1 = 'a\\\\\\\\' && demo2 = 2)",
    false,
    "[{[{{{<nil> identifier demo1} = {<nil> text a\\\\}} &&} {{{<nil> identifier demo2} = {<nil> number 2}} &&}] &&}]",
  ],
  // comments
  ["test = / demo", true, "[]"],
  ["test = // demo", true, "[]"],
  ["// demo", true, "[]"],
  [
    "test = 123 // demo (1, 2, 3, '')",
    false,
    "[{{{<nil> identifier test} = {<nil> number 123}} &&}]",
  ],
  [
    "// demo (1, 2, 3, '')\ntest = 123",
    false,
    "[{{{<nil> identifier test} = {<nil> number 123}} &&}]",
  ],
  ["test = // demo\n123", false, "[{{{<nil> identifier test} = {<nil> number 123}} &&}]"],
  [
    "\n\t\t\ta = 123 &&\n\t\t\t// demo\n\t\t\tb = 456\n\t\t",
    false,
    "[{{{<nil> identifier a} = {<nil> number 123}} &&} {{{<nil> identifier b} = {<nil> number 456}} &&}]",
  ],
  // functions
  ["test() = 12", false, "[{{{[] function test} = {<nil> number 12}} &&}]"],
  [
    "(a.b.c(1) = d.e.f(2)) || 1=2",
    false,
    "[{[{{{[{<nil> number 1}] function a.b.c} = {[{<nil> number 2}] function d.e.f}} &&}] &&} {{{<nil> number 1} = {<nil> number 2}} ||}]",
  ],
  // valid simple expression and sign operators check
  ["1=12", false, "[{{{<nil> number 1} = {<nil> number 12}} &&}]"],
  ["   1    =    12    ", false, "[{{{<nil> number 1} = {<nil> number 12}} &&}]"],
  ['"demo" != test', false, "[{{{<nil> text demo} != {<nil> identifier test}} &&}]"],
  ["a~1", false, "[{{{<nil> identifier a} ~ {<nil> number 1}} &&}]"],
  ["a !~ 1", false, "[{{{<nil> identifier a} !~ {<nil> number 1}} &&}]"],
  ["test>12", false, "[{{{<nil> identifier test} > {<nil> number 12}} &&}]"],
  ["test > 12", false, "[{{{<nil> identifier test} > {<nil> number 12}} &&}]"],
  ['test >="test"', false, "[{{{<nil> identifier test} >= {<nil> text test}} &&}]"],
  ["test<@demo.test2", false, "[{{{<nil> identifier test} < {<nil> identifier @demo.test2}} &&}]"],
  ['1<="test"', false, "[{{{<nil> number 1} <= {<nil> text test}} &&}]"],
  ['1<="te\'st"', false, "[{{{<nil> number 1} <= {<nil> text te'st}} &&}]"],
  // invalid parenthesis
  ["(a=1", true, "[]"],
  ["a=1)", true, "[]"],
  ["((a=1)", true, "[]"],
  ["{a=1}", true, "[]"],
  ["[a=1]", true, "[]"],
  ["((a=1 || a=2) && c=1))", true, "[]"],
  // valid parenthesis
  ["()", true, "[]"],
  ["(a=1)", false, "[{[{{{<nil> identifier a} = {<nil> number 1}} &&}] &&}]"],
  ['(a="test(")', false, "[{[{{{<nil> identifier a} = {<nil> text test(}} &&}] &&}]"],
  ['(a="test)")', false, "[{[{{{<nil> identifier a} = {<nil> text test)}} &&}] &&}]"],
  ["((a=1))", false, "[{[{[{{{<nil> identifier a} = {<nil> number 1}} &&}] &&}] &&}]"],
  [
    "a=1 || 2!=3",
    false,
    "[{{{<nil> identifier a} = {<nil> number 1}} &&} {{{<nil> number 2} != {<nil> number 3}} ||}]",
  ],
  [
    "a=1 && 2!=3",
    false,
    "[{{{<nil> identifier a} = {<nil> number 1}} &&} {{{<nil> number 2} != {<nil> number 3}} &&}]",
  ],
  [
    'a=1 && 2!=3 || "b"=a',
    false,
    "[{{{<nil> identifier a} = {<nil> number 1}} &&} {{{<nil> number 2} != {<nil> number 3}} &&} {{{<nil> text b} = {<nil> identifier a}} ||}]",
  ],
  [
    '(a=1 && 2!=3) || "b"=a',
    false,
    "[{[{{{<nil> identifier a} = {<nil> number 1}} &&} {{{<nil> number 2} != {<nil> number 3}} &&}] &&} {{{<nil> text b} = {<nil> identifier a}} ||}]",
  ],
  [
    "((a=1 || a=2) && (c=1))",
    false,
    "[{[{[{{{<nil> identifier a} = {<nil> number 1}} &&} {{{<nil> identifier a} = {<nil> number 2}} ||}] &&} {[{{{<nil> identifier c} = {<nil> number 1}} &&}] &&}] &&}]",
  ],
  // https://github.com/pocketbase/pocketbase/issues/5017
  ["(a='\"')", false, '[{[{{{<nil> identifier a} = {<nil> text "}} &&}] &&}]'],
  ["(a='\\'')", false, "[{[{{{<nil> identifier a} = {<nil> text '}} &&}] &&}]"],
  ['(a="\'")', false, "[{[{{{<nil> identifier a} = {<nil> text '}} &&}] &&}]"],
  ['(a="\\"")', false, '[{[{{{<nil> identifier a} = {<nil> text "}} &&}] &&}]'],
];

describe("Parse", () => {
  for (const [i, [input, expectedError, expectedPrint]] of scenarios.entries()) {
    test(`s${i}:${input}`, () => {
      let v: ExprGroup[] | null = null;
      let err: unknown;
      try {
        v = parse(input);
      } catch (e) {
        err = e;
      }
      expect(err !== undefined).toBe(expectedError);
      expect(printGroups(v)).toBe(expectedPrint);
    });
  }
});
