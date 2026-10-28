// Upstream: tools/security/random_by_regex_test.go
//
// Upstream checks each generated string with Go's regexp (an unanchored
// match). Here each tested pattern has a hand-written JS RegExp equivalent,
// anchored with ^…$ and using the u flag (so it matches code points as Go
// matches runes); that is stricter than upstream's check. \d and \w are
// ASCII-only in both Go and JS.

import { describe, expect, test } from "bun:test";

import { FoldCase, Literal, POSIX, RegexpSyntaxError } from "@/tools/regexp/syntax/parse";
import { randomStringByRegex } from "@/tools/security/random-by-regex";

describe("TestRandomStringByRegex", () => {
  const generated: string[] = [];

  const scenarios: [pattern: string, flags: number[], expectError: boolean, match?: RegExp][] = [
    ["", [], true],
    ["test", [], false, /^test$/u],
    ["\\d+", [POSIX], true],
    ["\\d+", [], false, /^\d+$/u],
    ["\\d*", [], false, /^\d*$/u],
    ["\\d{1,20}", [], false, /^\d{1,20}$/u],
    ["\\d{5}", [], false, /^\d{5}$/u],
    ["\\d{0,}-abc", [], false, /^\d{0,}-abc$/u],
    ["[a-zA-Z_]*", [], false, /^[a-zA-Z_]*$/u],
    ["[^a-zA-Z]{5,30}", [], false, /^[^a-zA-Z]{5,30}$/u],
    ["\\w+_abc", [], false, /^\w+_abc$/u],
    ["[2-9]{10}-\\w+", [], false, /^[2-9]{10}-\w+$/u],
    ["(a|b|c)", [], false, /^(a|b|c)$/u],
  ];

  scenarios.forEach(([pattern, flags, expectError, match], i) => {
    test(`${i}_${JSON.stringify(pattern)}`, () => {
      const run = (attempt: number): void => {
        let str = "";
        let hasErr = false;
        try {
          str = randomStringByRegex(pattern, ...flags);
        } catch {
          hasErr = true;
        }
        expect(hasErr).toBe(expectError);
        if (hasErr) {
          return;
        }

        expect(str).toMatch(match as RegExp);

        if (generated.includes(str)) {
          if (attempt > 3) {
            throw new Error(
              `The generated string ${JSON.stringify(str)} already exists in\n${generated}`,
            );
          }

          // rerun
          run(attempt + 1);
          return;
        }

        generated.push(str);
      };

      run(1);
    });
  });
});

// lengths seen over many runs
function lengths(pattern: string, runs = 500): Set<number> {
  const seen = new Set<number>();
  for (let i = 0; i < runs; i++) {
    seen.add([...randomStringByRegex(pattern)].length);
  }
  return seen;
}

describe("random_by_regex.go behavior", () => {
  test("parse errors are Go's", () => {
    expect(() => randomStringByRegex("a(b")).toThrow(RegexpSyntaxError);
    expect(() => randomStringByRegex("a(b")).toThrow(
      "error parsing regexp: missing closing ): `a(b`",
    );
    expect(() => randomStringByRegex("\\d", POSIX)).toThrow(
      "error parsing regexp: invalid escape sequence: `\\d`",
    );
  });

  test("unsupported operators report Go's Op number", () => {
    const cases: [pattern: string, op: number][] = [
      ["", 2], // OpEmptyMatch
      ["a(?:)b", 2],
      ["(?m)^a", 7], // OpBeginLine
      ["a(?m)$", 8], // OpEndLine
      ["^a", 9], // OpBeginText
      ["\\Aa", 9],
      ["a$", 10], // OpEndText
      ["a\\z", 10],
      ["\\ba", 11], // OpWordBoundary
      ["\\Ba", 12], // OpNoWordBoundary
    ];
    for (const [pattern, op] of cases) {
      expect(() => randomStringByRegex(pattern)).toThrow(`unsupported pattern operator ${op}`);
    }
    expect(() => randomStringByRegex("[^\\x00-\\x{10FFFF}]")).toThrow("no runes to choose from");
  });

  test("repeats: max is exclusive, star and plus stop below defaultMaxRepeat", () => {
    expect(randomStringByRegex("a{3}")).toBe("aaa");
    expect(lengths("a{2,4}")).toEqual(new Set([2, 3]));
    expect(lengths("a*")).toEqual(new Set([0, 1, 2, 3, 4, 5]));
    expect(lengths("a+")).toEqual(new Set([1, 2, 3, 4, 5]));
    expect(lengths("a{4,}")).toEqual(new Set([4, 5]));
    expect(lengths("a{7,}")).toEqual(new Set([7]));
    // Quest is a repeat of 0 to 1, and randomNumber(1) is always 0
    expect(randomStringByRegex("ba?")).toBe("b");
  });

  test("any char picks from the anyCharNotNL pairs", () => {
    for (let i = 0; i < 200; i++) {
      expect(randomStringByRegex("(?s).{5}")).toMatch(/^[A-Za-z0-9]{5}$/);
    }
  });

  test("classes pick from every range", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) {
      seen.add(randomStringByRegex("[ac-d\\x{1F600}]"));
    }
    expect(seen).toEqual(new Set(["a", "c", "d", "\u{1F600}"]));
  });

  test("runes are written as string(rune)", () => {
    // a surrogate rune becomes U+FFFD, in literals and classes
    expect(randomStringByRegex("\\x{D800}")).toBe("\ufffd");
    expect(randomStringByRegex("[\\x{D800}-\\x{D801}]")).toBe("\ufffd");
    expect(randomStringByRegex("a\\x{DFFF}b")).toBe("a\ufffdb");
  });

  test("flags are OR-ed; none means Perl", () => {
    // a FoldCase literal holds the smallest fold-equivalent rune
    expect(randomStringByRegex("a", FoldCase)).toBe("A");
    expect(randomStringByRegex("(?i)k")).toBe("K");
    expect(randomStringByRegex("a.b*", Literal)).toBe("a.b*");
    expect(randomStringByRegex("a.b*", POSIX, Literal)).toBe("a.b*");
    expect(randomStringByRegex("x\\Qa.b\\E")).toBe("xa.b");
  });
});
