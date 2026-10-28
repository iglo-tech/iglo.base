// The ported ozzo-validation `is` rules (src/validation/is/rules.ts)
// against the reference PocketBase v0.41.0 binary. Not part of `bun test`:
// run `bun run test:reference`.
//
// A fresh install gets a collection with an email, a url and a json field,
// and records are created with each value. Upstream's field validation
// (core/field_email.go, field_url.go, field_json.go) decides with the rules
// ported here:
//   - email: is.EmailFormat; a reject is the rule's own error in the
//     response body (code and message, sentenized);
//   - url: is.URL; a reject is the field's error validation_invalid_url;
//   - json: is.JSON, in JSONField.PrepareValue: a string value that starts
//     like a JSON value and passes is.JSON is kept as raw JSON, any other
//     string is stored quoted (no error body for a reject). A kept value
//     may still fail the field's extra encoding/json/v2 check (a 400
//     validation_invalid_json), which also means is.JSON accepted it.
//   - onlyDomains and exceptDomains (the email field settings): Each(is.Domain)
//     in EmailField.ValidateSettings; a collection create reports each
//     rejected domain by its index with the rule's error.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runUpstream } from "@test/differential/db/fixture";
import { startUpstream, type UpstreamServer } from "@test/support/upstream";

import { sentenize } from "@/server/error";
import type { Error as ValidationError } from "@/validation/error";
import { Domain, EmailFormat, JSON as JSONRule, URL } from "@/validation/is/rules";

const email = "rules@example.com";
const password = "1234567890";

const emails = [
  "test@example.com",
  "a.b+c@d.co",
  "UPPER@EXAMPLE.COM",
  "a@b",
  "a@b.c",
  '"quoted"@example.com',
  '"quo ted"@example.com',
  "a b@c.com",
  "ünïcödé@例え.jp",
  "a@-b.com",
  "a@b-.com",
  "a..b@c.com",
  ".a@b.com",
  "a@b.com.",
  "a@b_c.com",
  "a@[1.2.3.4]",
  "user@localhost",
  "a@b.c1",
  "a@1.2.3.4",
  "test@ex~ample.com",
  "a@b..com",
  "@b.com",
  "a@",
  "a@b@c.com",
  "x!#$%&'*+/=?^_`{|}~@example.com",
];

const urls = [
  "http://example.com",
  "examplecom",
  "https://example.com/path?q=1#frag",
  "http://a:b:80",
  "http://example.com:8080",
  "http://example.com:99999",
  "http://[::1]:80",
  "http://[1.2.3.4]/",
  "http://[fe80::1%25en0]/",
  "ftp://files.example.com",
  "mailto:a@b.com",
  ".example.com",
  "example.com/path",
  "localhost:8080",
  "abc.de:1234",
  "http://user:p@ss@example.com",
  "http://ex ample.com",
  "http://例子.测试",
  "http://xn--fsqu00a.xn--0zwm56d",
  "http://a.b?x=y#frag%zz",
  "http://a.b/%zz",
  "http://a.b/%41",
  "//example.com",
  "http://-a.com",
  "https://a_b.com",
  "http://1.2.3.4",
  "http://256.1.1.1",
  "http://.com",
  "x:1",
  "wss://socket.example.com/ws",
];

const jsons = [
  "[1, 2]",
  "[1, 2,]",
  '{"a":1}',
  '{"a":1,}',
  '{"a":1,"a":2}',
  "1e400",
  "-",
  "-0",
  "01",
  "1.",
  '"abc"',
  '"abc',
  "[1] x",
  "{}",
  "[]",
  "0x10",
  "1e5",
  '["\\u00e9"]',
  '{"a":[1,{"b":null}]}',
  '"\\x"',
  "[1,2]   ",
  "[NaN]",
];

const domains = [
  "example.com",
  "localhost",
  "a.b",
  "xn--fsqu00a.xn--0zwm56d",
  "ex_ample.com",
  "-a.com",
  "a-.com",
  "A.COM",
  "AB.com",
  "例え.jp",
  "a.123",
  "a".repeat(64) + ".com",
  "sub.domain.co.uk",
  "a..com",
  ".a.com",
  "a.com.",
];

let upstream: UpstreamServer;
let root: string;
let token: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "iglo-base-validation-rules-"));
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

  const created = await post("/api/collections", {
    name: "rules",
    type: "base",
    fields: [
      { name: "e", type: "email" },
      { name: "u", type: "url" },
      { name: "j", type: "json" },
    ],
  });
  expect(created.status).toBe(200);
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

interface FieldError {
  code: string;
  message: string;
}

// the API error item of a rule result (tools/router/error.go)
function errorItem(err: ValidationError | null): FieldError | null {
  if (err === null) {
    return null;
  }
  return { code: err.code(), message: sentenize(err.message) };
}

// upstream's answer to a record create with {field: value}: null when
// accepted, else the field's error item
async function createRecord(
  field: string,
  value: string,
): Promise<{ status: number; error: FieldError | null; record: Record<string, unknown> }> {
  const res = await post("/api/collections/rules/records", { [field]: value });
  const body = (await res.json()) as Record<string, unknown> & {
    data?: Record<string, FieldError>;
  };
  if (res.status === 200) {
    return { status: 200, error: null, record: body };
  }
  expect(res.status).toBe(400);
  return { status: 400, error: body.data?.[field] ?? null, record: {} };
}

describe("email field: is.EmailFormat", () => {
  for (const value of emails) {
    test(JSON.stringify(value), async () => {
      const got = await createRecord("e", value);
      expect({
        value,
        error: errorItem(EmailFormat.validate(value) as ValidationError | null),
      }).toEqual({
        value,
        error: got.error,
      });
    });
  }
});

describe("url field: is.URL", () => {
  const invalidURL = { code: "validation_invalid_url", message: "Must be a valid url." };

  for (const value of urls) {
    test(JSON.stringify(value), async () => {
      const got = await createRecord("u", value);
      const err = URL.validate(value) as ValidationError | null;
      if (err !== null) {
        expect(err.code()).toBe("validation_is_url");
      }
      expect({ value, error: err === null ? null : invalidURL }).toEqual({
        value,
        error: got.error,
      });
    });
  }
});

describe("json field: is.JSON", () => {
  for (const value of jsons) {
    test(JSON.stringify(value), async () => {
      const got = await createRecord("j", value);
      // kept as raw JSON (or failed the extra v2 check) unless stored as the
      // quoted string
      const upstreamAccepted =
        got.status === 400 ? got.error?.code === "validation_invalid_json" : got.record.j !== value;
      const err = JSONRule.validate(value) as ValidationError | null;
      if (err !== null) {
        expect(errorItem(err)).toEqual({
          code: "validation_is_json",
          message: "Must be in valid JSON format.",
        });
      }
      expect({ value, accepted: err === null }).toEqual({ value, accepted: upstreamAccepted });
    });
  }
});

describe("email field settings: Each(is.Domain)", () => {
  for (const option of ["onlyDomains", "exceptDomains"]) {
    test(option, async () => {
      const res = await post("/api/collections", {
        name: `domains_${option}`,
        type: "base",
        fields: [{ name: "e", type: "email", [option]: domains }],
      });
      const body = (await res.json()) as {
        data?: { fields?: Record<string, Record<string, Record<string, FieldError>>> };
      };
      // the email field is fields.1 (the id field is added at index 0)
      const got = res.status === 200 ? {} : (body.data?.fields?.["1"]?.[option] ?? {});

      const want: Record<string, FieldError> = {};
      for (const [i, domain] of domains.entries()) {
        const item = errorItem(Domain.validate(domain) as ValidationError | null);
        if (item !== null) {
          want[String(i)] = item;
        }
      }
      expect(Object.keys(want).length).toBeGreaterThan(0);
      expect(got).toEqual(want);
    });
  }
});

test("the sample is large enough", () => {
  expect(emails.length + urls.length + jsons.length + domains.length).toBeGreaterThanOrEqual(60);
});
