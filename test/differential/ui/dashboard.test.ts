// Differential cases for the dashboard routes (apis/serve.go, apis/base.go
// Static, apis/extensions.go, apis/middlewares_gzip.go): the same requests
// against the reference PocketBase v0.41.0 binary and the compiled iglo.base
// executable, comparing the status, the headers the routes set and the
// bodies. Not part of `bun test`: run `bun run test:reference`.
//
// Normalized:
//   - the dashboard build differs (the ui/PATCHES.md patch set): index.html,
//     the hashed bundle names and the images are compared by headers only;
//     the vendored libraries and fonts are the same files and compared whole;
//   - "Vary: Origin" comes from upstream's CORS middleware, not ported yet
//     (M5.7), and is removed from upstream's Vary;
//   - gzip bodies are compared decompressed, multipart boundaries replaced.
// Marked differences (docs/design/04-api-compatibility.md): with extensions
// registered, upstream's /_/extensions.js and /_/extensions/{name}/* serve
// them; iglo.base has none, which is upstream's "no extensions" case below.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { startServer, tempDir, type RunningServer } from "@test/support/executable";
import { rawRequest } from "@test/support/raw-http";
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
  "accept-ranges",
  "cache-control",
  "content-encoding",
  "content-range",
  "content-security-policy",
  "content-type",
  "cross-origin-opener-policy",
  "location",
  "x-content-type-options",
  "x-frame-options",
];

interface Request {
  method?: string;
  // a path, or a function of the server's index.html for its hashed assets
  path: string | ((indexHtml: string) => string);
  headers?: Record<string, string>;
  // compare the body (the same file in both builds, or no file)
  body?: boolean;
}

async function send(base: string, req: Request): Promise<unknown> {
  let path = req.path;
  if (typeof path === "function") {
    path = path(await (await fetch(`${base}/_/`)).text());
  }
  const res = await fetch(`${base}${path}`, {
    method: req.method ?? "GET",
    headers: req.headers,
    redirect: "manual",
    decompress: false,
  });
  let bytes = new Uint8Array(await res.arrayBuffer());
  const headers: Record<string, string | null> = Object.fromEntries(
    comparedHeaders.map((h) => [h, res.headers.get(h)]),
  );
  headers.vary = (res.headers.get("vary") ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v !== "" && v !== "Origin")
    .join(", ");
  if (res.headers.get("content-encoding") === "gzip" && bytes.length > 0) {
    bytes = new Uint8Array(gunzipSync(bytes));
  }
  let body: string | undefined;
  if (req.body !== false) {
    body = Buffer.from(bytes).toString("latin1");
    const type = headers["content-type"] ?? "";
    const boundary = /boundary=(\w+)/.exec(type)?.[1];
    if (boundary) {
      body = body.replaceAll(boundary, "BOUNDARY");
      headers["content-type"] = type.replace(boundary, "BOUNDARY");
    }
  }
  return { status: res.status, headers, body };
}

async function compare(req: Request): Promise<void> {
  const [want, got] = await Promise.all([send(upstream.url, req), send(iglo.url, req)]);
  expect(got).toEqual(want);
}

const gz = { "Accept-Encoding": "gzip" };
const lib = "/_/libs/tinymce/tinymce.min.js";
const mainScript = (html: string): string =>
  `/_/${/src="\.\/(assets\/index-[\w-]+\.js)"/.exec(html)?.[1]}`;
const mainStyle = (html: string): string =>
  `/_/${/href="\.\/(assets\/index-[\w-]+\.css)"/.exec(html)?.[1]}`;

const cases: [string, Request][] = [
  ["GET /_", { path: "/_" }],
  ["GET /_/", { path: "/_/", body: false }],
  ["GET /_/ gzip", { path: "/_/", headers: gz, body: false }],
  ["HEAD /_/", { method: "HEAD", path: "/_/", body: false }],
  ["GET /_/index.html", { path: "/_/index.html" }],
  ["GET /_/assets", { path: "/_/assets" }],
  ["GET /_/assets/", { path: "/_/assets/" }],
  ["GET /_/libs/", { path: "/_/libs/", headers: gz }],
  ["GET /_/missing.js", { path: "/_/missing.js" }],
  ["GET /_/missing.js gzip", { path: "/_/missing.js", headers: gz }],
  ["GET /_/images/favicon.png/", { path: "/_/images/favicon.png/" }],
  ["GET /_/images/favicon.png", { path: "/_/images/favicon.png", headers: gz, body: false }],
  ["GET /_/images/logo.svg", { path: "/_/images/logo.svg", body: false }],
  ["GET the main script", { path: mainScript, headers: gz, body: false }],
  ["GET the main style", { path: mainStyle, body: false }],
  ["GET a library", { path: lib }],
  ["GET a library gzip", { path: lib, headers: gz }],
  ["HEAD a library", { method: "HEAD", path: lib }],
  ["GET a font", { path: "/_/fonts/remixicon/remixicon.woff2", headers: gz }],
  ["GET a range", { path: lib, headers: { Range: "bytes=0-9" } }],
  ["GET a range gzip", { path: lib, headers: { ...gz, Range: "bytes=10-19" } }],
  ["GET a suffix range", { path: lib, headers: { Range: "bytes=-5" } }],
  ["GET an open range", { path: lib, headers: { Range: "bytes=1000000-" } }],
  ["GET several ranges", { path: lib, headers: { Range: "bytes=0-4, 10-14" } }],
  ["GET a range past the end", { path: lib, headers: { Range: "bytes=99999999-" } }],
  ["GET an invalid range", { path: lib, headers: { Range: "bytes=5-1" } }],
  ["GET a range of another unit", { path: lib, headers: { Range: "items=0-1" } }],
  ["GET If-None-Match *", { path: lib, headers: { "If-None-Match": "*" } }],
  ["GET If-None-Match etag", { path: lib, headers: { "If-None-Match": '"abc"' } }],
  ["GET If-Match etag", { path: lib, headers: { "If-Match": '"abc"' } }],
  ["GET If-Match *", { path: lib, headers: { "If-Match": "*" } }],
  ["GET If-Range", { path: lib, headers: { Range: "bytes=0-9", "If-Range": '"abc"' } }],
  [
    "GET If-Modified-Since",
    { path: lib, headers: { "If-Modified-Since": "Mon, 02 Jan 2006 15:04:05 GMT" } },
  ],
  ["POST /_/", { method: "POST", path: "/_/" }],
  // apis/extensions_test.go
  ["GET /_/extensions.js (no extensions)", { path: "/_/extensions.js" }],
  ["GET /_/extensions.js gzip", { path: "/_/extensions.js", headers: gz }],
  ["HEAD /_/extensions.js", { method: "HEAD", path: "/_/extensions.js" }],
  ["GET /_/extensions/ext1/test.txt (no extensions)", { path: "/_/extensions/ext1/test.txt" }],
  ["GET /_/extensions/ext1/missing", { path: "/_/extensions/ext1/missing" }],
  [
    "GET /_/extensions/ext3%20with%20spaces/test.txt",
    { path: "/_/extensions/ext3%20with%20spaces/test.txt" },
  ],
];

describe("dashboard", () => {
  for (const [name, req] of cases) {
    test(name, () => compare(req));
  }

  for (const target of ["/_/%2e%2e/%2e%2e/etc/passwd", "/_/..%2fapi/health", "/_//libs/"]) {
    test(`raw GET ${target}`, async () => {
      const [want, got] = await Promise.all([
        rawRequest(upstream.url, "GET", target),
        rawRequest(iglo.url, "GET", target),
      ]);
      const pick = (r: typeof want): unknown => ({
        status: r.status,
        location: r.headers.get("location"),
        type: r.headers.get("content-type"),
        body: r.body,
      });
      expect(pick(got)).toEqual(pick(want));
    });
  }
});
