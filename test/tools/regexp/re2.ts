// Upstream: Go go1.27.2 src/regexp/exec_test.go (testRE2 and its run and
// match helpers).
//
// testRE2 tests this package's regexp API against test cases
// considered during RE2's exhaustive tests, which run all possible
// regexps over a given set of atoms and operators, up to a given
// complexity, over all possible strings over a given alphabet,
// up to a given size. Rather than try to link with RE2, we read a
// log file containing the test cases and the expected matches.
//
// The test file format is a sequence of stanzas like:
//
//	strings
//	"abc"
//	"123x"
//	regexps
//	"[a-z]+"
//	0-3;0-3
//	-;-
//	"([0-9])([0-9])([0-9])"
//	-;-
//	-;0-3 0-1 1-2 2-3
//
// Go sets re.longest directly; here each regexp is compiled twice, once
// with longest() called. With every > 1 only every n-th regexp of the file
// runs (a deterministic sample); the others are skipped as Go skips a
// regexp that fails to compile.

import { RegexpSyntaxError } from "@/tools/regexp/syntax/parse";
import { compile, type Regexp } from "@/tools/regexp/regexp";

import { unquote } from "@test/tools/regexp/go-quote";

export interface re2Result {
  ncase: number;
  failures: string[];
}

interface compiled {
  re: Regexp;
  longest: Regexp;
}

function compileBoth(expr: string): compiled {
  const re = compile(expr);
  const longest = compile(expr);
  longest.longest();
  return { re, longest };
}

// every rune is ASCII (an invalid byte is not)
function isSingleBytes(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) >= 0x80) {
      return false;
    }
  }
  return true;
}

// testRE2 runs the lines of a test file and returns the number of cases
// and the failures (at most 100, as Go stops there).
export function testRE2(file: string, lines: Iterable<string>, every = 1): re2Result {
  let nregexp = 0;
  let str: string[] = [];
  let input: string[] = [];
  let inStrings = false;
  let re: compiled | null = null;
  let refull: compiled | null = null;
  const failures: string[] = [];
  let ncase = 0;
  let lineno = 0;
  const fail = (msg: string): boolean => {
    failures.push(msg);
    return failures.length >= 100;
  };
  for (const line of lines) {
    lineno++;
    if (line === "") {
      if (lineno > 1) {
        // a trailing newline
        continue;
      }
      throw new Error(`${file}:${lineno}: unexpected blank line`);
    }
    const c = line[0] as string;
    if (c === "#") {
      continue;
    }
    if ("A" <= c && c <= "Z") {
      // Test name.
      continue;
    }
    if (line === "strings") {
      str = [];
      inStrings = true;
    } else if (line === "regexps") {
      inStrings = false;
    } else if (c === '"') {
      const q = unquote(line);
      if (inStrings) {
        str.push(q);
        continue;
      }
      // Is a regexp.
      if (input.length !== 0) {
        throw new Error(`${file}:${lineno}: out of sync: have ${input.length} strings left`);
      }
      if (nregexp++ % every !== 0) {
        re = null;
        continue;
      }
      try {
        re = compileBoth(q);
      } catch (error) {
        re = null;
        if (
          error instanceof RegexpSyntaxError &&
          error.message === "error parsing regexp: invalid escape sequence: `\\C`"
        ) {
          // We don't and likely never will support \C; keep going.
          continue;
        }
        if (fail(`${file}:${lineno}: compile ${q}: ${String(error)}`)) {
          break;
        }
        continue;
      }
      // Fatal because q worked, so this should always work.
      refull = compileBoth(`\\A(?:${q})\\z`);
      input = str;
    } else if (c === "-" || ("0" <= c && c <= "9")) {
      // A sequence of match results.
      ncase++;
      if (re === null || refull === null) {
        // Failed to compile: skip results.
        continue;
      }
      if (input.length === 0) {
        throw new Error(`${file}:${lineno}: out of sync: no input remaining`);
      }
      const text = input[0] as string;
      input = input.slice(1);
      if (!isSingleBytes(text) && re.re.string().includes("\\B")) {
        // RE2's \B considers every byte position,
        // so it sees 'not word boundary' in the
        // middle of UTF-8 sequences. This package
        // only considers the positions between runes,
        // so it disagrees. Skip those cases.
        continue;
      }
      const res = line.split(";");
      if (res.length !== 4) {
        throw new Error(`${file}:${lineno}: have ${res.length} test results, want 4`);
      }
      // runFull, runPartial, runFullLongest, runPartialLongest
      const runs: [Regexp, string][] = [
        [refull.re, "[full]"],
        [re.re, ""],
        [refull.longest, "[full,longest]"],
        [re.longest, "[longest]"],
      ];
      let stop = false;
      for (let i = 0; i < res.length; i++) {
        const [r, suffix] = runs[i] as [Regexp, string];
        const have = r.findStringSubmatchIndex(text);
        const want = parseResult(file, lineno, res[i] as string);
        if (!equal(have, want)) {
          stop = fail(
            `${file}:${lineno}: ${JSON.stringify(re.re.string())}${suffix}.FindSubmatchIndex(${JSON.stringify(text)}) = ${JSON.stringify(have)}, want ${JSON.stringify(want)}`,
          );
          if (stop) {
            break;
          }
          continue;
        }
        const b = r.matchString(text);
        if (b !== (want !== null)) {
          stop = fail(
            `${file}:${lineno}: ${JSON.stringify(re.re.string())}${suffix}.MatchString(${JSON.stringify(text)}) = ${b}, want ${!b}`,
          );
          if (stop) {
            break;
          }
        }
      }
      if (stop) {
        break;
      }
    } else {
      throw new Error(`${file}:${lineno}: out of sync: ${line}`);
    }
  }
  if (failures.length < 100 && input.length !== 0) {
    throw new Error(`${file}:${lineno}: out of sync: have ${input.length} strings left at EOF`);
  }
  return { ncase, failures };
}

function equal(a: readonly number[] | null, b: readonly number[] | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function parseResult(file: string, lineno: number, res: string): number[] | null {
  // A single - indicates no match.
  if (res === "-") {
    return null;
  }
  // Otherwise, a space-separated list of pairs.
  const out: number[] = [];
  for (const pair of res.split(" ")) {
    // - means no submatch.
    if (pair === "-") {
      out.push(-1, -1);
      continue;
    }
    const [loStr = "", hiStr = ""] = pair.split("-");
    const lo = Number.parseInt(loStr, 10);
    const hi = Number.parseInt(hiStr, 10);
    if (Number.isNaN(lo) || Number.isNaN(hi) || lo > hi) {
      throw new Error(`${file}:${lineno}: invalid pair ${pair}`);
    }
    out.push(lo, hi);
  }
  return out;
}
