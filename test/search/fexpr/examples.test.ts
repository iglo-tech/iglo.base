// Upstream: fexpr v0.7.0 examples_test.go (ExampleScanner_Scan, ExampleParse)

import { expect, test } from "bun:test";

import { parse } from "@/search/fexpr/parser";
import { newScanner, TokenEOF } from "@/search/fexpr/scanner";

import { printGroups, printToken } from "@test/search/fexpr/go-print";

test("Scanner.Scan example", () => {
  const s = newScanner("id > 123");
  const out: string[] = [];

  for (;;) {
    const [t, err] = s.scan();
    if (t.type === TokenEOF || err !== undefined) {
      break;
    }

    out.push(printToken(t));
  }

  expect(out).toEqual([
    "{<nil> identifier id}",
    "{<nil> whitespace  }",
    "{<nil> sign >}",
    "{<nil> whitespace  }",
    "{<nil> number 123}",
  ]);
});

test("Parse example", () => {
  expect(printGroups(parse("id > 123"))).toBe(
    "[{{{<nil> identifier id} > {<nil> number 123}} &&}]",
  );
});
