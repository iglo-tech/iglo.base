// Upstream: Go go1.27.2 src/regexp/syntax/prog_test.go (TestCompile): the
// program dump of Prog.String for each pattern, parsed with Perl flags and
// compiled without Simplify, as Go's test does.

import { describe, expect, test } from "bun:test";

import { Compile } from "@/tools/regexp/syntax/compile";
import { Parse, Perl } from "@/tools/regexp/syntax/parse";

import { compileTests } from "@test/tools/regexp/syntax/prog-tests";

describe("Compile", () => {
  test.each(compileTests)("$regexp", ({ regexp, prog }) => {
    const re = Parse(regexp, Perl);
    expect(Compile(re).toString()).toBe(prog);
  });
});
