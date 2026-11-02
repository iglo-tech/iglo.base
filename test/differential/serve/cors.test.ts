// Upstream: apis/middlewares_cors.go and its binding in apis/serve.go
// (--origins, before the activity logger and the rate limiter), the www
// redirect of apis/serve.go and apis/middlewares.go (wwwRedirect), and
// securityHeaders. Upstream PocketBase v0.41.0 and the compiled iglo.base
// executable get the same requests; every response is compared whole (see
// pair.ts). A preflight under a matching rate limit rule is in
// test/differential/rate-limit/cases.ts. Not part of `bun test`: run `bun
// run test:reference`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { both, startPair, type Pair } from "@test/differential/serve/pair";
import { usersToken } from "@test/scenarios/record-crud";

const timeout = 60_000;

let defaults: Pair;
let restricted: Pair;

beforeAll(async () => {
  [defaults, restricted] = await Promise.all([
    startPair(),
    startPair({
      args: [
        "--origins",
        "https://example.com,https://*.example.org,http://localhost:*,https://app?.example.net",
      ],
    }),
  ]);
}, timeout);

afterAll(async () => {
  await Promise.allSettled([defaults?.stop(), restricted?.stop()]);
});

const preflight = (origin: string): Record<string, string> => ({
  Origin: origin,
  "Access-Control-Request-Method": "PATCH",
  "Access-Control-Request-Headers": "authorization,content-type",
});

type Req = [method: string, target: string, headers?: Record<string, string>];

const origins = [
  "https://example.com",
  "http://example.com",
  "https://a.example.org",
  "https://a.b.example.org",
  "https://example.org",
  "http://localhost:5173",
  "http://localhost",
  "https://app1.example.net",
  "https://app12.example.net",
  "null",
  "file://",
];

const fileURL = "/api/files/_pb_users_auth_/oap640cot4yru2s/test_kfd2wYLxkz.txt";

const requests: Req[] = [
  // preflights
  ["OPTIONS", "/api/health"],
  ["OPTIONS", "/api/collections/users/records", { "Access-Control-Request-Method": "GET" }],
  ...origins.map((o): Req => ["OPTIONS", "/api/collections/users/records", preflight(o)]),
  ["OPTIONS", "/api/collections/users/auth-with-password", { Origin: "https://example.com" }],
  ["OPTIONS", "/api/realtime", preflight("https://example.com")],
  ["OPTIONS", "/missing/path", preflight("https://example.com")],
  ["OPTIONS", "/_/", preflight("https://example.com")],
  ["OPTIONS", fileURL, preflight("https://example.com")],
  [
    "OPTIONS",
    "/api/health",
    { Origin: "https://example.com", "Access-Control-Request-Method": "DELETE" },
  ],
  // simple requests, with and without credentials
  ...origins.map((o): Req => ["GET", "/api/health", { Origin: o }]),
  ["GET", "/api/health", { Origin: "https://example.com", Cookie: "a=b" }],
  ["GET", "/api/health", { Origin: "https://example.com", Authorization: usersToken }],
  ["GET", "/api/collections/users/records", { Origin: "https://example.com" }],
  [
    "GET",
    "/api/collections/users/records?perPage=1",
    { Origin: "https://example.com", Authorization: usersToken },
  ],
  ["GET", "/api/collections/missing/records", { Origin: "https://example.com" }],
  ["POST", "/api/collections/users/auth-with-password", { Origin: "https://example.com" }],
  ["PUT", "/api/health", { Origin: "https://example.com" }],
  ["GET", "/missing", { Origin: "https://example.com" }],
  ["GET", "/missing"],
  ["GET", "/_/images/favicon/favicon.png", { Origin: "https://example.com" }],
  // the file route: Vary and the CORS headers on a file response
  ["GET", fileURL],
  ["GET", fileURL, { Origin: "https://example.com" }],
  ["GET", fileURL, { Origin: "https://example.com", Range: "bytes=0-1" }],
  ["HEAD", fileURL, { Origin: "https://example.com" }],
  // the www redirect: the listener's host is 127.0.0.1
  ["GET", "/api/health?a=1&b=%20", { Host: "www.127.0.0.1" }],
  ["POST", "/api/collections/users/auth-with-password", { Host: "www.127.0.0.1" }],
  ["OPTIONS", "/api/health", { Host: "www.127.0.0.1", Origin: "https://example.com" }],
  ["GET", "/api/health", { Host: "www.127.0.0.1:8090" }],
  ["GET", "/api/health", { Host: "www.example.com" }],
];

describe.each([
  ["--origins default", () => defaults],
  ["--origins set", () => restricted],
])("%s", (_name, pair) => {
  for (const [method, target, headers] of requests) {
    test(`${method} ${target} ${headers ? JSON.stringify(headers).slice(0, 120) : ""}`, async () => {
      // the fixture copies differ in their file modification times
      const { upstream, igloBase } = await both(pair(), method, target, headers, ["last-modified"]);
      // the dashboard build differs (ui/PATCHES.md): its headers only
      if (target.startsWith("/_/")) {
        upstream.body = "";
        igloBase.body = "";
        upstream.headers = upstream.headers.filter((h) => !h.startsWith("content-length"));
        igloBase.headers = igloBase.headers.filter((h) => !h.startsWith("content-length"));
      }
      expect(igloBase).toEqual(upstream);
    });
  }
});
