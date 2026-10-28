// Upstream: tools/security/random_test.go

import { describe, expect, test } from "bun:test";

import {
  pseudorandomString,
  pseudorandomStringWithAlphabet,
  randomString,
  randomStringWithAlphabet,
} from "@/tools/security/random";

function testRandomStringWithAlphabet(randomFunc: (n: number, alphabet: string) => string): void {
  const scenarios: [string, RegExp][] = [
    ["0123456789_", /^[0-9_]+$/],
    ["abcdef123", /^[abcdef123]+$/],
    ["!@#$%^&*()", /^[!@#$%^&*()]+$/],
  ];

  scenarios.forEach(([alphabet, expectPattern], i) => {
    test(`${i}_${JSON.stringify(alphabet)}`, () => {
      const generated = new Set<string>();
      const length = 10;
      for (let j = 0; j < 500; j++) {
        for (let attempt = 1; ; attempt++) {
          const result = randomFunc(length, alphabet);
          expect(result).toHaveLength(length);
          expect(result).toMatch(expectPattern);
          if (!generated.has(result)) {
            generated.add(result);
            break;
          }
          // rerun on a repeat, as upstream
          expect(attempt).toBeLessThanOrEqual(3);
        }
      }
    });
  });
}

function testRandomString(randomFunc: (n: number) => string): void {
  test("500 unique [a-zA-Z0-9] strings", () => {
    const generated = new Set<string>();
    const length = 10;
    for (let i = 0; i < 500; i++) {
      for (let attempt = 1; ; attempt++) {
        const result = randomFunc(length);
        expect(result).toHaveLength(length);
        expect(result).toMatch(/^[a-zA-Z0-9]+$/);
        if (!generated.has(result)) {
          generated.add(result);
          break;
        }
        expect(attempt).toBeLessThanOrEqual(3);
      }
    }
  });
}

describe("RandomString", () => {
  testRandomString(randomString);
});

describe("RandomStringWithAlphabet", () => {
  testRandomStringWithAlphabet(randomStringWithAlphabet);
});

describe("PseudorandomString", () => {
  testRandomString(pseudorandomString);
});

describe("PseudorandomStringWithAlphabet", () => {
  testRandomStringWithAlphabet(pseudorandomStringWithAlphabet);
});

// Not in upstream's tests: every alphabet character is reachable.
describe("RandomStringWithAlphabet coverage", () => {
  test("uses the whole default alphabet", () => {
    const seen = new Set(randomString(20000));
    expect(seen.size).toBe(62);
  });
});
