// Upstream: Go go1.27.2 src/regexp/syntax/parse_test.go, and the badRe
// error texts of src/regexp/all_test.go (TestBadCompile).
//
// The tables are Go's, case for case. Trees are compared through a port of
// the test's dump format, so a tree is checked node by node. Go strings
// that hold invalid UTF-8 are passed as bytes (goBytes).
//
// mkCharClass builds the expected class by testing every code point with
// unicode.Is over the generated tables, a different path from the parser's
// appendTable/cleanClass. unicode.IsUpper is Is(Lu) (Go's Latin-1
// properties fast path gives the same answer).

import { describe, expect, test } from "bun:test";

import {
  FoldCase,
  Literal,
  MatchNL,
  POSIX,
  Parse,
  Perl,
  PerlX,
  RegexpSyntaxError,
  UnicodeGroups,
  NonGreedy,
  WasDollar,
  appendRange,
  maxFold,
  minFold,
  type Flags,
} from "@/tools/regexp/syntax/parse";
import {
  OpAlternate,
  OpAnyChar,
  OpAnyCharNotNL,
  OpBeginLine,
  OpBeginText,
  OpCapture,
  OpCharClass,
  OpConcat,
  OpEmptyMatch,
  OpEndLine,
  OpEndText,
  OpLiteral,
  OpNoMatch,
  OpNoWordBoundary,
  OpPlus,
  OpQuest,
  OpRepeat,
  OpStar,
  OpWordBoundary,
  Regexp,
} from "@/tools/regexp/syntax/regexp";
import {
  Categories,
  In,
  Is,
  MaxRune,
  Scripts,
  SimpleFold,
  type RangeTable,
} from "@/tools/unicode/letter";
import { runeString } from "@/tools/unicode/utf8";

type parseTest = [regexp: string, dump: string];

// a Go string literal with \x escapes, as its bytes
function goBytes(s: string): Uint8Array {
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

function category(name: string): RangeTable {
  return Categories().get(name) as RangeTable;
}

function script(name: string): RangeTable {
  return Scripts().get(name) as RangeTable;
}

function isUpper(r: number): boolean {
  return Is(category("Lu"), r);
}

const testFlags = MatchNL | PerlX | UnicodeGroups;

// Test Parse -> Dump.
function testParseDump(tests: parseTest[], flags: Flags): void {
  tests.forEach(([regexp, want], i) => {
    test(`${i}_${JSON.stringify(regexp.slice(0, 60))}`, () => {
      const re = Parse(regexp, flags);
      if (want === "") {
        // It parsed. That's all we care about.
        return;
      }
      expect(dump(re)).toBe(want);
    });
  });
}

// dump prints a string representation of the regexp showing
// the structure explicitly.
function dump(re: Regexp): string {
  const b: string[] = [];
  dumpRegexp(b, re);
  return b.join("");
}

const opNames: Record<number, string> = {
  [OpNoMatch]: "no",
  [OpEmptyMatch]: "emp",
  [OpLiteral]: "lit",
  [OpCharClass]: "cc",
  [OpAnyCharNotNL]: "dnl",
  [OpAnyChar]: "dot",
  [OpBeginLine]: "bol",
  [OpEndLine]: "eol",
  [OpBeginText]: "bot",
  [OpEndText]: "eot",
  [OpWordBoundary]: "wb",
  [OpNoWordBoundary]: "nwb",
  [OpCapture]: "cap",
  [OpStar]: "star",
  [OpPlus]: "plus",
  [OpQuest]: "que",
  [OpRepeat]: "rep",
  [OpConcat]: "cat",
  [OpAlternate]: "alt",
};

// %#x
function hex(r: number): string {
  return `0x${r.toString(16)}`;
}

// dumpRegexp writes an encoding of the syntax tree for the regexp re to b.
// It is used during testing to distinguish between parses that might print
// the same using re's String method.
function dumpRegexp(b: string[], re: Regexp): void {
  const name = opNames[re.op];
  if (name === undefined) {
    b.push(`op${re.op}`);
  } else {
    switch (re.op) {
      default:
        b.push(name);
        break;
      case OpStar:
      case OpPlus:
      case OpQuest:
      case OpRepeat:
        if ((re.flags & NonGreedy) !== 0) {
          b.push("n");
        }
        b.push(name);
        break;
      case OpLiteral:
        if (re.rune.length > 1) {
          b.push("str");
        } else {
          b.push("lit");
        }
        if ((re.flags & FoldCase) !== 0) {
          if (re.rune.some((r) => SimpleFold(r) !== r)) {
            b.push("fold");
          }
        }
        break;
    }
  }
  b.push("{");
  switch (re.op) {
    case OpEndText:
      if ((re.flags & WasDollar) === 0) {
        b.push(String.raw`\z`);
      }
      break;
    case OpLiteral:
      for (const r of re.rune) {
        b.push(runeString(r));
      }
      break;
    case OpConcat:
    case OpAlternate:
      for (const sub of re.sub) {
        dumpRegexp(b, sub);
      }
      break;
    case OpStar:
    case OpPlus:
    case OpQuest:
      dumpRegexp(b, re.sub[0] as Regexp);
      break;
    case OpRepeat:
      b.push(`${re.min},${re.max} `);
      dumpRegexp(b, re.sub[0] as Regexp);
      break;
    case OpCapture:
      if (re.name !== "") {
        b.push(re.name, ":");
      }
      dumpRegexp(b, re.sub[0] as Regexp);
      break;
    case OpCharClass: {
      let sep = "";
      for (let i = 0; i < re.rune.length; i += 2) {
        b.push(sep);
        sep = " ";
        const lo = re.rune[i] as number;
        const hi = re.rune[i + 1] as number;
        if (lo === hi) {
          b.push(hex(lo));
        } else {
          b.push(`${hex(lo)}-${hex(hi)}`);
        }
      }
      break;
    }
  }
  b.push("}");
}

function mkCharClass(f: (r: number) => boolean): string {
  const re = new Regexp(OpCharClass);
  let lo = -1;
  for (let i = 0; i <= MaxRune; i++) {
    if (f(i)) {
      if (lo < 0) {
        lo = i;
      }
    } else if (lo >= 0) {
      re.rune.push(lo, i - 1);
      lo = -1;
    }
  }
  if (lo >= 0) {
    re.rune.push(lo, MaxRune);
  }
  return dump(re);
}

function isUpperFold(r: number): boolean {
  if (isUpper(r)) {
    return true;
  }
  let c = SimpleFold(r);
  while (c !== r) {
    if (isUpper(c)) {
      return true;
    }
    c = SimpleFold(c);
  }
  return false;
}

const parseTests: parseTest[] = [
  // Base cases
  ["a", "lit{a}"],
  ["a.", "cat{lit{a}dot{}}"],
  ["a.b", "cat{lit{a}dot{}lit{b}}"],
  ["ab", "str{ab}"],
  ["a.b.c", "cat{lit{a}dot{}lit{b}dot{}lit{c}}"],
  ["abc", "str{abc}"],
  ["a|^", "alt{lit{a}bol{}}"],
  ["a|b", "cc{0x61-0x62}"],
  ["(a)", "cap{lit{a}}"],
  ["(a)|b", "alt{cap{lit{a}}lit{b}}"],
  ["a*", "star{lit{a}}"],
  ["a+", "plus{lit{a}}"],
  ["a?", "que{lit{a}}"],
  ["a{2}", "rep{2,2 lit{a}}"],
  ["a{2,3}", "rep{2,3 lit{a}}"],
  ["a{2,}", "rep{2,-1 lit{a}}"],
  ["a*?", "nstar{lit{a}}"],
  ["a+?", "nplus{lit{a}}"],
  ["a??", "nque{lit{a}}"],
  ["a{2}?", "nrep{2,2 lit{a}}"],
  ["a{2,3}?", "nrep{2,3 lit{a}}"],
  ["a{2,}?", "nrep{2,-1 lit{a}}"],
  // Malformed { } are treated as literals.
  ["x{1001", "str{x{1001}"],
  ["x{9876543210", "str{x{9876543210}"],
  ["x{9876543210,", "str{x{9876543210,}"],
  ["x{2,1", "str{x{2,1}"],
  ["x{1,9876543210", "str{x{1,9876543210}"],
  ["", "emp{}"],
  ["|", "emp{}"], // alt{emp{}emp{}} but got factored
  ["|x|", "alt{emp{}lit{x}emp{}}"],
  [".", "dot{}"],
  ["^", "bol{}"],
  ["$", "eol{}"],
  ["\\|", "lit{|}"],
  ["\\(", "lit{(}"],
  ["\\)", "lit{)}"],
  ["\\*", "lit{*}"],
  ["\\+", "lit{+}"],
  ["\\?", "lit{?}"],
  ["{", "lit{{}"],
  ["}", "lit{}}"],
  ["\\.", "lit{.}"],
  ["\\^", "lit{^}"],
  ["\\$", "lit{$}"],
  ["\\\\", "lit{\\}"],
  ["[ace]", "cc{0x61 0x63 0x65}"],
  ["[abc]", "cc{0x61-0x63}"],
  ["[a-z]", "cc{0x61-0x7a}"],
  ["[a]", "lit{a}"],
  ["\\-", "lit{-}"],
  ["-", "lit{-}"],
  ["\\_", "lit{_}"],
  ["abc", "str{abc}"],
  ["abc|def", "alt{str{abc}str{def}}"],
  ["abc|def|ghi", "alt{str{abc}str{def}str{ghi}}"],

  // Posix and Perl extensions
  ["[[:lower:]]", "cc{0x61-0x7a}"],
  ["[a-z]", "cc{0x61-0x7a}"],
  ["[^[:lower:]]", "cc{0x0-0x60 0x7b-0x10ffff}"],
  ["[[:^lower:]]", "cc{0x0-0x60 0x7b-0x10ffff}"],
  ["(?i)[[:lower:]]", "cc{0x41-0x5a 0x61-0x7a 0x17f 0x212a}"],
  ["(?i)[a-z]", "cc{0x41-0x5a 0x61-0x7a 0x17f 0x212a}"],
  ["(?i)[^[:lower:]]", "cc{0x0-0x40 0x5b-0x60 0x7b-0x17e 0x180-0x2129 0x212b-0x10ffff}"],
  ["(?i)[[:^lower:]]", "cc{0x0-0x40 0x5b-0x60 0x7b-0x17e 0x180-0x2129 0x212b-0x10ffff}"],
  ["\\d", "cc{0x30-0x39}"],
  ["\\D", "cc{0x0-0x2f 0x3a-0x10ffff}"],
  ["\\s", "cc{0x9-0xa 0xc-0xd 0x20}"],
  ["\\S", "cc{0x0-0x8 0xb 0xe-0x1f 0x21-0x10ffff}"],
  ["\\w", "cc{0x30-0x39 0x41-0x5a 0x5f 0x61-0x7a}"],
  ["\\W", "cc{0x0-0x2f 0x3a-0x40 0x5b-0x5e 0x60 0x7b-0x10ffff}"],
  ["(?i)\\w", "cc{0x30-0x39 0x41-0x5a 0x5f 0x61-0x7a 0x17f 0x212a}"],
  ["(?i)\\W", "cc{0x0-0x2f 0x3a-0x40 0x5b-0x5e 0x60 0x7b-0x17e 0x180-0x2129 0x212b-0x10ffff}"],
  ["[^\\\\]", "cc{0x0-0x5b 0x5d-0x10ffff}"],
  //	{ `\C`, `byte{}` },  // probably never

  // Unicode, negatives, and a double negative.
  ["\\p{Braille}", "cc{0x2800-0x28ff}"],
  ["\\P{Braille}", "cc{0x0-0x27ff 0x2900-0x10ffff}"],
  ["\\p{^Braille}", "cc{0x0-0x27ff 0x2900-0x10ffff}"],
  ["\\P{^Braille}", "cc{0x2800-0x28ff}"],
  ["\\pZ", "cc{0x20 0xa0 0x1680 0x2000-0x200a 0x2028-0x2029 0x202f 0x205f 0x3000}"],
  ["[\\p{Braille}]", "cc{0x2800-0x28ff}"],
  ["[\\P{Braille}]", "cc{0x0-0x27ff 0x2900-0x10ffff}"],
  ["[\\p{^Braille}]", "cc{0x0-0x27ff 0x2900-0x10ffff}"],
  ["[\\P{^Braille}]", "cc{0x2800-0x28ff}"],
  ["[\\pZ]", "cc{0x20 0xa0 0x1680 0x2000-0x200a 0x2028-0x2029 0x202f 0x205f 0x3000}"],
  ["\\p{Lu}", mkCharClass(isUpper)],
  ["\\p{Uppercase_Letter}", mkCharClass(isUpper)],
  ["\\p{upper case-let ter}", mkCharClass(isUpper)],
  ["\\p{__upper case-let ter}", mkCharClass(isUpper)],
  ["\\p{Canadian_Aboriginal}", mkCharClass((r) => In(r, script("Canadian_Aboriginal")))],
  ["[\\p{Lu}]", mkCharClass(isUpper)],
  ["(?i)[\\p{Lu}]", mkCharClass(isUpperFold)],
  ["\\p{Any}", "dot{}"],
  ["\\p{^Any}", "cc{}"],
  ["(?i)\\p{ascii}", "cc{0x0-0x7f 0x17f 0x212a}"],
  ["\\p{Assigned}", mkCharClass((r) => !In(r, category("Cn")))],
  ["\\p{^Assigned}", mkCharClass((r) => In(r, category("Cn")))],

  // Hex, octal.
  ["[\\012-\\234]\\141", "cat{cc{0xa-0x9c}lit{a}}"],
  ["[\\x{41}-\\x7a]\\x61", "cat{cc{0x41-0x7a}lit{a}}"],

  // More interesting regular expressions.
  ["a{,2}", "str{a{,2}}"],
  ["\\.\\^\\$\\\\", "str{.^$\\}"],
  ["[a-zABC]", "cc{0x41-0x43 0x61-0x7a}"],
  ["[^a]", "cc{0x0-0x60 0x62-0x10ffff}"],
  ["[α-ε☺]", "cc{0x3b1-0x3b5 0x263a}"], // utf-8
  ["a*{", "cat{star{lit{a}}lit{{}}"],

  // Test precedences
  ["(?:ab)*", "star{str{ab}}"],
  ["(ab)*", "star{cap{str{ab}}}"],
  ["ab|cd", "alt{str{ab}str{cd}}"],
  ["a(b|c)d", "cat{lit{a}cap{cc{0x62-0x63}}lit{d}}"],

  // Test flattening.
  ["(?:a)", "lit{a}"],
  ["(?:ab)(?:cd)", "str{abcd}"],
  ["(?:a+b+)(?:c+d+)", "cat{plus{lit{a}}plus{lit{b}}plus{lit{c}}plus{lit{d}}}"],
  ["(?:a+|b+)|(?:c+|d+)", "alt{plus{lit{a}}plus{lit{b}}plus{lit{c}}plus{lit{d}}}"],
  ["(?:a|b)|(?:c|d)", "cc{0x61-0x64}"],
  ["a|.", "dot{}"],
  [".|a", "dot{}"],
  ["(?:[abc]|A|Z|hello|world)", "alt{cc{0x41 0x5a 0x61-0x63}str{hello}str{world}}"],
  ["(?:[abc]|A|Z)", "cc{0x41 0x5a 0x61-0x63}"],

  // Test Perl quoted literals
  ["\\Q+|*?{[\\E", "str{+|*?{[}"],
  ["\\Q+\\E+", "plus{lit{+}}"],
  ["\\Qab\\E+", "cat{lit{a}plus{lit{b}}}"],
  ["\\Q\\\\E", "lit{\\}"],
  ["\\Q\\\\\\E", "str{\\\\}"],

  // Test Perl \A and \z
  ["(?m)^", "bol{}"],
  ["(?m)$", "eol{}"],
  ["(?-m)^", "bot{}"],
  ["(?-m)$", "eot{}"],
  ["(?m)\\A", "bot{}"],
  ["(?m)\\z", "eot{\\z}"],
  ["(?-m)\\A", "bot{}"],
  ["(?-m)\\z", "eot{\\z}"],

  // Test named captures
  ["(?P<name>a)", "cap{name:lit{a}}"],
  ["(?<name>a)", "cap{name:lit{a}}"],

  // Case-folded literals
  ["[Aa]", "litfold{A}"],
  ["[\\x{100}\\x{101}]", "litfold{Ā}"],
  ["[Δδ]", "litfold{Δ}"],

  // Strings
  ["abcde", "str{abcde}"],
  ["[Aa][Bb]cd", "cat{strfold{AB}str{cd}}"],

  // Factoring.
  [
    "abc|abd|aef|bcx|bcy",
    "alt{cat{lit{a}alt{cat{lit{b}cc{0x63-0x64}}str{ef}}}cat{str{bc}cc{0x78-0x79}}}",
  ],
  [
    "ax+y|ax+z|ay+w",
    "cat{lit{a}alt{cat{plus{lit{x}}lit{y}}cat{plus{lit{x}}lit{z}}cat{plus{lit{y}}lit{w}}}}",
  ],

  // Bug fixes.
  ["(?:.)", "dot{}"],
  ["(?:x|(?:xa))", "cat{lit{x}alt{emp{}lit{a}}}"],
  ["(?:.|(?:.a))", "cat{dot{}alt{emp{}lit{a}}}"],
  ["(?:A(?:A|a))", "cat{lit{A}litfold{A}}"],
  ["(?:A|a)", "litfold{A}"],
  ["A|(?:A|a)", "litfold{A}"],
  ["(?s).", "dot{}"],
  ["(?-s).", "dnl{}"],
  ["(?:(?:^).)", "cat{bol{}dot{}}"],
  ["(?-s)(?:(?:^).)", "cat{bol{}dnl{}}"],
  ["[\\s\\S]a", "cat{cc{0x0-0x10ffff}lit{a}}"],

  // RE2 prefix_tests
  ["abc|abd", "cat{str{ab}cc{0x63-0x64}}"],
  ["a(?:b)c|abd", "cat{str{ab}cc{0x63-0x64}}"],
  [
    "abc|abd|aef|bcx|bcy",
    "alt{cat{lit{a}alt{cat{lit{b}cc{0x63-0x64}}str{ef}}}cat{str{bc}cc{0x78-0x79}}}",
  ],
  ["abc|x|abd", "alt{str{abc}lit{x}str{abd}}"],
  ["(?i)abc|ABD", "cat{strfold{AB}cc{0x43-0x44 0x63-0x64}}"],
  ["[ab]c|[ab]d", "cat{cc{0x61-0x62}cc{0x63-0x64}}"],
  [".c|.d", "cat{dot{}cc{0x63-0x64}}"],
  ["x{2}|x{2}[0-9]", "cat{rep{2,2 lit{x}}alt{emp{}cc{0x30-0x39}}}"],
  ["x{2}y|x{2}[0-9]y", "cat{rep{2,2 lit{x}}alt{lit{y}cat{cc{0x30-0x39}lit{y}}}}"],
  ["a.*?c|a.*?b", "cat{lit{a}alt{cat{nstar{dot{}}lit{c}}cat{nstar{dot{}}lit{b}}}}"],

  // Valid repetitions.
  ["((((((((((x{2}){2}){2}){2}){2}){2}){2}){2}){2}))", ""],
  ["((((((((((x{1}){2}){2}){2}){2}){2}){2}){2}){2}){2})", ""],

  // Valid nesting.
  ["(".repeat(999) + ")".repeat(999), ""],
  ["(?:".repeat(999) + ")*".repeat(999), ""],
  ["(" + "|".repeat(12345) + ")", ""], // not nested at all
];

const foldcaseTests: parseTest[] = [
  ["AbCdE", "strfold{ABCDE}"],
  ["[Aa]", "litfold{A}"],
  ["a", "litfold{A}"],

  // 0x17F is an old English long s (looks like an f) and folds to s.
  // 0x212A is the Kelvin symbol and folds to k.
  ["A[F-g]", "cat{litfold{A}cc{0x41-0x7a 0x17f 0x212a}}"], // [Aa][A-z...]
  ["[[:upper:]]", "cc{0x41-0x5a 0x61-0x7a 0x17f 0x212a}"],
  ["[[:lower:]]", "cc{0x41-0x5a 0x61-0x7a 0x17f 0x212a}"],
];

const literalTests: parseTest[] = [["(|)^$.[*+?]{5,10},\\", "str{(|)^$.[*+?]{5,10},\\}"]];

const matchnlTests: parseTest[] = [
  [".", "dot{}"],
  ["\n", "lit{\n}"],
  ["[^a]", "cc{0x0-0x60 0x62-0x10ffff}"],
  ["[a\\n]", "cc{0xa 0x61}"],
];

const nomatchnlTests: parseTest[] = [
  [".", "dnl{}"],
  ["\n", "lit{\n}"],
  ["[^a]", "cc{0x0-0x9 0xb-0x60 0x62-0x10ffff}"],
  ["[a\\n]", "cc{0xa 0x61}"],
];

const invalidRegexps: (string | Uint8Array)[] = [
  "(",
  ")",
  "(a",
  "a)",
  "(a))",
  "(a|b|",
  "a|b|)",
  "(a|b|))",
  "(a|b",
  "a|b)",
  "(a|b))",
  "[a-z",
  "([a-z)",
  "[a-z)",
  "([a-z]))",
  "x{1001}",
  "x{9876543210}",
  "x{2,1}",
  "x{1,9876543210}",
  goBytes("\xff"), // Invalid UTF-8
  goBytes("[\xff]"),
  goBytes("[\\\xff]"),
  goBytes("\\\xff"),
  "(?P<name>a",
  "(?P<name>",
  "(?P<name",
  "(?P<x y>a)",
  "(?P<>a)",
  "(?<name>a",
  "(?<name>",
  "(?<name",
  "(?<x y>a)",
  "(?<>a)",
  "[a-Z]",
  "(?i)[a-Z]",
  "\\Q\\E*",
  "a{100000}", // too much repetition
  "a{100000,}", // too much repetition
  "((((((((((x{2}){2}){2}){2}){2}){2}){2}){2}){2}){2})", // too much repetition
  "(".repeat(1000) + ")".repeat(1000), // too deep
  "(?:".repeat(1000) + ")*".repeat(1000), // too deep
  "(" + "(xx?)".repeat(1000) + "){1000}", // too long
  "(xx?){1000}".repeat(1000), // too long
  "\\pL".repeat(27000), // too many runes
];

const onlyPerl: (string | Uint8Array)[] = [
  "[a-b-c]",
  "\\Qabc\\E",
  "\\Q*+?{[\\E",
  "\\Q\\\\E",
  "\\Q\\\\\\E",
  "\\Q\\\\\\\\E",
  "\\Q\\\\\\\\\\E",
  "(?:a)",
  "(?P<name>a)",
];

const onlyPOSIX: (string | Uint8Array)[] = ["a++", "a**", "a?*", "a+*", "a{1}*", ".{1}{2}.{3}"];

const stringTests: [re: string, out: string][] = [
  ["x(?i:ab*c|d?e)1", "x(?i:AB*C|D?E)1"],
  ["x(?i:ab*cd?e)1", "x(?i:AB*CD?E)1"],
  ["0(?i:ab*c|d?e)1", "(?i:0(?:AB*C|D?E)1)"],
  ["0(?i:ab*cd?e)1", "(?i:0AB*CD?E1)"],
  ["x(?i:ab*c|d?e)", "x(?i:AB*C|D?E)"],
  ["x(?i:ab*cd?e)", "x(?i:AB*CD?E)"],
  ["0(?i:ab*c|d?e)", "(?i:0(?:AB*C|D?E))"],
  ["0(?i:ab*cd?e)", "(?i:0AB*CD?E)"],
  ["(?i:ab*c|d?e)1", "(?i:(?:AB*C|D?E)1)"],
  ["(?i:ab*cd?e)1", "(?i:AB*CD?E1)"],
  ["(?i:ab)[123](?i:cd)", "(?i:AB[1-3]CD)"],
  ["(?i:ab*c|d?e)", "(?i:AB*C|D?E)"],
  ["[Aa][Bb]", "(?i:AB)"],
  ["[Aa][Bb]*[Cc]", "(?i:AB*C)"],
  ["A(?:[Bb][Cc]|[Dd])[Zz]", "A(?i:(?:BC|D)Z)"],
  ["[Aa](?:[Bb][Cc]|[Dd])Z", "(?i:A(?:BC|D))Z"],
];

// TestBadCompile in src/regexp/all_test.go: regexp.Compile parses with
// Perl flags; the expected text is contained in the error.
const badRe: [re: string, err: string][] = [
  ["*", "missing argument to repetition operator: `*`"],
  ["+", "missing argument to repetition operator: `+`"],
  ["?", "missing argument to repetition operator: `?`"],
  ["(abc", "missing closing ): `(abc`"],
  ["abc)", "unexpected ): `abc)`"],
  ["x[a-z", "missing closing ]: `[a-z`"],
  ["[z-a]", "invalid character class range: `z-a`"],
  ["abc\\", "trailing backslash at end of expression"],
  ["a**", "invalid nested repetition operator: `**`"],
  ["a*+", "invalid nested repetition operator: `*+`"],
  ["\\x", "invalid escape sequence: `\\x`"],
  ["\\pL".repeat(27000), "expression too large"],
];

describe("TestParseSimple", () => {
  testParseDump(parseTests, testFlags);
});

describe("TestParseFoldCase", () => {
  testParseDump(foldcaseTests, FoldCase);
});

describe("TestParseLiteral", () => {
  testParseDump(literalTests, Literal);
});

describe("TestParseMatchNL", () => {
  testParseDump(matchnlTests, MatchNL);
});

describe("TestParseNoMatchNL", () => {
  testParseDump(nomatchnlTests, 0);
});

test("TestFoldConstants", () => {
  let first = -1;
  let last = -1;
  for (let i = 0; i <= MaxRune; i++) {
    if (SimpleFold(i) === i) {
      continue;
    }
    if (first === -1) {
      first = i;
    }
    last = i;
  }
  expect(hex(first)).toBe(hex(minFold));
  expect(hex(last)).toBe(hex(maxFold));
});

test("TestAppendRangeCollapse", () => {
  // AppendRange should collapse each of the new ranges
  // into the earlier ones (it looks back two ranges), so that
  // the slice never grows very large.
  // Note that we are not calling cleanClass.
  let r: number[] = [];
  for (let i = 0x41; i <= 0x5a; i++) {
    r = appendRange(r, i, i);
    r = appendRange(r, i + 0x20, i + 0x20);
  }
  expect(String.fromCodePoint(...r)).toBe("AZaz");
});

function label(regexp: string | Uint8Array): string {
  return JSON.stringify(typeof regexp === "string" ? regexp.slice(0, 60) : [...regexp]);
}

describe("TestParseInvalidRegexps", () => {
  invalidRegexps.forEach((regexp, i) => {
    test(`invalid ${i}_${label(regexp)}`, () => {
      expect(() => Parse(regexp, Perl)).toThrow(RegexpSyntaxError);
      expect(() => Parse(regexp, POSIX)).toThrow(RegexpSyntaxError);
    });
  });
  onlyPerl.forEach((regexp, i) => {
    test(`onlyPerl ${i}_${label(regexp)}`, () => {
      Parse(regexp, Perl);
      expect(() => Parse(regexp, POSIX)).toThrow(RegexpSyntaxError);
    });
  });
  onlyPOSIX.forEach((regexp, i) => {
    test(`onlyPOSIX ${i}_${label(regexp)}`, () => {
      expect(() => Parse(regexp, Perl)).toThrow(RegexpSyntaxError);
      Parse(regexp, POSIX);
    });
  });
});

describe("TestToStringEquivalentParse", () => {
  parseTests.forEach(([regexp, want], i) => {
    test(`${i}_${JSON.stringify(regexp.slice(0, 60))}`, () => {
      const re = Parse(regexp, testFlags);
      if (want === "") {
        // It parsed. That's all we care about.
        return;
      }
      const d = dump(re);
      expect(d).toBe(want);

      const s = re.toString();
      if (s !== regexp) {
        // If ToString didn't return the original regexp,
        // it must have found one with fewer parens.
        // Unfortunately we can't check the length here, because
        // ToString produces "\\{" for a literal brace,
        // but "{" is a shorter equivalent in some contexts.
        const nre = Parse(s, testFlags);
        expect(dump(nre)).toBe(d);
        expect(nre.toString()).toBe(s);
      }
    });
  });
});

describe("TestString", () => {
  stringTests.forEach(([re, out], i) => {
    test(`${i}_${JSON.stringify(re)}`, () => {
      expect(Parse(re, Perl).toString()).toBe(out);
    });
  });
});

describe("TestBadCompile", () => {
  badRe.forEach(([re, err], i) => {
    test(`${i}_${JSON.stringify(re.slice(0, 60))}`, () => {
      expect(() => Parse(re, Perl)).toThrow(err);
    });
  });
});
