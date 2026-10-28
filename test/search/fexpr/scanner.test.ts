// Upstream: fexpr v0.7.0 scanner_test.go (TestNewScanner, TestScannerScan)

import { describe, expect, test } from "bun:test";

import { newScanner, TokenEOF } from "@/search/fexpr/scanner";

import { printToken } from "@test/search/fexpr/go-print";

// [text, [[expect error, %v of the token], ...]]
const testScenarios: [string, [boolean, string][]][] = [
  // whitespace
  ["   ", [[false, "{<nil> whitespace    }"]]],
  [
    "test 123",
    [
      [false, "{<nil> identifier test}"],
      [false, "{<nil> whitespace  }"],
      [false, "{<nil> number 123}"],
    ],
  ],
  // identifier
  ["test", [[false, "{<nil> identifier test}"]]],
  ["@", [[true, "{<nil> identifier @}"]]],
  ["test:", [[true, "{<nil> identifier test:}"]]],
  ["test.", [[true, "{<nil> identifier test.}"]]],
  ["@test.123:c", [[false, "{<nil> identifier @test.123:c}"]]],
  ["_test_a.123", [[false, "{<nil> identifier _test_a.123}"]]],
  ["#test.123:456", [[false, "{<nil> identifier #test.123:456}"]]],
  [
    ".test.123",
    [
      [true, "{<nil> unexpected .}"],
      [false, "{<nil> identifier test.123}"],
    ],
  ],
  [
    ":test.123",
    [
      [true, "{<nil> unexpected :}"],
      [false, "{<nil> identifier test.123}"],
    ],
  ],
  [
    "test#@",
    [
      [false, "{<nil> identifier test}"],
      [true, "{<nil> identifier #}"],
      [true, "{<nil> identifier @}"],
    ],
  ],
  [
    "test'",
    [
      [false, "{<nil> identifier test}"],
      [true, "{<nil> text '}"],
    ],
  ],
  [
    'test"d',
    [
      [false, "{<nil> identifier test}"],
      [true, '{<nil> text "d}'],
    ],
  ],
  // number
  ["123", [[false, "{<nil> number 123}"]]],
  ["-123", [[false, "{<nil> number -123}"]]],
  ["-123.456", [[false, "{<nil> number -123.456}"]]],
  ["123.456", [[false, "{<nil> number 123.456}"]]],
  [
    "12.34.56",
    [
      [false, "{<nil> number 12.34}"],
      [true, "{<nil> unexpected .}"],
      [false, "{<nil> number 56}"],
    ],
  ],
  [
    ".123",
    [
      [true, "{<nil> unexpected .}"],
      [false, "{<nil> number 123}"],
    ],
  ],
  [
    "- 123",
    [
      [true, "{<nil> number -}"],
      [false, "{<nil> whitespace  }"],
      [false, "{<nil> number 123}"],
    ],
  ],
  [
    "12-3",
    [
      [false, "{<nil> number 12}"],
      [false, "{<nil> number -3}"],
    ],
  ],
  [
    "123.abc",
    [
      [true, "{<nil> number 123.}"],
      [false, "{<nil> identifier abc}"],
    ],
  ],
  // text
  ['""', [[false, "{<nil> text }"]]],
  ["''", [[false, "{<nil> text }"]]],
  ["'test'", [[false, "{<nil> text test}"]]],
  ["'te\\'st'", [[false, "{<nil> text te'st}"]]],
  ['"te\\"st"', [[false, '{<nil> text te"st}']]],
  ['"tes@#,;!@#%^\'\\"t"', [[false, "{<nil> text tes@#,;!@#%^'\"t}"]]],
  ["'tes@#,;!@#%^\\'\"t'", [[false, "{<nil> text tes@#,;!@#%^'\"t}"]]],
  ['"test', [[true, '{<nil> text "test}']]],
  ["'test", [[true, "{<nil> text 'test}"]]],
  ["'АБЦ", [[true, "{<nil> text 'АБЦ}"]]],
  // join types
  ["&&||", [[true, "{<nil> join &&||}"]]],
  [
    "&& ||",
    [
      [false, "{<nil> join &&}"],
      [false, "{<nil> whitespace  }"],
      [false, "{<nil> join ||}"],
    ],
  ],
  [
    "'||test&&'&&123",
    [
      [false, "{<nil> text ||test&&}"],
      [false, "{<nil> join &&}"],
      [false, "{<nil> number 123}"],
    ],
  ],
  // expression signs
  ["=!=", [[true, "{<nil> sign =!=}"]]],
  [
    "= != ~ !~ > >= < <= ?= ?!= ?~ ?!~ ?> ?>= ?< ?<=",
    [
      [false, "{<nil> sign =}"],
      [false, "{<nil> whitespace  }"],
      [false, "{<nil> sign !=}"],
      [false, "{<nil> whitespace  }"],
      [false, "{<nil> sign ~}"],
      [false, "{<nil> whitespace  }"],
      [false, "{<nil> sign !~}"],
      [false, "{<nil> whitespace  }"],
      [false, "{<nil> sign >}"],
      [false, "{<nil> whitespace  }"],
      [false, "{<nil> sign >=}"],
      [false, "{<nil> whitespace  }"],
      [false, "{<nil> sign <}"],
      [false, "{<nil> whitespace  }"],
      [false, "{<nil> sign <=}"],
      [false, "{<nil> whitespace  }"],
      [false, "{<nil> sign ?=}"],
      [false, "{<nil> whitespace  }"],
      [false, "{<nil> sign ?!=}"],
      [false, "{<nil> whitespace  }"],
      [false, "{<nil> sign ?~}"],
      [false, "{<nil> whitespace  }"],
      [false, "{<nil> sign ?!~}"],
      [false, "{<nil> whitespace  }"],
      [false, "{<nil> sign ?>}"],
      [false, "{<nil> whitespace  }"],
      [false, "{<nil> sign ?>=}"],
      [false, "{<nil> whitespace  }"],
      [false, "{<nil> sign ?<}"],
      [false, "{<nil> whitespace  }"],
      [false, "{<nil> sign ?<=}"],
    ],
  ],
  // comments
  [
    "/ test",
    [
      [true, "{<nil> comment }"],
      [false, "{<nil> identifier test}"],
    ],
  ],
  [
    "/ / test",
    [
      [true, "{<nil> comment }"],
      [true, "{<nil> comment }"],
      [false, "{<nil> identifier test}"],
    ],
  ],
  ["//", [[false, "{<nil> comment }"]]],
  ["//test", [[false, "{<nil> comment test}"]]],
  ["// test", [[false, "{<nil> comment test}"]]],
  ["//   test1 //test2  ", [[false, "{<nil> comment test1 //test2}"]]],
  ["///test", [[false, "{<nil> comment /test}"]]],
  // funcs
  ["test()", [[false, "{[] function test}"]]],
  ["test(a, b", [[true, "{[{<nil> identifier a} {<nil> identifier b}] function test}"]]],
  ["@test:abc()", [[false, "{[] function @test:abc}"]]],
  ["test(  a  )", [[false, "{[{<nil> identifier a}] function test}"]]], // with whitespaces
  ["test(a, b)", [[false, "{[{<nil> identifier a} {<nil> identifier b}] function test}"]]],
  ["test(a, b,  )", [[false, "{[{<nil> identifier a} {<nil> identifier b}] function test}"]]], // single trailing comma
  [
    "test(a,,)",
    [
      [true, "{[{<nil> identifier a}] function test}"],
      [true, "{<nil> unexpected )}"],
    ],
  ], // unexpected trailing commas
  [
    "test(a,,,b)",
    [
      [true, "{[{<nil> identifier a}] function test}"],
      [true, "{<nil> unexpected ,}"],
      [false, "{<nil> identifier b}"],
      [true, "{<nil> unexpected )}"],
    ],
  ], // unexpected mid-args commas
  [
    "test(   @test.a.b:test  , 123, \"ab)c\", 'd,ce', false)",
    [
      [
        false,
        "{[{<nil> identifier @test.a.b:test} {<nil> number 123} {<nil> text ab)c} {<nil> text d,ce} {<nil> identifier false}] function test}",
      ],
    ],
  ],
  ["test(a //test)", [[true, "{[{<nil> identifier a}] function test}"]]], // invalid simple comment
  ["test(a //test\n)", [[false, "{[{<nil> identifier a}] function test}"]]], // valid simple comment
  [
    "test(a, //test\n, b)",
    [
      [true, "{[{<nil> identifier a}] function test}"],
      [false, "{<nil> whitespace  }"],
      [false, "{<nil> identifier b}"],
      [true, "{<nil> unexpected )}"],
    ],
  ],
  ["test(a, //test\n b)", [[false, "{[{<nil> identifier a} {<nil> identifier b}] function test}"]]],
  [
    "test(a, test(test(b), c), d)",
    [
      [
        false,
        "{[{<nil> identifier a} {[{[{<nil> identifier b}] function test} {<nil> identifier c}] function test} {<nil> identifier d}] function test}",
      ],
    ],
  ],
  // max funcs depth
  ["a(b(c(1)))", [[false, "{[{[{[{<nil> number 1}] function c}] function b}] function a}"]]],
  [
    "a(b(c(d(1))))",
    [
      [true, "{[] function a}"],
      [false, "{<nil> number 1}"],
      [true, "{<nil> unexpected )}"],
      [true, "{<nil> unexpected )}"],
      [true, "{<nil> unexpected )}"],
      [true, "{<nil> unexpected )}"],
    ],
  ],
  // groups/parenthesis
  [
    "a)",
    [
      [false, "{<nil> identifier a}"],
      [true, "{<nil> unexpected )}"],
    ],
  ],
  ["(a b c", [[true, "{<nil> group a b c}"]]],
  ["(a b c)", [[false, "{<nil> group a b c}"]]],
  ["((a b c))", [[false, "{<nil> group (a b c)}"]]],
  [
    "((a )b c))",
    [
      [false, "{<nil> group (a )b c}"],
      [true, "{<nil> unexpected )}"],
    ],
  ],
  ['("ab)("c)', [[false, '{<nil> group "ab)("c}']]],
  ['("ab)(c)', [[true, '{<nil> group "ab)(c)}']]],
  ["( func(1, 2, 3, func(4)) a b c )", [[false, "{<nil> group  func(1, 2, 3, func(4)) a b c }"]]],
];

test("NewScanner", () => {
  // the scanner reads the given data
  const [t] = newScanner("test").scan();
  expect(printToken(t)).toBe("{<nil> identifier test}");
});

describe("Scanner.Scan", () => {
  for (const [text, expects] of testScenarios) {
    test(JSON.stringify(text), () => {
      const s = newScanner(text);

      // scan the text tokens
      for (const [j, [expectError, expectPrint]] of expects.entries()) {
        const [token, err] = s.scan();
        expect([j, err !== undefined, printToken(token)]).toEqual([j, expectError, expectPrint]);
      }

      // the last remaining token should be the eof
      const [lastToken, err] = s.scan();
      expect(err).toBeUndefined();
      expect(lastToken.type).toBe(TokenEOF);
    });
  }
});
