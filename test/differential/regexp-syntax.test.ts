// Go regexp/syntax error texts (src/tools/regexp/syntax/parse.ts) and
// RandomStringByRegex (src/tools/security/random-by-regex.ts) against the
// reference PocketBase v0.41.0 binary. Not part of `bun test`: run
// `bun run test:reference`.
//
// Upstream checks a text field's autogeneratePattern with validators.IsRegex
// (regexp.Compile, which parses with syntax.Perl: code
// validation_invalid_regex) and then with security.RandomStringByRegex
// (code validation_invalid_autogenerate_pattern), and answers with the error
// text passed through inflector.Sentenize (tools/router/error.go). For each
// pattern the test creates a collection on a fresh install and compares that
// {code, message} with the one built from iglo.base's error. Patterns are
// always parsed with Perl flags there, so POSIX-only errors are covered by
// the unit tests only.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runUpstream } from "@test/differential/db/fixture";
import { startUpstream, type UpstreamServer } from "@test/support/upstream";

import { sentenize } from "@/tools/inflector/inflector";
import { Parse, Perl, RegexpSyntaxError } from "@/tools/regexp/syntax/parse";
import { randomStringByRegex } from "@/tools/security/random-by-regex";

const email = "regexp@example.com";
const password = "1234567890";

// invalid patterns: parse errors, then patterns upstream parses but cannot
// generate from (anchors, word boundaries, empty matches)
const invalidPatterns = [
  "(abc", // missing paren
  "abc)", // unexpected paren
  "x[a-z", // missing bracket
  "*", // missing repeat argument
  "\\Q\\E*",
  "a**", // nested repeat
  "x{2}{3}",
  "x{1001}", // repeat over 1000
  "x{2,1}",
  "((a{100}){100})", // nested repeats over 1000
  "\\8", // bad escape
  "\\xZZ",
  "\\x{110000}",
  "abc\\", // trailing backslash
  "[z-a]", // bad class range
  "\\p{Foo}",
  "[[:foo:]]",
  "(?P<x y>a)", // invalid named capture
  "(?<>a)",
  "(?P<name",
  "(?z)", // bad Perl flag
  "(?i-)",
  "\\C", // any byte
  "(".repeat(1000) + ")".repeat(1000), // nesting depth
  "^abc", // OpBeginText
  "abc$", // OpEndText
  "a\\z",
  "\\bfoo", // OpWordBoundary
  "\\Bfoo", // OpNoWordBoundary
  "(?m)^a", // OpBeginLine
  "a(?m)$", // OpEndLine
  "a(?:)b", // OpEmptyMatch
];

// patterns both accept
const validPatterns = ["[a-z]{5}", "\\p{Greek}{3}", "(?i)abc", "[^a-zA-Z]{5,30}", "\\w+_abc"];

let upstream: UpstreamServer;
let root: string;
let token: string;
let collections = 0;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "iglo-base-regexp-"));
  const dataDir = join(root, "pb_data");
  const upsert = await runUpstream(
    ["superuser", "upsert", email, password, "--dir", dataDir],
    root,
  );
  expect(upsert.exitCode).toBe(0);
  upstream = await startUpstream({ dataDir });
  const res = await fetch(`${upstream.url}/api/collections/_superusers/auth-with-password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identity: email, password }),
  });
  expect(res.status).toBe(200);
  token = ((await res.json()) as { token: string }).token;
});

afterAll(async () => {
  await upstream?.stop();
  rmSync(root, { recursive: true, force: true });
});

interface FieldError {
  code: string;
  message: string;
}

// creates a collection with a text field using pattern as its
// autogeneratePattern; the field's error or null when it was created
async function upstreamPatternError(pattern: string): Promise<FieldError | null> {
  const res = await fetch(`${upstream.url}/api/collections`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: token },
    body: JSON.stringify({
      name: `regexp${++collections}`,
      type: "base",
      fields: [{ name: "title", type: "text", autogeneratePattern: pattern }],
    }),
  });
  const body = (await res.json()) as {
    data?: { fields?: Record<string, { autogeneratePattern?: FieldError }> };
  };
  if (res.status === 200) {
    return null;
  }
  expect(res.status).toBe(400);
  const fields = Object.values(body.data?.fields ?? {});
  const error = fields.find((field) => field.autogeneratePattern !== undefined);
  expect(error).toBeDefined();
  return error?.autogeneratePattern ?? null;
}

// the same check with iglo.base's parser and generator
function igloPatternError(pattern: string): FieldError | null {
  try {
    Parse(pattern, Perl);
  } catch (error) {
    expect(error).toBeInstanceOf(RegexpSyntaxError);
    return { code: "validation_invalid_regex", message: sentenize((error as Error).message) };
  }
  try {
    randomStringByRegex(pattern);
  } catch (error) {
    return {
      code: "validation_invalid_autogenerate_pattern",
      message: sentenize((error as Error).message),
    };
  }
  return null;
}

describe("invalid autogeneratePattern", () => {
  invalidPatterns.forEach((pattern, i) => {
    test(`${i}_${JSON.stringify(pattern.slice(0, 40))}`, async () => {
      const want = await upstreamPatternError(pattern);
      expect(want).not.toBeNull();
      expect(igloPatternError(pattern)).toEqual(want);
    });
  });
});

describe("valid autogeneratePattern", () => {
  validPatterns.forEach((pattern, i) => {
    test(`${i}_${JSON.stringify(pattern)}`, async () => {
      expect(await upstreamPatternError(pattern)).toBeNull();
      expect(igloPatternError(pattern)).toBeNull();
    });
  });
});
