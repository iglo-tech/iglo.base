// Upstream: Go go1.27.2 src/regexp/find_test.go (the string forms of the
// Find functions over findTests) and the findTests-driven tests of
// src/regexp/all_test.go (TestMatch, TestMatchFunction).
//
// Indexes are byte offsets of the UTF-8 encoding; the expected text of a
// match is the bytes between them, decoded back to a string as the
// matcher does (src/tools/regexp/regexp.ts). Go's []byte and io.RuneReader
// variants have no counterpart, except Match.

import { describe, expect, test } from "bun:test";

import { matchString, mustCompile } from "@/tools/regexp/regexp";
import { bytesToText, textToBytes } from "@/tools/types/go-json";

import { findTests, type FindTest } from "@test/tools/regexp/find-tests";

// text[a:b] in Go's byte terms
function slice(text: string, a: number, b: number): string {
  return bytesToText(textToBytes(text).subarray(a, b));
}

// the string of each submatch pair, "" for an unmatched one
function submatchStrings(text: string, submatches: readonly number[]): string[] {
  const out: string[] = [];
  for (let k = 0; k < submatches.length; k += 2) {
    const a = submatches[k] as number;
    out.push(a === -1 ? "" : slice(text, a, submatches[k + 1] as number));
  }
  return out;
}

const cases = findTests.map((t, i) => [i, t] as [number, FindTest]);
const name = "%d";

describe("find", () => {
  test.each(cases)(`Find ${name}`, (_, t) => {
    const re = mustCompile(t.pat);
    expect(re.string()).toBe(t.pat);
  });

  test.each(cases)(`FindString ${name}`, (_, t) => {
    if (t.max === 0) {
      // do not know whether to match or not; skip
      return;
    }
    const result = mustCompile(t.pat).findString(t.text);
    const first = t.matches?.[0];
    // an empty result means no match or an empty match
    expect(result).toBe(first ? slice(t.text, first[0] as number, first[1] as number) : "");
  });

  test.each(cases)(`FindStringIndex ${name}`, (_, t) => {
    if (t.max === 0) {
      return;
    }
    const result = mustCompile(t.pat).findStringIndex(t.text);
    expect(result).toEqual(t.matches ? (t.matches[0] as number[]).slice(0, 2) : null);
  });

  test.each(cases)(`FindAllString ${name}`, (_, t) => {
    const result = mustCompile(t.pat).findAllString(t.text, t.max);
    expect(result).toEqual(
      t.matches?.map((e) => slice(t.text, e[0] as number, e[1] as number)) ?? null,
    );
  });

  test.each(cases)(`FindAllStringIndex ${name}`, (_, t) => {
    const result = mustCompile(t.pat).findAllStringIndex(t.text, t.max);
    expect(result).toEqual(t.matches?.map((e) => e.slice(0, 2)) ?? null);
  });

  test.each(cases)(`FindStringSubmatch ${name}`, (_, t) => {
    if (t.max === 0) {
      return;
    }
    const result = mustCompile(t.pat).findStringSubmatch(t.text);
    expect(result).toEqual(t.matches ? submatchStrings(t.text, t.matches[0] as number[]) : null);
  });

  test.each(cases)(`FindStringSubmatchIndex ${name}`, (_, t) => {
    if (t.max === 0) {
      return;
    }
    const result = mustCompile(t.pat).findStringSubmatchIndex(t.text);
    expect(result).toEqual(t.matches ? (t.matches[0] as number[]) : null);
  });

  test.each(cases)(`FindAllStringSubmatch ${name}`, (_, t) => {
    const result = mustCompile(t.pat).findAllStringSubmatch(t.text, t.max);
    expect(result).toEqual(t.matches?.map((m) => submatchStrings(t.text, m)) ?? null);
  });

  test.each(cases)(`FindAllStringSubmatchIndex ${name}`, (_, t) => {
    const result = mustCompile(t.pat).findAllStringSubmatchIndex(t.text, t.max);
    expect(result).toEqual(t.matches);
  });

  // all_test.go TestMatch
  test.each(cases)(`Match ${name}`, (_, t) => {
    if (t.max === 0) {
      return;
    }
    const re = mustCompile(t.pat);
    const want = (t.matches?.length ?? 0) > 0;
    expect(re.matchString(t.text)).toBe(want);
    // now try bytes
    expect(re.match(textToBytes(t.text))).toBe(want);
  });

  // all_test.go TestMatchFunction (Go's check returns early when the
  // pattern compiles, so it checks nothing; this checks the result, and
  // skips max == 0 cases, whose matches are nil, as TestMatch does)
  test.each(cases)(`MatchFunction ${name}`, (_, t) => {
    if (t.max === 0) {
      return;
    }
    expect(matchString(t.pat, t.text)).toBe((t.matches?.length ?? 0) > 0);
  });
});
