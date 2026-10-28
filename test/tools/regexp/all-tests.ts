// Upstream: Go go1.27.2 src/regexp/all_test.go tables, converted case for case.

export const goodRe: string[] = [
  "",
  ".",
  "^.$",
  "a",
  "a*",
  "a+",
  "a?",
  "a|b",
  "a*|b*",
  "(a*|b)(c*|d)",
  "[a-z]",
  "[a-abc-c\\-\\]\\[]",
  "[a-z]+",
  "[abc]",
  "[^1234]",
  "[^\\n]",
  "\\!\\\\",
];

export const badRe: { re: string; err: string }[] = [
  { re: "*", err: "missing argument to repetition operator: `*`" },
  { re: "+", err: "missing argument to repetition operator: `+`" },
  { re: "?", err: "missing argument to repetition operator: `?`" },
  { re: "(abc", err: "missing closing ): `(abc`" },
  { re: "abc)", err: "unexpected ): `abc)`" },
  { re: "x[a-z", err: "missing closing ]: `[a-z`" },
  { re: "[z-a]", err: "invalid character class range: `z-a`" },
  { re: "abc\\", err: "trailing backslash at end of expression" },
  { re: "a**", err: "invalid nested repetition operator: `**`" },
  { re: "a*+", err: "invalid nested repetition operator: `*+`" },
  { re: "\\x", err: "invalid escape sequence: `\\x`" },
  { re: "\\pL".repeat(27000), err: "expression too large" },
];

export interface ReplaceTest {
  pattern: string;
  replacement: string;
  input: string;
  output: string;
}

export const replaceTests: ReplaceTest[] = [
  // Test empty input and/or replacement, with pattern that matches the empty string.
  { pattern: "", replacement: "", input: "", output: "" },
  { pattern: "", replacement: "x", input: "", output: "x" },
  { pattern: "", replacement: "", input: "abc", output: "abc" },
  { pattern: "", replacement: "x", input: "abc", output: "xaxbxcx" },

  // Test empty input and/or replacement, with pattern that does not match the empty string.
  { pattern: "b", replacement: "", input: "", output: "" },
  { pattern: "b", replacement: "x", input: "", output: "" },
  { pattern: "b", replacement: "", input: "abc", output: "ac" },
  { pattern: "b", replacement: "x", input: "abc", output: "axc" },
  { pattern: "y", replacement: "", input: "", output: "" },
  { pattern: "y", replacement: "x", input: "", output: "" },
  { pattern: "y", replacement: "", input: "abc", output: "abc" },
  { pattern: "y", replacement: "x", input: "abc", output: "abc" },

  // Multibyte characters -- verify that we don't try to match in the middle
  // of a character.
  { pattern: "[a-c]*", replacement: "x", input: "日", output: "x日x" },
  { pattern: "[^日]", replacement: "x", input: "abc日def", output: "xxx日xxx" },

  // Start and end of a string.
  { pattern: "^[a-c]*", replacement: "x", input: "abcdabc", output: "xdabc" },
  { pattern: "[a-c]*$", replacement: "x", input: "abcdabc", output: "abcdx" },
  { pattern: "^[a-c]*$", replacement: "x", input: "abcdabc", output: "abcdabc" },
  { pattern: "^[a-c]*", replacement: "x", input: "abc", output: "x" },
  { pattern: "[a-c]*$", replacement: "x", input: "abc", output: "x" },
  { pattern: "^[a-c]*$", replacement: "x", input: "abc", output: "x" },
  { pattern: "^[a-c]*", replacement: "x", input: "dabce", output: "xdabce" },
  { pattern: "[a-c]*$", replacement: "x", input: "dabce", output: "dabcex" },
  { pattern: "^[a-c]*$", replacement: "x", input: "dabce", output: "dabce" },
  { pattern: "^[a-c]*", replacement: "x", input: "", output: "x" },
  { pattern: "[a-c]*$", replacement: "x", input: "", output: "x" },
  { pattern: "^[a-c]*$", replacement: "x", input: "", output: "x" },

  { pattern: "^[a-c]+", replacement: "x", input: "abcdabc", output: "xdabc" },
  { pattern: "[a-c]+$", replacement: "x", input: "abcdabc", output: "abcdx" },
  { pattern: "^[a-c]+$", replacement: "x", input: "abcdabc", output: "abcdabc" },
  { pattern: "^[a-c]+", replacement: "x", input: "abc", output: "x" },
  { pattern: "[a-c]+$", replacement: "x", input: "abc", output: "x" },
  { pattern: "^[a-c]+$", replacement: "x", input: "abc", output: "x" },
  { pattern: "^[a-c]+", replacement: "x", input: "dabce", output: "dabce" },
  { pattern: "[a-c]+$", replacement: "x", input: "dabce", output: "dabce" },
  { pattern: "^[a-c]+$", replacement: "x", input: "dabce", output: "dabce" },
  { pattern: "^[a-c]+", replacement: "x", input: "", output: "" },
  { pattern: "[a-c]+$", replacement: "x", input: "", output: "" },
  { pattern: "^[a-c]+$", replacement: "x", input: "", output: "" },

  // Other cases.
  { pattern: "abc", replacement: "def", input: "abcdefg", output: "defdefg" },
  { pattern: "bc", replacement: "BC", input: "abcbcdcdedef", output: "aBCBCdcdedef" },
  { pattern: "abc", replacement: "", input: "abcdabc", output: "d" },
  { pattern: "x", replacement: "xXx", input: "xxxXxxx", output: "xXxxXxxXxXxXxxXxxXx" },
  { pattern: "abc", replacement: "d", input: "", output: "" },
  { pattern: "abc", replacement: "d", input: "abc", output: "d" },
  { pattern: ".+", replacement: "x", input: "abc", output: "x" },
  { pattern: "[a-c]*", replacement: "x", input: "def", output: "xdxexfx" },
  { pattern: "[a-c]+", replacement: "x", input: "abcbcdcdedef", output: "xdxdedef" },
  { pattern: "[a-c]*", replacement: "x", input: "abcbcdcdedef", output: "xdxdxexdxexfx" },

  // Substitutions
  { pattern: "a+", replacement: "($0)", input: "banana", output: "b(a)n(a)n(a)" },
  { pattern: "a+", replacement: "(${0})", input: "banana", output: "b(a)n(a)n(a)" },
  { pattern: "a+", replacement: "(${0})$0", input: "banana", output: "b(a)an(a)an(a)a" },
  { pattern: "a+", replacement: "(${0})$0", input: "banana", output: "b(a)an(a)an(a)a" },
  {
    pattern: "hello, (.+)",
    replacement: "goodbye, ${1}",
    input: "hello, world",
    output: "goodbye, world",
  },
  {
    pattern: "hello, (.+)",
    replacement: "goodbye, $1x",
    input: "hello, world",
    output: "goodbye, ",
  },
  {
    pattern: "hello, (.+)",
    replacement: "goodbye, ${1}x",
    input: "hello, world",
    output: "goodbye, worldx",
  },
  {
    pattern: "hello, (.+)",
    replacement: "<$0><$1><$2><$3>",
    input: "hello, world",
    output: "<hello, world><world><><>",
  },
  {
    pattern: "hello, (?P<noun>.+)",
    replacement: "goodbye, $noun!",
    input: "hello, world",
    output: "goodbye, world!",
  },
  {
    pattern: "hello, (?P<noun>.+)",
    replacement: "goodbye, ${noun}",
    input: "hello, world",
    output: "goodbye, world",
  },
  { pattern: "(?P<x>hi)|(?P<x>bye)", replacement: "$x$x$x", input: "hi", output: "hihihi" },
  { pattern: "(?P<x>hi)|(?P<x>bye)", replacement: "$x$x$x", input: "bye", output: "byebyebye" },
  { pattern: "(?P<x>hi)|(?P<x>bye)", replacement: "$xyz", input: "hi", output: "" },
  { pattern: "(?P<x>hi)|(?P<x>bye)", replacement: "${x}yz", input: "hi", output: "hiyz" },
  { pattern: "(?P<x>hi)|(?P<x>bye)", replacement: "hello $$x", input: "hi", output: "hello $x" },
  { pattern: "a+", replacement: "${oops", input: "aaa", output: "${oops" },
  { pattern: "a+", replacement: "$$", input: "aaa", output: "$" },
  { pattern: "a+", replacement: "$", input: "aaa", output: "$" },

  // Substitution when subexpression isn't found
  { pattern: "(x)?", replacement: "$1", input: "123", output: "123" },
  { pattern: "abc", replacement: "$1", input: "123", output: "123" },

  // Substitutions involving a (x){0}
  { pattern: "(a)(b){0}(c)", replacement: ".$1|$3.", input: "xacxacx", output: "x.a|c.x.a|c.x" },
  { pattern: "(a)(((b))){0}c", replacement: ".$1.", input: "xacxacx", output: "x.a.x.a.x" },
  {
    pattern: "((a(b){0}){3}){5}(h)",
    replacement: "y caramb$2",
    input: "say aaaaaaaaaaaaaaaah",
    output: "say ay caramba",
  },
  {
    pattern: "((a(b){0}){3}){5}h",
    replacement: "y caramb$2",
    input: "say aaaaaaaaaaaaaaaah",
    output: "say ay caramba",
  },
];

export const replaceLiteralTests: ReplaceTest[] = [
  // Substitutions
  { pattern: "a+", replacement: "($0)", input: "banana", output: "b($0)n($0)n($0)" },
  { pattern: "a+", replacement: "(${0})", input: "banana", output: "b(${0})n(${0})n(${0})" },
  {
    pattern: "a+",
    replacement: "(${0})$0",
    input: "banana",
    output: "b(${0})$0n(${0})$0n(${0})$0",
  },
  {
    pattern: "a+",
    replacement: "(${0})$0",
    input: "banana",
    output: "b(${0})$0n(${0})$0n(${0})$0",
  },
  {
    pattern: "hello, (.+)",
    replacement: "goodbye, ${1}",
    input: "hello, world",
    output: "goodbye, ${1}",
  },
  {
    pattern: "hello, (?P<noun>.+)",
    replacement: "goodbye, $noun!",
    input: "hello, world",
    output: "goodbye, $noun!",
  },
  {
    pattern: "hello, (?P<noun>.+)",
    replacement: "goodbye, ${noun}",
    input: "hello, world",
    output: "goodbye, ${noun}",
  },
  { pattern: "(?P<x>hi)|(?P<x>bye)", replacement: "$x$x$x", input: "hi", output: "$x$x$x" },
  { pattern: "(?P<x>hi)|(?P<x>bye)", replacement: "$x$x$x", input: "bye", output: "$x$x$x" },
  { pattern: "(?P<x>hi)|(?P<x>bye)", replacement: "$xyz", input: "hi", output: "$xyz" },
  { pattern: "(?P<x>hi)|(?P<x>bye)", replacement: "${x}yz", input: "hi", output: "${x}yz" },
  {
    pattern: "(?P<x>hi)|(?P<x>bye)",
    replacement: "hello $$x",
    input: "hi",
    output: "hello $$x",
  },
  { pattern: "a+", replacement: "${oops", input: "aaa", output: "${oops" },
  { pattern: "a+", replacement: "$$", input: "aaa", output: "$$" },
  { pattern: "a+", replacement: "$", input: "aaa", output: "$" },
];

export interface MetaTest {
  pattern: string;
  output: string;
  literal: string;
  isLiteral: boolean;
}

export const metaTests: MetaTest[] = [
  { pattern: "", output: "", literal: "", isLiteral: true },
  { pattern: "foo", output: "foo", literal: "foo", isLiteral: true },
  { pattern: "日本語+", output: "日本語\\+", literal: "日本語", isLiteral: false },
  // has meta but no operator
  { pattern: "foo\\.\\$", output: "foo\\\\\\.\\\\\\$", literal: "foo.$", isLiteral: true },
  // has escaped operators and real operators
  { pattern: "foo.\\$", output: "foo\\.\\\\\\$", literal: "foo", isLiteral: false },
  {
    pattern: "!@#$%^&*()_+-=[{]}\\|,<.>/?~",
    output: "!@#\\$%\\^&\\*\\(\\)_\\+-=\\[\\{\\]\\}\\\\\\|,<\\.>/\\?~",
    literal: "!@#",
    isLiteral: false,
  },
];

// See golang.org/issue/11175.
// output is unused.
export const literalPrefixTests: MetaTest[] = [
  { pattern: "^0^0$", output: "", literal: "0", isLiteral: false },
  { pattern: "^0^", output: "", literal: "", isLiteral: false },
  { pattern: "^0$", output: "", literal: "0", isLiteral: true },
  { pattern: "$0^", output: "", literal: "", isLiteral: false },
  { pattern: "$0$", output: "", literal: "", isLiteral: false },
  { pattern: "^^0$$", output: "", literal: "", isLiteral: false },
  { pattern: "^$^$", output: "", literal: "", isLiteral: false },
  { pattern: "$$0^^", output: "", literal: "", isLiteral: false },
  { pattern: "a\\x{fffd}b", output: "", literal: "a", isLiteral: false },
  { pattern: "\\x{fffd}b", output: "", literal: "", isLiteral: false },
  { pattern: "�", output: "", literal: "", isLiteral: false },
];

export interface SubexpCase {
  input: string;
  num: number;
  names: string[] | null;
  indices: { name: string; index: number }[];
}

export const subexpCases: SubexpCase[] = [
  {
    input: "",
    num: 0,
    names: null,
    indices: [
      { name: "", index: -1 },
      { name: "missing", index: -1 },
    ],
  },
  {
    input: ".*",
    num: 0,
    names: null,
    indices: [
      { name: "", index: -1 },
      { name: "missing", index: -1 },
    ],
  },
  {
    input: "abba",
    num: 0,
    names: null,
    indices: [
      { name: "", index: -1 },
      { name: "missing", index: -1 },
    ],
  },
  {
    input: "ab(b)a",
    num: 1,
    names: ["", ""],
    indices: [
      { name: "", index: -1 },
      { name: "missing", index: -1 },
    ],
  },
  {
    input: "ab(.*)a",
    num: 1,
    names: ["", ""],
    indices: [
      { name: "", index: -1 },
      { name: "missing", index: -1 },
    ],
  },
  {
    input: "(.*)ab(.*)a",
    num: 2,
    names: ["", "", ""],
    indices: [
      { name: "", index: -1 },
      { name: "missing", index: -1 },
    ],
  },
  {
    input: "(.*)(ab)(.*)a",
    num: 3,
    names: ["", "", "", ""],
    indices: [
      { name: "", index: -1 },
      { name: "missing", index: -1 },
    ],
  },
  {
    input: "(.*)((a)b)(.*)a",
    num: 4,
    names: ["", "", "", "", ""],
    indices: [
      { name: "", index: -1 },
      { name: "missing", index: -1 },
    ],
  },
  {
    input: "(.*)(\\(ab)(.*)a",
    num: 3,
    names: ["", "", "", ""],
    indices: [
      { name: "", index: -1 },
      { name: "missing", index: -1 },
    ],
  },
  {
    input: "(.*)(\\(a\\)b)(.*)a",
    num: 3,
    names: ["", "", "", ""],
    indices: [
      { name: "", index: -1 },
      { name: "missing", index: -1 },
    ],
  },
  {
    input: "(?P<foo>.*)(?P<bar>(a)b)(?P<foo>.*)a",
    num: 4,
    names: ["", "foo", "bar", "", "foo"],
    indices: [
      { name: "", index: -1 },
      { name: "missing", index: -1 },
      { name: "foo", index: 1 },
      { name: "bar", index: 2 },
    ],
  },
];

export const splitTests: { s: string; r: string; n: number; out: string[] | null }[] = [
  { s: "foo:and:bar", r: ":", n: -1, out: ["foo", "and", "bar"] },
  { s: "foo:and:bar", r: ":", n: 1, out: ["foo:and:bar"] },
  { s: "foo:and:bar", r: ":", n: 2, out: ["foo", "and:bar"] },
  { s: "foo:and:bar", r: "foo", n: -1, out: ["", ":and:bar"] },
  { s: "foo:and:bar", r: "bar", n: -1, out: ["foo:and:", ""] },
  { s: "foo:and:bar", r: "baz", n: -1, out: ["foo:and:bar"] },
  { s: "baabaab", r: "a", n: -1, out: ["b", "", "b", "", "b"] },
  { s: "baabaab", r: "a*", n: -1, out: ["b", "b", "b"] },
  { s: "baabaab", r: "ba*", n: -1, out: ["", "", "", ""] },
  { s: "foobar", r: "f*b*", n: -1, out: ["", "o", "o", "a", "r"] },
  { s: "foobar", r: "f+.*b+", n: -1, out: ["", "ar"] },
  { s: "foobooboar", r: "o{2}", n: -1, out: ["f", "b", "boar"] },
  { s: "a,b,c,d,e,f", r: ",", n: 3, out: ["a", "b", "c,d,e,f"] },
  { s: "a,b,c,d,e,f", r: ",", n: 0, out: null },
  { s: ",", r: ",", n: -1, out: ["", ""] },
  { s: ",,,", r: ",", n: -1, out: ["", "", "", ""] },
  { s: "", r: ",", n: -1, out: [""] },
  { s: "", r: ".*", n: -1, out: [""] },
  { s: "", r: ".+", n: -1, out: [""] },
  { s: "", r: "", n: -1, out: [] },
  { s: "foobar", r: "", n: -1, out: ["f", "o", "o", "b", "a", "r"] },
  { s: "abaabaccadaaae", r: "a*", n: 5, out: ["", "b", "b", "c", "cadaaae"] },
  { s: ":x:y:z:", r: ":", n: -1, out: ["", "x", "y", "z", ""] },
];
