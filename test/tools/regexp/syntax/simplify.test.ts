// Upstream: Go go1.27.2 src/regexp/syntax/simplify_test.go (TestSimplify):
// the String form of Simplify's result, parsed with MatchNL|Perl&^OneLine.

import { describe, expect, test } from "bun:test";

import { MatchNL, OneLine, Parse, Perl } from "@/tools/regexp/syntax/parse";
import { Simplify } from "@/tools/regexp/syntax/simplify";

import { simplifyTests } from "@test/tools/regexp/syntax/simplify-tests";

describe("Simplify", () => {
  test.each(simplifyTests)("$regexp", ({ regexp, simple }) => {
    const re = Parse(regexp, MatchNL | (Perl & ~OneLine));
    expect(Simplify(re)?.toString()).toBe(simple);
  });
});
