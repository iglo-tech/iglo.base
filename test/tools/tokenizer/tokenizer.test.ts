// Upstream: tools/tokenizer/tokenizer_test.go

import { describe, expect, test } from "bun:test";
import { DefaultSeparators, Tokenizer } from "@/tools/tokenizer/tokenizer";

// The Go test inspects the unexported reader, keepSeparator,
// ignoreParenthesis and separators fields; here the same defaults are
// checked through the observable tokens instead.
describe("Factories", () => {
  const expectedContent = "test";

  const scenarios: { name: string; create: (str: string) => Tokenizer }[] = [
    { name: "New()", create: (str) => new Tokenizer(str) },
    { name: "NewFromString()", create: (str) => Tokenizer.fromString(str) },
    // NewFromBytes maps to fromString (the bytes are the string here)
    { name: "NewFromBytes()", create: (str) => Tokenizer.fromString(str) },
  ];

  for (const s of scenarios) {
    describe(s.name, () => {
      test("reads the provided content", () => {
        expect(s.create(expectedContent).scanAll()).toEqual([expectedContent]);
      });

      test("does not keep the separators by default", () => {
        expect(s.create("a,b").scanAll()).toEqual(["a", "b"]);
      });

      test("does not ignore the parenthesis by default", () => {
        expect(s.create("(a,b)").scanAll()).toEqual(["(a,b)"]);
      });

      test("uses the default separators", () => {
        for (const sep of DefaultSeparators) {
          expect(s.create(`a${sep}b`).scanAll()).toEqual(["a", "b"]);
        }
      });
    });
  }
});

describe("Scan", () => {
  test("returns the tokens in order and then null at the end", () => {
    const tk = Tokenizer.fromString("abc, 123.456, (abc)");

    const expectedTokens = ["abc", "123.456", "(abc)"];

    for (const token of expectedTokens) {
      expect(tk.scan()).toBe(token);
    }

    // scan the last character
    expect(tk.scan()).toBeNull();
  });
});

describe("ScanAll", () => {
  const scenarios: {
    name: string;
    content: string;
    separators: string[];
    keepSeparator: boolean;
    keepEmptyTokens: boolean;
    ignoreParenthesis: boolean;
    expectError: boolean;
    expectTokens: string[];
  }[] = [
    {
      name: "empty string",
      content: "",
      separators: [...DefaultSeparators],
      keepSeparator: false,
      keepEmptyTokens: false,
      ignoreParenthesis: false,
      expectError: false,
      expectTokens: [],
    },
    {
      name: "unbalanced parenthesis",
      content: `(a,b() c`,
      separators: [...DefaultSeparators],
      keepSeparator: false,
      keepEmptyTokens: false,
      ignoreParenthesis: false,
      expectError: true,
      expectTokens: [],
    },
    {
      name: "unmatching quotes",
      content: `'asd"`,
      separators: [...DefaultSeparators],
      keepSeparator: false,
      keepEmptyTokens: false,
      ignoreParenthesis: false,
      expectError: true,
      expectTokens: [],
    },
    {
      name: "no separators",
      content: `a, b, c, d, e 123, "abc"`,
      separators: [],
      keepSeparator: false,
      keepEmptyTokens: false,
      ignoreParenthesis: false,
      expectError: false,
      expectTokens: [`a, b, c, d, e 123, "abc"`],
    },
    {
      name: "default separators",
      content: 'a, b , c  , d e  , "a,b,  c  " , ,, ,\t  (123, 456)\n\t\t\t',
      separators: [...DefaultSeparators],
      keepSeparator: false,
      keepEmptyTokens: false,
      ignoreParenthesis: false,
      expectError: false,
      expectTokens: ["a", "b", "c", "d e", `"a,b,  c  "`, `(123, 456)`],
    },
    {
      name: "keep separators",
      content: 'a, b, c, d  e, "a,b,  c  ",\t(123, 456)',
      // the space should be removed from the cutset
      separators: [",", " "],
      keepSeparator: true,
      keepEmptyTokens: true,
      ignoreParenthesis: false,
      expectError: false,
      expectTokens: [
        "a,",
        " ",
        "b,",
        " ",
        "c,",
        " ",
        "d ",
        " ",
        "e,",
        " ",
        `"a,b,  c  ",`,
        `(123, 456)`,
      ],
    },
    {
      name: "custom separators",
      content: `a | b c  d &(e + f) &  "g & h" & & &`,
      separators: ["|", "&"],
      keepSeparator: false,
      keepEmptyTokens: false,
      ignoreParenthesis: false,
      expectError: false,
      expectTokens: ["a", "b c  d", "(e + f)", `"g & h"`],
    },
    {
      name: "ignoring parenthesis",
      content: `a, b, (c,d)`,
      separators: [...DefaultSeparators],
      keepSeparator: false,
      keepEmptyTokens: false,
      ignoreParenthesis: true,
      expectError: false,
      expectTokens: ["a", "b", "(c", "d)"],
    },
    {
      name: "keep empty tokens",
      content: `a, b, (c, d), ,, , e, , f`,
      separators: [...DefaultSeparators],
      keepSeparator: false,
      keepEmptyTokens: true,
      ignoreParenthesis: false,
      expectError: false,
      expectTokens: ["a", "b", "(c, d)", "", "", "", "e", "", "f"],
    },
  ];

  for (const s of scenarios) {
    test(s.name, () => {
      const tk = Tokenizer.fromString(s.content);

      tk.setSeparators(...s.separators);
      tk.keepSeparator(s.keepSeparator);
      tk.keepEmptyTokens(s.keepEmptyTokens);
      tk.ignoreParenthesis(s.ignoreParenthesis);

      let tokens: string[] = [];
      let hasErr = false;
      try {
        tokens = tk.scanAll();
      } catch {
        hasErr = true;
      }

      expect(hasErr).toBe(s.expectError);

      expect(tokens.length).toBe(s.expectTokens.length);

      for (const tok of tokens) {
        expect(s.expectTokens).toContain(tok);
      }
    });
  }
});

// The Go test reads the unexported trimCutset. The cutset is observable
// through trimming: whitespace characters that are not separators are
// trimmed from the tokens, and separators are not.
describe("TrimCutset", () => {
  test("default factory separators", () => {
    // every default cutset character is trimmed from the token edges
    const ws = "\t\n\v\f\r \u0085 ";
    expect(Tokenizer.fromString(`${ws}abc${ws}`).scanAll()).toEqual(["abc"]);
  });

  test("custom separators", () => {
    // the tab is a separator here, so it is not trimmed: it splits the
    // tokens, leaving an empty token before "abc" when kept
    const tk = Tokenizer.fromString("\tabc");
    tk.setSeparators("\t", " ", "\r", ",");
    tk.keepEmptyTokens(true);
    expect(tk.scanAll()).toEqual(["", "abc"]);

    // the remaining cutset characters are still trimmed
    const tk2 = Tokenizer.fromString("\n\v\f\u0085 abc\n\v\f\u0085 ");
    tk2.setSeparators("\t", " ", "\r", ",");
    expect(tk2.scanAll()).toEqual(["abc"]);
  });
});
