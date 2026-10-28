// Upstream: Go go1.27.2 src/regexp/exec_test.go: TestRE2Search (all of
// testdata/re2-search.txt), TestRE2Exhaustive on a deterministic sample of
// re2-exhaustive.txt (see testdata/README.md), TestFowler, TestLongest and
// TestProgramTooLongForBacktrack.
//
// The full re2-exhaustive.txt runs when RE2_EXHAUSTIVE names the
// decompressed file (bzcat .upstream/deps/go/src/regexp/testdata/
// re2-exhaustive.txt.bz2 > file); it takes minutes, so it is not part of
// `bun test`.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ClassNL, FoldCase, POSIX } from "@/tools/regexp/syntax/parse";
import { Regexp, compile, compilePOSIX, mustCompile, quoteMeta } from "@/tools/regexp/regexp";

import { unquote } from "@test/tools/regexp/go-quote";
import { testRE2 } from "@test/tools/regexp/re2";

const testdata = join(import.meta.dir, "testdata");

// the lines of a file, without building an array of them
function* lines(text: string): Generator<string> {
  let i = 0;
  while (i < text.length) {
    let j = text.indexOf("\n", i);
    if (j < 0) {
      j = text.length;
    }
    yield text.slice(i, j);
    i = j + 1;
  }
}

describe("RE2", () => {
  test("re2-search.txt", () => {
    const res = testRE2(
      "re2-search.txt",
      lines(readFileSync(join(testdata, "re2-search.txt"), "utf8")),
    );
    expect(res.failures).toEqual([]);
    expect(res.ncase).toBe(1888);
  });

  test("re2-exhaustive.txt", () => {
    const bz = spawnSync("bzcat", [join(testdata, "re2-exhaustive.txt.bz2")], {
      encoding: "utf8",
      maxBuffer: 128 << 20,
    });
    expect(bz.status).toBe(0);
    const every = process.env["RE2_EXHAUSTIVE"] === "1" ? 1 : 10;
    const res = testRE2("re2-exhaustive.txt", lines(bz.stdout), every);
    expect(res.failures).toEqual([]);
    expect(res.ncase).toBe(5716884);
  }, 600_000);
});

const notab = compilePOSIX("[^\\t]+");

describe("Fowler", () => {
  for (const file of ["basic.dat", "nullsubexpr.dat", "repetition.dat"]) {
    test(file, () => {
      expect(testFowler(file)).toEqual([]);
    });
  }
});

// testFowler runs the POSIX regular expression tests collected by Glenn
// Fowler (testregex) and returns the failures.
function testFowler(file: string): string[] {
  const failures: string[] = [];
  const data = readFileSync(join(testdata, file), "utf8");
  let lastRegexp = "";
  let lineno = 0;
  for (const line of lines(data)) {
    lineno++;
    // http://www2.research.att.com/~astopen/man/man1/testregex.html
    //
    // INPUT FORMAT
    //   Input lines may be blank, a comment beginning with #, or a test
    //   specification. A specification is five fields separated by one
    //   or more tabs. NULL denotes the empty string and NIL denotes the
    //   0 pointer.
    if (line === "" || line[0] === "#") {
      continue;
    }
    const field = notab.findAllString(line, -1) ?? [];
    if (field.includes("NIL")) {
      continue;
    }
    for (let i = 0; i < field.length; i++) {
      if (field[i] === "NULL") {
        field[i] = "";
      }
    }
    if (field.length === 0) {
      continue;
    }

    //   Field 1: the regex(3) flags to apply, one character per REG_feature
    //   flag. The test is skipped if REG_feature is not supported by the
    //   implementation. If the first character is not [BEASKLP] then the
    //   specification is a global control line. One or more of [BEASKLP] may be
    //   specified; the test will be repeated for each mode.
    let flag = field[0] as string;
    const f0 = flag[0] as string;
    if ("?&|;{}".includes(f0)) {
      // Ignore all the control operators.
      // Just run everything.
      flag = flag.slice(1);
      if (flag === "") {
        continue;
      }
    } else if (f0 === ":") {
      const k = flag.indexOf(":", 1);
      if (k < 0) {
        continue;
      }
      flag = flag.slice(k + 1);
    } else if ("CNT0123456789".includes(f0)) {
      continue;
    }

    // Can check field count now that we've handled the myriad comment formats.
    if (field.length < 4) {
      failures.push(`${file}:${lineno}: too few fields: ${line}`);
      continue;
    }

    // Expand C escapes (a.k.a. Go escapes).
    if (flag.includes("$")) {
      field[1] = unquote(`"${field[1]}"`);
      field[2] = unquote(`"${field[2]}"`);
    }

    //   Field 2: the regular expression pattern; SAME uses the pattern from
    //     the previous specification.
    if (field[1] === "SAME") {
      field[1] = lastRegexp;
    }
    lastRegexp = field[1] as string;

    //   Field 3: the string to match.
    const text = field[2] as string;

    //   Field 4: the test outcome...
    const result = parseFowlerResult(field[3] as string);
    if (result === null) {
      failures.push(`${file}:${lineno}: cannot parse result ${field[3]}`);
      continue;
    }
    const { compiled: shouldCompile, matched: shouldMatch, pos } = result;

    // Run test once for each specified capital letter mode that we support.
    for (const c of flag) {
      let pattern = field[1] as string;
      let syn = POSIX | ClassNL;
      if (c === "E") {
        // extended regexp (what we support)
      } else if (c === "L") {
        // literal
        pattern = quoteMeta(pattern);
      } else {
        continue;
      }

      if (flag.includes("i")) {
        syn |= FoldCase;
      }

      let re: Regexp;
      try {
        re = Regexp.compile(pattern, syn, true);
      } catch {
        if (shouldCompile) {
          failures.push(`${file}:${lineno}: ${pattern} did not compile`);
        }
        continue;
      }
      if (!shouldCompile) {
        failures.push(`${file}:${lineno}: ${pattern} should not compile`);
        continue;
      }
      const match = re.matchString(text);
      if (match !== shouldMatch) {
        failures.push(
          `${file}:${lineno}: ${pattern}.Match(${text}) = ${match}, want ${shouldMatch}`,
        );
        continue;
      }
      let have = re.findStringSubmatchIndex(text);
      if ((have !== null && have.length > 0) !== match) {
        failures.push(
          `${file}:${lineno}: ${pattern}.Match(${text}) = ${match}, but FindSubmatchIndex = ${JSON.stringify(have)}`,
        );
        continue;
      }
      if (have !== null && have.length > pos.length) {
        have = have.slice(0, pos.length);
      }
      if (JSON.stringify(have ?? []) !== JSON.stringify(pos)) {
        failures.push(
          `${file}:${lineno}: ${pattern}.FindSubmatchIndex(${text}) = ${JSON.stringify(have)}, want ${JSON.stringify(pos)}`,
        );
      }
    }
  }
  return failures;
}

function parseFowlerResult(
  s: string,
): { compiled: boolean; matched: boolean; pos: number[] } | null {
  //   Field 4: the test outcome. This is either one of the posix error
  //     codes (with REG_ omitted) or the match array, a list of (m,n)
  //     entries with m and n being first and last+1 positions in the
  //     field 3 string, or NULL if REG_NOSUB is in effect and success
  //     is expected. BADPAT is acceptable in place of any regcomp(3)
  //     error code. Unspecified endpoints (offset -1) are denoted by ?.
  if (s === "") {
    // Match with no position information.
    return { compiled: true, matched: true, pos: [] };
  }
  if (s === "NOMATCH") {
    // Match failure.
    return { compiled: true, matched: false, pos: [] };
  }
  if ("A" <= (s[0] as string) && (s[0] as string) <= "Z") {
    // All the other error codes are compile errors.
    return { compiled: false, matched: false, pos: [] };
  }

  const x: number[] = [];
  while (s !== "") {
    let end = ")";
    if (x.length % 2 === 0) {
      if (s[0] !== "(") {
        return null;
      }
      s = s.slice(1);
      end = ",";
    }
    const i = s.indexOf(end);
    if (i <= 0) {
      return null;
    }
    let v = -1;
    if (s.slice(0, i) !== "?") {
      v = Number.parseInt(s.slice(0, i), 10);
      if (!/^[+-]?\d+$/.test(s.slice(0, i))) {
        return null;
      }
    }
    x.push(v);
    s = s.slice(i + 1);
  }
  if (x.length % 2 !== 0) {
    return null;
  }
  return { compiled: true, matched: true, pos: x };
}

test("Longest", () => {
  const re = compile("a(|b)");
  expect(re.findString("ab")).toBe("a");
  re.longest();
  expect(re.findString("ab")).toBe("ab");
});

// a regex which is too long for Go's backtracker still executes properly
test("ProgramTooLongForBacktrack", () => {
  const longRegex = mustCompile(
    "(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|twentyone|twentytwo|twentythree|twentyfour|twentyfive|twentysix|twentyseven|twentyeight|twentynine|thirty|thirtyone|thirtytwo|thirtythree|thirtyfour|thirtyfive|thirtysix|thirtyseven|thirtyeight|thirtynine|forty|fortyone|fortytwo|fortythree|fortyfour|fortyfive|fortysix|fortyseven|fortyeight|fortynine|fifty|fiftyone|fiftytwo|fiftythree|fiftyfour|fiftyfive|fiftysix|fiftyseven|fiftyeight|fiftynine|sixty|sixtyone|sixtytwo|sixtythree|sixtyfour|sixtyfive|sixtysix|sixtyseven|sixtyeight|sixtynine|seventy|seventyone|seventytwo|seventythree|seventyfour|seventyfive|seventysix|seventyseven|seventyeight|seventynine|eighty|eightyone|eightytwo|eightythree|eightyfour|eightyfive|eightysix|eightyseven|eightyeight|eightynine|ninety|ninetyone|ninetytwo|ninetythree|ninetyfour|ninetyfive|ninetysix|ninetyseven|ninetyeight|ninetynine|onehundred)",
  );
  expect(longRegex.matchString("two")).toBe(true);
  expect(longRegex.matchString("xxx")).toBe(false);
});
