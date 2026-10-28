// Upstream: Go go1.27.2 src/regexp/all_test.go.
//
// Ported: TestGoodCompile, TestBadCompile, TestReplaceAll (string form),
// TestReplaceAllLiteral, TestReplaceAllFunc, TestQuoteMeta,
// TestLiteralPrefix, TestSubexp, TestSplit, TestParseAndCompile,
// TestOnePassCutoff (through LiteralPrefix, see below) and
// TestSwitchBacktrack. Left out: TestCopyMatch (no Copy), TestDeepEqual
// (reflect.DeepEqual of Go structs), TestMinInputLen (an unexported
// optimization with no observable effect) and TestUnmarshalText (no text
// marshaling). The findTests-driven tests are in find.test.ts.

import { describe, expect, test } from "bun:test";

import { compile, mustCompile, quoteMeta } from "@/tools/regexp/regexp";
import { OneLine, Parse, Perl, RegexpSyntaxError } from "@/tools/regexp/syntax/parse";

import {
  badRe,
  goodRe,
  literalPrefixTests,
  metaTests,
  replaceLiteralTests,
  replaceTests,
  splitTests,
  subexpCases,
} from "@test/tools/regexp/all-tests";

describe("Compile", () => {
  test.each(goodRe)("good %p", (expr) => {
    expect(() => compile(expr)).not.toThrow();
  });

  test.each(badRe.map((t) => [t.re.slice(0, 40), t] as const))("bad %p", (_, { re, err }) => {
    let error: unknown;
    try {
      compile(re);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(RegexpSyntaxError);
    expect((error as Error).message).toContain(err);
  });

  test("MustCompile", () => {
    expect(() => mustCompile("a(")).toThrow(
      "regexp: Compile(`a(`): error parsing regexp: missing closing ): `a(`",
    );
    expect(() => mustCompile("`(")).toThrow(
      'regexp: Compile("`("): error parsing regexp: missing closing ): ``(`',
    );
  });
});

describe("ReplaceAll", () => {
  test.each(replaceTests)("%j", (tc) => {
    const re = compile(tc.pattern);
    expect(re.replaceAllString(tc.input, tc.replacement)).toBe(tc.output);
  });
});

describe("ReplaceAllLiteral", () => {
  // Run ReplaceAll tests that do not have $ expansions, then the
  // literal-specific tests.
  const cases = [
    ...replaceTests.filter((tc) => !tc.replacement.includes("$")),
    ...replaceLiteralTests,
  ];
  test.each(cases)("%j", (tc) => {
    const re = compile(tc.pattern);
    expect(re.replaceAllLiteralString(tc.input, tc.replacement)).toBe(tc.output);
  });
});

describe("ReplaceAllFunc", () => {
  const replaceFuncTests: [string, (s: string) => string, string, string][] = [
    ["[a-c]", (s) => "x" + s + "y", "defabcdef", "defxayxbyxcydef"],
    ["[a-c]+", (s) => "x" + s + "y", "defabcdef", "defxabcydef"],
    ["[a-c]*", (s) => "x" + s + "y", "defabcdef", "xydxyexyfxabcydxyexyfxy"],
  ];
  test.each(replaceFuncTests)("%p", (pattern, replacement, input, output) => {
    expect(compile(pattern).replaceAllStringFunc(input, replacement)).toBe(output);
  });
});

describe("QuoteMeta", () => {
  test.each(metaTests)("%j", (tc) => {
    // Verify that QuoteMeta returns the expected string.
    const quoted = quoteMeta(tc.pattern);
    expect(quoted).toBe(tc.output);

    // Verify that the quoted string is in fact treated as expected
    // by Compile -- i.e. that it matches the original, unquoted string.
    if (tc.pattern !== "") {
      const re = compile(quoted);
      const src = "abc" + tc.pattern + "def";
      expect(re.replaceAllString(src, "xyz")).toBe("abcxyzdef");
    }
  });
});

describe("LiteralPrefix", () => {
  test.each([...metaTests, ...literalPrefixTests])("%j", (tc) => {
    // Literal method needs to scan the pattern.
    const re = mustCompile(tc.pattern);
    expect(re.literalPrefix()).toEqual([tc.literal, tc.isLiteral]);
  });

  // TestOnePassCutoff: a program this long is not one-pass. A one-pass
  // program's prefix skips the leading \A (onePassPrefix), so this
  // pattern's prefix would be "x".
  test("OnePassCutoff", () => {
    expect(mustCompile("^x{1,1000}y{1,1000}$").literalPrefix()).toEqual(["", false]);
    expect(mustCompile("^x{1,10}y{1,10}$").literalPrefix()).toEqual(["x", false]);
  });
});

describe("Subexp", () => {
  test.each(subexpCases)("%j", (c) => {
    const re = mustCompile(c.input);
    const n = re.numSubexp();
    expect(n).toBe(c.num);
    const names = re.subexpNames();
    expect(names.length).toBe(1 + n);
    if (c.names !== null) {
      expect(names).toEqual(c.names);
    }
    for (const subexp of c.indices) {
      expect(re.subexpIndex(subexp.name)).toBe(subexp.index);
    }
  });
});

describe("Split", () => {
  test.each(splitTests)("%j", (tc) => {
    const re = compile(tc.r);
    const split = re.split(tc.s, tc.n);
    expect(split).toEqual(tc.out);

    if (quoteMeta(tc.r) === tc.r) {
      // strings.SplitN
      expect(split).toEqual(splitN(tc.s, tc.r, tc.n));
    }
  });
});

// strings.SplitN for the inputs of splitTests
function splitN(s: string, sep: string, n: number): string[] | null {
  if (n === 0) {
    return null;
  }
  if (sep === "") {
    const chars = [...s];
    if (n < 0 || n > chars.length) {
      return chars;
    }
    return [...chars.slice(0, n - 1), chars.slice(n - 1).join("")];
  }
  const parts = s.split(sep);
  if (n < 0 || parts.length <= n) {
    return parts;
  }
  return [...parts.slice(0, n - 1), parts.slice(n - 1).join(sep)];
}

// The following sequence of Match calls used to panic. See issue #12980.
test("ParseAndCompile", () => {
  const expr = "a$";
  const s = "a\nb";
  for (const [reFlags, expMatch] of [
    [Perl | OneLine, false],
    [Perl & ~OneLine, true],
  ] as const) {
    const parsed = Parse(expr, reFlags);
    const re = compile(parsed.toString());
    expect(re.matchString(s)).toBe(expMatch);
  }
});

// Check that the same machine can be used with the standard matcher
// and then the backtracker when there are no captures. (Go's backtracker
// is not ported; the sequence used to panic in Go, see issue #10319.)
test("SwitchBacktrack", () => {
  const re = mustCompile("a|b");
  const long = new Uint8Array(256 * 1024 + 1);
  expect(re.match(long)).toBe(false);
  expect(re.match(long.subarray(0, 1))).toBe(false);
});
