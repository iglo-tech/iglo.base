// Upstream: Go go1.27.2 src/regexp/syntax/simplify_test.go (simplifyTests), converted case for case.

export const simplifyTests: { regexp: string; simple: string }[] = [
  // Already-simple constructs
  { regexp: "a", simple: "a" },
  { regexp: "ab", simple: "ab" },
  { regexp: "a|b", simple: "[ab]" },
  { regexp: "ab|cd", simple: "ab|cd" },
  { regexp: "(ab)*", simple: "(ab)*" },
  { regexp: "(ab)+", simple: "(ab)+" },
  { regexp: "(ab)?", simple: "(ab)?" },
  { regexp: ".", simple: "(?s:.)" },
  { regexp: "^", simple: "(?m:^)" },
  { regexp: "$", simple: "(?m:$)" },
  { regexp: "[ac]", simple: "[ac]" },
  { regexp: "[^ac]", simple: "[^ac]" },

  // Posix character classes
  { regexp: "[[:alnum:]]", simple: "[0-9A-Za-z]" },
  { regexp: "[[:alpha:]]", simple: "[A-Za-z]" },
  { regexp: "[[:blank:]]", simple: "[\\t ]" },
  { regexp: "[[:cntrl:]]", simple: "[\\x00-\\x1f\\x7f]" },
  { regexp: "[[:digit:]]", simple: "[0-9]" },
  { regexp: "[[:graph:]]", simple: "[!-~]" },
  { regexp: "[[:lower:]]", simple: "[a-z]" },
  { regexp: "[[:print:]]", simple: "[ -~]" },
  { regexp: "[[:punct:]]", simple: "[!-/:-@\\[-`\\{-~]" },
  { regexp: "[[:space:]]", simple: "[\\t-\\r ]" },
  { regexp: "[[:upper:]]", simple: "[A-Z]" },
  { regexp: "[[:xdigit:]]", simple: "[0-9A-Fa-f]" },

  // Perl character classes
  { regexp: "\\d", simple: "[0-9]" },
  { regexp: "\\s", simple: "[\\t\\n\\f\\r ]" },
  { regexp: "\\w", simple: "[0-9A-Z_a-z]" },
  { regexp: "\\D", simple: "[^0-9]" },
  { regexp: "\\S", simple: "[^\\t\\n\\f\\r ]" },
  { regexp: "\\W", simple: "[^0-9A-Z_a-z]" },
  { regexp: "[\\d]", simple: "[0-9]" },
  { regexp: "[\\s]", simple: "[\\t\\n\\f\\r ]" },
  { regexp: "[\\w]", simple: "[0-9A-Z_a-z]" },
  { regexp: "[\\D]", simple: "[^0-9]" },
  { regexp: "[\\S]", simple: "[^\\t\\n\\f\\r ]" },
  { regexp: "[\\W]", simple: "[^0-9A-Z_a-z]" },

  // Posix repetitions
  { regexp: "a{1}", simple: "a" },
  { regexp: "a{2}", simple: "aa" },
  { regexp: "a{5}", simple: "aaaaa" },
  { regexp: "a{0,1}", simple: "a?" },
  // The next three are illegible because Simplify inserts (?:)
  // parens instead of () parens to avoid creating extra
  // captured subexpressions. The comments show a version with fewer parens.
  { regexp: "(a){0,2}", simple: "(?:(a)(a)?)?" }, //       (aa?)?
  { regexp: "(a){0,4}", simple: "(?:(a)(?:(a)(?:(a)(a)?)?)?)?" }, //   (a(a(aa?)?)?)?
  { regexp: "(a){2,6}", simple: "(a)(a)(?:(a)(?:(a)(?:(a)(a)?)?)?)?" }, // aa(a(a(aa?)?)?)?
  { regexp: "a{0,2}", simple: "(?:aa?)?" }, //       (aa?)?
  { regexp: "a{0,4}", simple: "(?:a(?:a(?:aa?)?)?)?" }, //   (a(a(aa?)?)?)?
  { regexp: "a{2,6}", simple: "aa(?:a(?:a(?:aa?)?)?)?" }, // aa(a(a(aa?)?)?)?
  { regexp: "a{0,}", simple: "a*" },
  { regexp: "a{1,}", simple: "a+" },
  { regexp: "a{2,}", simple: "aa+" },
  { regexp: "a{5,}", simple: "aaaaa+" },

  // Test that operators simplify their arguments.
  { regexp: "(?:a{1,}){1,}", simple: "a+" },
  { regexp: "(a{1,}b{1,})", simple: "(a+b+)" },
  { regexp: "a{1,}|b{1,}", simple: "a+|b+" },
  { regexp: "(?:a{1,})*", simple: "(?:a+)*" },
  { regexp: "(?:a{1,})+", simple: "a+" },
  { regexp: "(?:a{1,})?", simple: "(?:a+)?" },
  { regexp: "", simple: "(?:)" },
  { regexp: "a{0}", simple: "(?:)" },

  // Character class simplification
  { regexp: "[ab]", simple: "[ab]" },
  { regexp: "[abc]", simple: "[a-c]" },
  { regexp: "[a-za-za-z]", simple: "[a-z]" },
  { regexp: "[A-Za-zA-Za-z]", simple: "[A-Za-z]" },
  { regexp: "[ABCDEFGH]", simple: "[A-H]" },
  { regexp: "[AB-CD-EF-GH]", simple: "[A-H]" },
  { regexp: "[W-ZP-XE-R]", simple: "[E-Z]" },
  { regexp: "[a-ee-gg-m]", simple: "[a-m]" },
  { regexp: "[a-ea-ha-m]", simple: "[a-m]" },
  { regexp: "[a-ma-ha-e]", simple: "[a-m]" },
  { regexp: "[a-zA-Z0-9 -~]", simple: "[ -~]" },

  // Empty character classes
  { regexp: "[^[:cntrl:][:^cntrl:]]", simple: "[^\\x00-\\x{10FFFF}]" },

  // Full character classes
  { regexp: "[[:cntrl:][:^cntrl:]]", simple: "(?s:.)" },

  // Unicode case folding.
  { regexp: "(?i)A", simple: "(?i:A)" },
  { regexp: "(?i)a", simple: "(?i:A)" },
  { regexp: "(?i)[A]", simple: "(?i:A)" },
  { regexp: "(?i)[a]", simple: "(?i:A)" },
  { regexp: "(?i)K", simple: "(?i:K)" },
  { regexp: "(?i)k", simple: "(?i:K)" },
  { regexp: "(?i)\\x{212a}", simple: "(?i:K)" },
  { regexp: "(?i)[K]", simple: "[Kk\u212A]" },
  { regexp: "(?i)[k]", simple: "[Kk\u212A]" },
  { regexp: "(?i)[\\x{212a}]", simple: "[Kk\u212A]" },
  { regexp: "(?i)[a-z]", simple: "[A-Za-z\u017F\u212A]" },
  { regexp: "(?i)[\\x00-\\x{FFFD}]", simple: "[\\x00-\uFFFD]" },
  { regexp: "(?i)[\\x00-\\x{10FFFF}]", simple: "(?s:.)" },

  // Empty string as a regular expression.
  // The empty string must be preserved inside parens in order
  // to make submatches work right, so these tests are less
  // interesting than they might otherwise be. String inserts
  // explicit (?:) in place of non-parenthesized empty strings,
  // to make them easier to spot for other parsers.
  { regexp: "(a|b|c|)", simple: "([a-c]|(?:))" },
  { regexp: "(a|b|)", simple: "([ab]|(?:))" },
  { regexp: "(|)", simple: "()" },
  { regexp: "a()", simple: "a()" },
  { regexp: "(()|())", simple: "(()|())" },
  { regexp: "(a|)", simple: "(a|(?:))" },
  { regexp: "ab()cd()", simple: "ab()cd()" },
  { regexp: "()", simple: "()" },
  { regexp: "()*", simple: "()*" },
  { regexp: "()+", simple: "()+" },
  { regexp: "()?", simple: "()?" },
  { regexp: "(){0}", simple: "(?:)" },
  { regexp: "(){1}", simple: "()" },
  { regexp: "(){1,}", simple: "()+" },
  { regexp: "(){0,2}", simple: "(?:()()?)?" },
];
