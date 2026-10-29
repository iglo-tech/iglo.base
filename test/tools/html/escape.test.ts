// Upstream: golang.org/x/net v0.61.0 html/escape_test.go and html/entity_test.go

import { describe, expect, test } from "bun:test";
import { escapeString, unescapeString } from "@/tools/html/escape";
import { entity, longestEntityWithoutSemicolon } from "@/tools/html/entity";

const unescapeTests: { desc: string; html: string; unescaped: string }[] = [
  // Handle no entities.
  { desc: "copy", html: "A\ttext\nstring", unescaped: "A\ttext\nstring" },
  // Handle simple named entities.
  { desc: "simple", html: "&amp; &gt; &lt;", unescaped: "& > <" },
  // Handle hitting the end of the string.
  { desc: "stringEnd", html: "&amp &amp", unescaped: "& &" },
  // Handle entities with two codepoints.
  { desc: "multiCodepoint", html: "text &gesl; blah", unescaped: "text ⋛︀ blah" },
  // Handle decimal numeric entities.
  { desc: "decimalEntity", html: "Delta = &#916; ", unescaped: "Delta = Δ " },
  // Handle hexadecimal numeric entities.
  { desc: "hexadecimalEntity", html: "Lambda = &#x3bb; = &#X3Bb ", unescaped: "Lambda = λ = λ " },
  // Handle numeric early termination.
  {
    desc: "numericEnds",
    html: "&# &#x &#128;43 &copy = &#169f = &#xa9",
    unescaped: "&# &#x €43 © = ©f = ©",
  },
  // Handle numeric ISO-8859-1 entity replacements.
  { desc: "numericReplacements", html: "Footnote&#x87;", unescaped: "Footnote‡" },
  { desc: "single digit numeric entity", html: "&#7;", unescaped: "\u0007" },
  { desc: "single digit hex entity", html: "&#x7;", unescaped: "\u0007" },
  { desc: "nLt then text", html: "&nLt;hello", unescaped: "≪⃒hello" },
  { desc: "nGt then text", html: "&nGt;hello", unescaped: "≫⃒hello" },
  { desc: "text nLt text", html: "a&nLt;b", unescaped: "a≪⃒b" },
  { desc: "multiple nLt", html: "&nLt;&nLt;", unescaped: "≪⃒≪⃒" },
  { desc: "nLt then entity", html: "&nLt;&lt;", unescaped: "≪⃒<" },
  { desc: "nLt nGt seq", html: "&nLt;&nGt;", unescaped: "≪⃒≫⃒" },
];

describe("escape", () => {
  for (const tt of unescapeTests) {
    test(`TestUnescape ${tt.desc}`, () => {
      expect(unescapeString(tt.html)).toBe(tt.unescaped);
    });
  }

  test("TestUnescapeEscape", () => {
    const ss = [
      ``,
      `abc def`,
      `a & b`,
      `a&amp;b`,
      `a &amp b`,
      `&quot;`,
      `"`,
      `"<&>"`,
      `&quot;&lt;&amp;&gt;&quot;`,
      `3&5==1 && 0<1, "0&lt;1", a+acute=&aacute;`,
      `The special characters are: <, >, &, ' and "`,
    ];
    for (const s of ss) {
      expect(unescapeString(escapeString(s))).toBe(s);
    }
  });
});

test("TestEntityLength", () => {
  // Every entity name without a semicolon is at most longestEntityWithoutSemicolon bytes long.
  for (const k of entity.keys()) {
    if (k.length > longestEntityWithoutSemicolon && !k.endsWith(";")) {
      throw new Error(
        `entity name ${k} is ${k.length} characters, but longestEntityWithoutSemicolon=${longestEntityWithoutSemicolon}`,
      );
    }
  }
});

// Keep describe imported for grouping in the test report.
void describe;
