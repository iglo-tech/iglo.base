// Smoke cases for the router (M0.3): the same raw HTTP requests against the
// reference PocketBase v0.41.0 binary and the compiled iglo.base executable,
// comparing status, body, Location, Content-Type and the security headers.
// The full differential harness is M0.5. Not part of `bun test`: run
// `bun run test:reference`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { startServer, tempDir, type RunningServer } from "@test/support/executable";
import { rawRequest, type RawResponse } from "@test/support/raw-http";
import { startUpstream, type UpstreamServer } from "@test/support/upstream";

let upstream: UpstreamServer;
let iglo: RunningServer;

beforeAll(async () => {
  [upstream, iglo] = await Promise.all([
    startUpstream(),
    startServer([], join(tempDir(), "pb_data")),
  ]);
});

afterAll(async () => {
  await Promise.all([upstream?.stop(), iglo?.stop()]);
});

const comparedHeaders = [
  "content-type",
  "location",
  "x-xss-protection",
  "x-content-type-options",
  "x-frame-options",
  "cross-origin-opener-policy",
];

function normalize(res: RawResponse): unknown {
  let body: unknown = res.body;
  try {
    body = JSON.parse(res.body);
  } catch {
    // not JSON: compared as text
  }
  return {
    status: res.status,
    headers: Object.fromEntries(comparedHeaders.map((h) => [h, res.headers.get(h)])),
    body,
  };
}

async function compare(method: string, target: string): Promise<void> {
  const [want, got] = await Promise.all([
    rawRequest(upstream.url, method, target),
    rawRequest(iglo.url, method, target),
  ]);
  expect(normalize(got)).toEqual(normalize(want));
}

const cases: [string, string][] = [
  ["GET", "/api/health"],
  ["HEAD", "/api/health"],
  ["GET", "/api/health?x=1"],
  ["GET", "/api/missing"],
  ["HEAD", "/api/missing"],
  ["GET", "/api/health/"],
  ["POST", "/api/missing"],
  ["POST", "/api/health"],
  ["DELETE", "/api/health"],
  ["GET", "//api/health"],
  ["HEAD", "//api/health"],
  ["POST", "//api/health"],
  ["GET", "/api//health?a=b"],
  ["GET", "/api%2Fhealth"],
  ["GET", "/api/hea%6Cth"],
  ["GET", "/a%zz"],
];

describe("router", () => {
  for (const [method, target] of cases) {
    test(`${method} ${target}`, () => compare(method, target));
  }

  // Deliberate difference D22 (docs/design/04-api-compatibility.md):
  // Bun.serve resolves "." and ".." segments (also %2e%2e) before the handler
  // sees the request, so iglo.base answers the resolved path directly where
  // upstream redirects to the clean path (or, for %2e%2e, does not match).
  // Each case checks both sides of the recorded difference.
  const dotSegments: [string, string, string, number][] = [
    ["GET", "/api/../api/health", "/api/health", 307],
    ["GET", "/api/health/.", "/api/health/", 307],
    ["GET", "/./api/health", "/api/health", 307],
    ["GET", "/x/%2e%2e/api/health", "/api/health", 404],
  ];
  for (const [method, target, resolved, upstreamStatus] of dotSegments) {
    test(`${method} ${target} (D22: answered as ${resolved})`, async () => {
      const [want, got, gotResolved] = await Promise.all([
        rawRequest(upstream.url, method, target),
        rawRequest(iglo.url, method, target),
        rawRequest(iglo.url, method, resolved),
      ]);
      expect(want.status).toBe(upstreamStatus);
      expect(normalize(got)).toEqual(normalize(gotResolved));
    });
  }
});
