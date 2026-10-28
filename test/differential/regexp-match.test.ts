// Go regexp matching (src/tools/regexp/regexp.ts) against the reference
// PocketBase v0.41.0 binary. Not part of `bun test`: run
// `bun run test:reference`.
//
// Upstream checks a text field value against the field's `pattern` with
// regexp.MatchString(f.Pattern, value) (core/field_text.go) and answers a
// record create whose value does not match with the field error
// validation_invalid_format. For each pattern the test creates a
// collection with such a field on a fresh install, creates a record with
// each value, and compares upstream's accept or reject decision with
// iglo.base's matchString. Values are non-empty (an empty value skips the
// pattern) and valid UTF-8 (they travel as JSON).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runUpstream } from "@test/differential/db/fixture";
import { startUpstream, type UpstreamServer } from "@test/support/upstream";

import { matchString } from "@/tools/regexp/regexp";

const email = "regexp@example.com";
const password = "1234567890";

// pattern, then the values to create records with
const cases: [string, string[]][] = [
  // Unicode classes
  [String.raw`^\p{L}+$`, ["Zażółć", "abc1", "日本語"]],
  [String.raw`^\p{Greek}+$`, ["αβγ", "αβc"]],
  [String.raw`^\pN+$`, ["١٢٣", "12a"]],
  [String.raw`^\P{L}+$`, ["123 !", "12a"]],
  [String.raw`^\pL$`, ["é", "é"]],
  [String.raw`^\d+$`, ["123", "١٢٣"]],
  [String.raw`^\s$`, [" ", " "]],
  ["^[[:alpha:]]+$", ["abc", "abcé"]],
  // case folding
  ["(?i)^straße$", ["STRAßE", "STRASSE"]],
  ["(?i)k", ["K", "x"]],
  ["(?i)^σ$", ["ς", "Σ", "s"]],
  ["(?i)^ǅ$", ["ǆ", "Ǆ"]],
  ["(?i)^[a-z]+$", ["ABCſ", "ABC1"]],
  // word boundaries (ASCII only)
  [String.raw`\bfoo\b`, ["a foo b", "afoob", "é foo"]],
  ["\\bé", ["é", "a é"]],
  [String.raw`\Bfoo`, ["afoo", "a foo"]],
  // anchors and multiline flags
  ["^abc$", ["abc", "abc\n", "xabc"]],
  [String.raw`\Aabc\z`, ["abc", "abc\n"]],
  ["(?m)^b$", ["a\nb\nc", "ab"]],
  ["^b$", ["a\nb\nc"]],
  ["(?s)a.b", ["a\nb"]],
  ["a.b", ["a\nb", "axb"]],
  ["^[^a]$", ["\n", "a"]],
  // empty alternatives
  ["^(|a)$", ["a"]],
  ["^(a|)b$", ["b", "ab", "aab"]],
  ["^(?:|x|y)z$", ["z", "yz", "xyz"]],
  // astral characters
  ["^.$", ["😀", "ab"]],
  ["^..$", ["😀", "a😀"]],
  ["^[😀-😂]$", ["😁", "😃"]],
  [String.raw`^\x{1F600}$`, ["😀"]],
  [String.raw`^\p{So}+$`, ["😀♥", "😀a"]],
  // repetition, literals, unanchored
  ["^a{2,3}$", ["aa", "aaaa"]],
  ["^(a+)+$", ["a".repeat(29) + "b", "a".repeat(30)]],
  [String.raw`^\Qa.b\E$`, ["a.b", "axb"]],
  ["foo", ["xfoox", "fo"]],
  [String.raw`^[\w.+-]+@[\w-]+(\.[\w-]+)+$`, ["a.b+c@example.com", "a@b", "a b@example.com"]],
  ["^[a-z0-9]{15}$", ["abcdefghij12345", "abcdefghij1234"]],
  // about 30,000 empty-width instructions in a row at one position
  ["(?:a??){1000}".repeat(30) + "b", ["b", "c"]],
];

let upstream: UpstreamServer;
let root: string;
let token: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "iglo-base-regexp-match-"));
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

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${upstream.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: token },
    body: JSON.stringify(body),
  });
}

// whether upstream accepts value for a text field with this pattern
async function upstreamAccepts(collection: string, value: string): Promise<boolean> {
  const res = await post(`/api/collections/${collection}/records`, { v: value });
  if (res.status === 200) {
    return true;
  }
  expect(res.status).toBe(400);
  const body = (await res.json()) as { data?: { v?: { code?: string } } };
  expect(body.data?.v?.code).toBe("validation_invalid_format");
  return false;
}

describe("text field pattern", () => {
  cases.forEach(([pattern, values], i) => {
    test(`${i}_${JSON.stringify(pattern)}`, async () => {
      const collection = `match${i}`;
      const res = await post("/api/collections", {
        name: collection,
        type: "base",
        fields: [{ name: "v", type: "text", pattern }],
      });
      expect({ status: res.status, body: res.status === 200 ? null : await res.json() }).toEqual({
        status: 200,
        body: null,
      });
      for (const value of values) {
        const want = await upstreamAccepts(collection, value);
        expect({ value, accepted: matchString(pattern, value) }).toEqual({
          value,
          accepted: want,
        });
      }
    });
  });

  test("the sample is large enough", () => {
    expect(cases.reduce((n, [, values]) => n + values.length, 0)).toBeGreaterThanOrEqual(30);
  });
});
