// Go's Error() text, numeric Op and Flags values, and tree details of
// src/tools/regexp/syntax beyond parse_test.go's tables.
//
// The Perl error texts are the ones test/differential/regexp-syntax.test.ts
// checks against the upstream binary; the POSIX and invalid UTF-8 cases
// cannot reach upstream through its API (it always parses with Perl flags,
// and its JSON decoder turns invalid UTF-8 into U+FFFD), so they follow
// parse.go's code paths.

import { describe, expect, test } from "bun:test";

import { textToBytes } from "@/tools/types/go-json";
import {
  ClassNL,
  DotNL,
  FoldCase,
  Literal,
  MatchNL,
  NonGreedy,
  OneLine,
  POSIX,
  Parse,
  Perl,
  PerlX,
  RegexpSyntaxError,
  Simple,
  UnicodeGroups,
  WasDollar,
} from "@/tools/regexp/syntax/parse";
import {
  OpAlternate,
  OpCapture,
  OpCharClass,
  OpConcat,
  OpEmptyMatch,
  OpLiteral,
  OpNoMatch,
  OpRepeat,
  OpStar,
  opString,
  type Regexp,
} from "@/tools/regexp/syntax/regexp";

function parseError(pattern: string | Uint8Array, flags: number): RegexpSyntaxError {
  try {
    Parse(pattern, flags);
  } catch (error) {
    expect(error).toBeInstanceOf(RegexpSyntaxError);
    return error as RegexpSyntaxError;
  }
  throw new Error(`${JSON.stringify(pattern)} parsed`);
}

const perlErrors: [pattern: string, message: string][] = [
  ["(abc", "error parsing regexp: missing closing ): `(abc`"],
  ["abc)", "error parsing regexp: unexpected ): `abc)`"],
  ["x[a-z", "error parsing regexp: missing closing ]: `[a-z`"],
  ["*", "error parsing regexp: missing argument to repetition operator: `*`"],
  ["\\Q\\E*", "error parsing regexp: missing argument to repetition operator: `*`"],
  ["a**", "error parsing regexp: invalid nested repetition operator: `**`"],
  ["x{2}{3}", "error parsing regexp: invalid nested repetition operator: `{2}{3}`"],
  ["x{1001}", "error parsing regexp: invalid repeat count: `{1001}`"],
  ["x{2,1}", "error parsing regexp: invalid repeat count: `{2,1}`"],
  ["((a{100}){100})", "error parsing regexp: invalid repeat count: `{100}`"],
  ["\\8", "error parsing regexp: invalid escape sequence: `\\8`"],
  ["\\xZZ", "error parsing regexp: invalid escape sequence: `\\xZZ`"],
  ["\\x{110000}", "error parsing regexp: invalid escape sequence: `\\x{110000`"],
  ["abc\\", "error parsing regexp: trailing backslash at end of expression: ``"],
  ["[z-a]", "error parsing regexp: invalid character class range: `z-a`"],
  ["\\p{Foo}", "error parsing regexp: invalid character class range: `\\p{Foo}`"],
  ["[[:foo:]]", "error parsing regexp: invalid character class range: `[:foo:]`"],
  ["(?P<x y>a)", "error parsing regexp: invalid named capture: `(?P<x y>`"],
  ["(?<>a)", "error parsing regexp: invalid named capture: `(?<>`"],
  ["(?P<name", "error parsing regexp: invalid named capture: `(?P<name`"],
  ["(?z)", "error parsing regexp: invalid or unsupported Perl syntax: `(?z`"],
  ["(?i-)", "error parsing regexp: invalid or unsupported Perl syntax: `(?i-)`"],
  ["\\C", "error parsing regexp: invalid escape sequence: `\\C`"],
];

const posixErrors: [pattern: string, message: string][] = [
  ["\\z", "error parsing regexp: invalid escape sequence: `\\z`"],
  ["[a-b-c]", "error parsing regexp: invalid character class range: `-c`"],
  ["\\Qabc\\E", "error parsing regexp: invalid escape sequence: `\\Q`"],
  ["(?:a)", "error parsing regexp: missing argument to repetition operator: `?`"],
  ["\\d", "error parsing regexp: invalid escape sequence: `\\d`"],
  ["\\pL", "error parsing regexp: invalid escape sequence: `\\p`"],
];

describe("Error() text", () => {
  perlErrors.forEach(([pattern, message], i) => {
    test(`Perl ${i}_${JSON.stringify(pattern)}`, () => {
      expect(parseError(pattern, Perl).message).toBe(message);
    });
  });
  posixErrors.forEach(([pattern, message], i) => {
    test(`POSIX ${i}_${JSON.stringify(pattern)}`, () => {
      expect(parseError(pattern, POSIX).message).toBe(message);
    });
  });

  test("code and expr", () => {
    const err = parseError("a(b", Perl);
    expect(err.code).toBe("missing closing )");
    expect(err.expr).toBe("a(b");
  });

  test("the limits report the whole pattern", () => {
    const deep = "(".repeat(1000) + ")".repeat(1000);
    expect(parseError(deep, Perl).message).toBe(
      "error parsing regexp: expression nests too deeply: `" + deep + "`",
    );
    const large = "(xx?){1000}".repeat(1000);
    expect(parseError(large, Perl).message).toBe(
      "error parsing regexp: expression too large: `" + large + "`",
    );
    // 1000 is the largest repeat count
    expect(Parse("x{1000}", Perl).max).toBe(1000);
    expect(Parse("x{2,1000}", Perl).max).toBe(1000);
    expect(parseError("x{1000,1001}", Perl).message).toBe(
      "error parsing regexp: invalid repeat count: `{1000,1001}`",
    );
  });
});

describe("invalid UTF-8", () => {
  // Go's message holds the bytes from the invalid one on; here they are
  // lone surrogates (U+DC80+byte), which textToBytes turns back into bytes.
  const cases: [bytes: number[], flags: number, message: string][] = [
    [[0x61, 0xff, 0x62], Perl, "error parsing regexp: invalid UTF-8: `\xffb`"],
    [[0x5b, 0xc3, 0x5d], Perl, "error parsing regexp: invalid UTF-8: `\xc3]`"],
    [[0x5c, 0xff], Perl, "error parsing regexp: invalid UTF-8: `\xff`"],
    [[0x28, 0x3f, 0x69, 0xff, 0x29], Perl, "error parsing regexp: invalid UTF-8: `\xff)`"],
    [[0x61, 0xed, 0xa0, 0x80], Perl, "error parsing regexp: invalid UTF-8: `\xed\xa0\x80`"],
    [[0x61, 0xff], Literal, "error parsing regexp: invalid UTF-8: `\xff`"],
  ];
  cases.forEach(([bytes, flags, message], i) => {
    test(`${i}_${JSON.stringify(bytes)}`, () => {
      const err = parseError(Uint8Array.from(bytes), flags);
      expect(err.code).toBe("invalid UTF-8");
      expect([...textToBytes(err.message)]).toEqual([
        ...Uint8Array.from(message, (c) => c.charCodeAt(0)),
      ]);
    });
  });

  test("a string with lone surrogates is read as Go would read its bytes", () => {
    // U+DCFF stands for the byte 0xff; another lone surrogate cannot be in a
    // Go string and becomes U+FFFD
    expect(parseError("a\udcff", Perl).code).toBe("invalid UTF-8");
    expect(Parse("\ud800", Perl).rune).toEqual([0xfffd]);
  });

  test("U+FFFD itself is valid", () => {
    expect(Parse("�", Perl).rune).toEqual([0xfffd]);
  });
});

describe("Op and Flags values", () => {
  test("Op numbers and names are Go's", () => {
    const names = [
      "NoMatch",
      "EmptyMatch",
      "Literal",
      "CharClass",
      "AnyCharNotNL",
      "AnyChar",
      "BeginLine",
      "EndLine",
      "BeginText",
      "EndText",
      "WordBoundary",
      "NoWordBoundary",
      "Capture",
      "Star",
      "Plus",
      "Quest",
      "Repeat",
      "Concat",
      "Alternate",
    ];
    names.forEach((name, i) => expect(opString(i + 1)).toBe(name));
    expect([OpNoMatch, OpEmptyMatch, OpLiteral, OpCharClass]).toEqual([1, 2, 3, 4]);
    expect([OpCapture, OpStar, OpRepeat, OpConcat, OpAlternate]).toEqual([13, 14, 17, 18, 19]);
    expect(opString(128)).toBe("opPseudo");
    expect(opString(42)).toBe("Op(42)");
  });

  test("Flags are Go's bits", () => {
    expect([FoldCase, Literal, ClassNL, DotNL, OneLine, NonGreedy, PerlX, UnicodeGroups]).toEqual([
      1, 2, 4, 8, 16, 32, 64, 128,
    ]);
    expect([WasDollar, Simple, MatchNL, Perl, POSIX]).toEqual([256, 512, 12, 212, 0]);
  });
});

describe("tree", () => {
  test("captures keep their index and name", () => {
    const re = Parse("(?P<first>a)(b)(?<third>c)", Perl);
    expect(re.op).toBe(OpConcat);
    expect(re.sub.map((sub) => [sub.op, sub.cap, sub.name])).toEqual([
      [OpCapture, 1, "first"],
      [OpCapture, 2, ""],
      [OpCapture, 3, "third"],
    ]);
    expect(re.capNames()).toEqual(["", "first", "", "third"]);
    expect(re.maxCap()).toBe(3);
  });

  test("repeats keep min, max and flags", () => {
    const re = Parse("a{2,}?b*", Perl);
    const [rep, star] = re.sub as [Regexp, Regexp];
    expect([rep.op, rep.min, rep.max, rep.flags]).toEqual([OpRepeat, 2, -1, Perl | NonGreedy]);
    expect([star.op, star.flags]).toEqual([OpStar, Perl]);
    // (?U) swaps greediness
    expect(Parse("(?U)a*", Perl).flags & NonGreedy).toBe(NonGreedy);
    expect(Parse("(?U)a*?", Perl).flags & NonGreedy).toBe(0);
  });

  test("negated classes run up to unicode.MaxRune", () => {
    expect(Parse("[^a]", Perl).rune).toEqual([0, 0x60, 0x62, 0x10ffff]);
    // without ClassNL, \n is excluded
    expect(Parse("[^a]", POSIX).rune).toEqual([0, 9, 0xb, 0x60, 0x62, 0x10ffff]);
    const none = Parse("\\p{^Any}", Perl);
    expect([none.op, none.rune]).toEqual([OpCharClass, []]);
  });

  test("flags on literal nodes", () => {
    const re = Parse("(?i)a", Perl);
    expect([re.op, re.rune, re.flags]).toEqual([OpLiteral, [0x41], Perl | FoldCase]);
    expect(Parse("$", Perl).flags & WasDollar).toBe(WasDollar);
    expect(Parse("\\z", Perl).flags & WasDollar).toBe(0);
  });

  test("runes beyond the valid range stay as Go keeps them", () => {
    // \x{D800} is a surrogate rune in the tree, as in Go
    expect(Parse("\\x{D800}", Perl).rune).toEqual([0xd800]);
  });

  test("the empty pattern and empty alternation", () => {
    expect(Parse("", Perl).op).toBe(OpEmptyMatch);
    expect(Parse("a|", Perl).op).toBe(OpAlternate);
    expect(Parse("[^\\x00-\\x{10FFFF}]", Perl).rune).toEqual([]);
  });

  test("bytes and strings parse alike", () => {
    const pattern = "(?i)[α-ε☺]x{2,5}";
    expect(Parse(new TextEncoder().encode(pattern), Perl).toString()).toBe(
      Parse(pattern, Perl).toString(),
    );
  });
});
