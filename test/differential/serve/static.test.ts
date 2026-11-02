// Upstream: apis/base.go (Static), tools/router/event.go (FileFS), Go's
// http.ServeContent, os.DirFS and mime.TypeByExtension, behind the static
// route of examples/base/main.go (--publicDir, --indexFallback). The same
// pb_public directory is served by upstream PocketBase v0.41.0 and the
// compiled iglo.base executable; every response is compared whole (see
// pair.ts). Not part of `bun test`: run `bun run test:reference`.
//
// Not compared, with the reason:
//   - raw targets with ".." segments: upstream redirects them (307), iglo.base
//     answers the normalized path (D22, a deliberate difference); checked
//     here to stay inside the public dir;
//   - a file of over 16 MiB whose type Bun.serve would mark as a download
//     (application/zip, application/octet-stream, ...), and a
//     multipart/byteranges body of over 16 MiB: Bun.serve adds
//     "Content-Disposition: filename=..." to such a streamed file (reported
//     in the M5.7 PR for the lead); checked here for that header only;
//   - Content-Length of a HEAD error response: Go sends none, Bun.serve sends
//     "0" for an empty body (any HEAD error, not only here; backlog).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { both, startPair, type Pair } from "@test/differential/serve/pair";
import { tempDir } from "@test/support/executable";
import { rawRequest } from "@test/support/raw-http";

const timeout = 60_000;

let dir: string;
let pub: string;
let fallback: Pair;
let noFallback: Pair;

function pseudoRandom(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

beforeAll(async () => {
  dir = tempDir();
  pub = join(dir, "pb_public");
  const outside = join(dir, "outside");
  for (const d of ["sub1", "sub2", "emptydir", "dir.d", "deep/a/b"]) {
    mkdirSync(join(pub, d), { recursive: true });
  }
  mkdirSync(outside);
  const files: [string, string | Uint8Array][] = [
    ["index.html", "<!doctype html><title>root index</title>"],
    ["test.txt", "test"],
    ["sub1/index.html", "sub1 index"],
    ["sub2/test.txt", "sub2 test"],
    ["dir.d/index.html", "dir.d index"],
    ["deep/a/b/c.css", "body{}"],
    // sniffed: no extension
    ["noext", "plain text without an extension"],
    ["htmlnoext", "<!DOCTYPE html><p>x"],
    ["binfile", new Uint8Array([0, 1, 2, 3, 0x62, 0x69, 0x6e])],
    ["pngnoext", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])],
    ["pdfnoext", "%PDF-1.4 x"],
    ["empty", ""],
    // Go's table and the system MIME database
    ["a.json", `{"a":1}`],
    ["b.ico", "x"],
    ["c.woff2", "x"],
    ["d.map", "{}"],
    ["e.webmanifest", "{}"],
    ["f.md", "# md"],
    ["G.PNG", "x"],
    ["h.svgz", "x"],
    ["i.mp4", "x"],
    ["j.js", "let a=1"],
    ["k.mjs", "export {}"],
    ["l.wasm", "x"],
    ["m.xml", "<a/>"],
    ["n.svg", "<svg/>"],
    ["o.zip", "PK\x03\x04"],
    ["p.pdf", "%PDF"],
    ["q.unknownext", "text"],
    ["r.tar.gz", "x"],
    ["s.yaml", "a: 1"],
    ["t.wav", "x"],
    ["u.webp", "x"],
    ["v.avif", "x"],
    ["w.csv", "a,b"],
    ["x.xhtml", "<a/>"],
    ["y.ts", "x"],
    ["z.txt.bak", "x"],
    ["a b.txt", "space"],
    ["a%20b.txt", "percent"],
    ["ünï.txt", "unicode"],
    ["..\\x", "backslash name"],
    // a large file of an inline type, streamed
    ["big.png", pseudoRandom(18 << 20, 7)],
    // a large download type (see above)
    ["big.zip", pseudoRandom(17 << 20, 9)],
    // a mid-size download type, read into memory
    ["mid.zip", pseudoRandom(3 << 20, 11)],
  ];
  for (const [name, content] of files) {
    writeFileSync(join(pub, name), content);
  }
  writeFileSync(join(outside, "secret.txt"), "outside secret");
  symlinkSync(join(outside, "secret.txt"), join(pub, "link-out.txt"));
  symlinkSync("test.txt", join(pub, "link-in.txt"));
  symlinkSync(outside, join(pub, "linkdir"));
  symlinkSync("missing", join(pub, "dangling"));
  writeFileSync(join(pub, "unreadable.txt"), "x");
  chmodSync(join(pub, "unreadable.txt"), 0);
  // a fixed modification time for every compared Last-Modified
  const mtime = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));
  for (const [name] of files) {
    utimesSync(join(pub, name), mtime, mtime);
  }

  [fallback, noFallback] = await Promise.all([
    startPair({ args: ["--publicDir", pub] }),
    startPair({ args: ["--publicDir", pub, "--indexFallback=false"] }),
  ]);
}, timeout);

afterAll(async () => {
  await Promise.allSettled([fallback?.stop(), noFallback?.stop()]);
  chmodSync(join(pub, "unreadable.txt"), 0o600);
  rmSync(dir, { recursive: true, force: true });
});

type Req = [method: string, target: string, headers?: Record<string, string>];

const requests: Req[] = [
  // files, index.html and directories
  ["GET", "/"],
  ["GET", "/index.html"],
  ["GET", "/test.txt"],
  ["GET", "/test.txt/"],
  ["GET", "/test.txt//"],
  ["GET", "//test.txt"],
  ["GET", "/sub1"],
  ["GET", "/sub1/"],
  ["GET", "/sub1/index.html"],
  ["GET", "/sub1/index.html/"],
  ["GET", "/sub2"],
  ["GET", "/sub2/"],
  ["GET", "/sub2/test.txt"],
  ["GET", "/emptydir"],
  ["GET", "/emptydir/"],
  ["GET", "/dir.d"],
  ["GET", "/dir.d/"],
  ["GET", "/deep/a/b/c.css"],
  ["GET", "/deep/a/"],
  ["GET", "/deep/a/b/missing.css"],
  ["GET", "/test.txt?x=1"],
  ["GET", "/sub1?x=1"],
  // missing paths, the SPA fallback and the routes before the static one
  ["GET", "/missing"],
  ["GET", "/missing/a/b"],
  ["GET", "/missing.js"],
  ["GET", "/api/unknown"],
  ["GET", "/api/"],
  ["GET", "/api"],
  ["GET", "/api/health"],
  ["GET", "/_"],
  ["GET", "/_/missing"],
  ["POST", "/test.txt"],
  ["DELETE", "/missing"],
  ["HEAD", "/test.txt"],
  ["HEAD", "/missing"],
  // content types: extension tables and sniffing
  ...[
    "/noext",
    "/htmlnoext",
    "/binfile",
    "/pngnoext",
    "/pdfnoext",
    "/empty",
    "/a.json",
    "/c.woff2",
    "/d.map",
    "/e.webmanifest",
    "/f.md",
    "/G.PNG",
    "/h.svgz",
    "/i.mp4",
    "/j.js",
    "/k.mjs",
    "/l.wasm",
    "/m.xml",
    "/n.svg",
    "/o.zip",
    "/p.pdf",
    "/q.unknownext",
    "/r.tar.gz",
    "/s.yaml",
    "/t.wav",
    "/u.webp",
    "/v.avif",
    "/w.csv",
    "/x.xhtml",
    "/y.ts",
    "/z.txt.bak",
    "/mid.zip",
    "/big.png",
  ].map((t): Req => ["GET", t]),
  // names that need escaping
  ["GET", "/a%20b.txt"],
  ["GET", "/a%2520b.txt"],
  ["GET", "/%C3%BCn%C3%AF.txt"],
  ["GET", "/..%5cx"],
  ["GET", "/%00"],
  ["GET", "/a%00b"],
  // symlinks, unreadable and special files
  ["GET", "/link-in.txt"],
  ["GET", "/link-out.txt"],
  ["GET", "/linkdir"],
  ["GET", "/linkdir/"],
  ["GET", "/linkdir/secret.txt"],
  ["GET", "/dangling"],
  ["GET", "/b.ico"],
  ["GET", "/unreadable.txt"],
  // traversal attempts that are not dot segments of the request path
  ["GET", "/%2e%2e%2foutside/secret.txt"],
  ["GET", "/..%2foutside/secret.txt"],
  ["GET", "/sub1/..%2f..%2foutside/secret.txt"],
  ["GET", "/%252e%252e%252foutside/secret.txt"],
  ["GET", "/%2e%2e%5coutside%5csecret.txt"],
  ["GET", "/..%5c..%5coutside%5csecret.txt"],
  ["GET", "/%2e%2e\\outside\\secret.txt"],
  // ranges and conditional requests
  ["GET", "/test.txt", { Range: "bytes=1-2" }],
  ["GET", "/test.txt", { Range: "bytes=2-" }],
  ["GET", "/test.txt", { Range: "bytes=-1" }],
  ["GET", "/test.txt", { Range: "bytes=5-" }],
  ["GET", "/test.txt", { Range: "bytes=0-0,2-3" }],
  ["GET", "/test.txt", { Range: "items=0-1" }],
  ["GET", "/empty", { Range: "bytes=0-1" }],
  ["GET", "/big.png", { Range: "bytes=1000000-1000099" }],
  ["GET", "/big.png", { Range: "bytes=0-9,100-109,18874300-" }],
  ["GET", "/mid.zip", { Range: "bytes=10-19" }],
  ["GET", "/mid.zip", { Range: "bytes=0-1048575,2097152-" }],
  ["HEAD", "/big.png", { Range: "bytes=0-9" }],
  ["GET", "/test.txt", { "If-Modified-Since": "Fri, 02 Jan 2026 03:04:05 GMT" }],
  ["GET", "/test.txt", { "If-Modified-Since": "Fri, 02 Jan 2026 03:04:04 GMT" }],
  ["GET", "/test.txt", { "If-Modified-Since": "invalid" }],
  ["GET", "/test.txt", { "If-Unmodified-Since": "Thu, 01 Jan 2026 00:00:00 GMT" }],
  ["GET", "/test.txt", { "If-None-Match": "*" }],
  ["GET", "/test.txt", { "If-Match": "*" }],
  ["GET", "/test.txt", { "If-Match": `"x"` }],
  ["GET", "/test.txt", { Range: "bytes=0-1", "If-Range": "Fri, 02 Jan 2026 03:04:05 GMT" }],
  ["GET", "/test.txt", { Range: "bytes=0-1", "If-Range": "Thu, 01 Jan 2026 00:00:00 GMT" }],
  ["HEAD", "/test.txt", { "If-Modified-Since": "Fri, 02 Jan 2026 03:04:05 GMT" }],
  // gzip is not applied to the static route
  ["GET", "/test.txt", { "Accept-Encoding": "gzip" }],
  // CORS on the static route
  ["GET", "/test.txt", { Origin: "https://example.com" }],
  ["OPTIONS", "/test.txt", { Origin: "https://example.com" }],
];

describe.each([
  ["--indexFallback (default)", () => fallback],
  ["--indexFallback=false", () => noFallback],
])("%s", (_name, pair) => {
  for (const [method, target, headers] of requests) {
    test(`${method} ${target} ${headers ? JSON.stringify(headers) : ""}`, async () => {
      const { upstream, igloBase } = await both(pair(), method, target, headers);
      if (method === "HEAD" && upstream.status >= 400) {
        expect(igloBase.headers).toContain("content-length: 0");
        igloBase.headers = igloBase.headers.filter((h) => h !== "content-length: 0");
      }
      expect(igloBase).toEqual(upstream);
    });
  }

  for (const target of [
    "/../outside/secret.txt",
    "/sub1/../../outside/secret.txt",
    "/%2e%2e/outside/secret.txt",
    "/sub1/%2e%2e/%2e%2e/outside/secret.txt",
  ]) {
    test(`dot segments stay inside the public dir: ${target}`, async () => {
      const [up, ig] = await Promise.all([
        rawRequest(pair().upstream.url, "GET", target),
        rawRequest(pair().igloBase.url, "GET", target),
      ]);
      expect(ig.body).not.toContain("outside secret");
      expect(up.body).not.toContain("outside secret");
    });
  }

  test("a large download type gets Bun's Content-Disposition (reported difference)", async () => {
    for (const headers of [{}, { Range: "bytes=0-9" }] as Record<string, string>[]) {
      const { upstream, igloBase } = await both(pair(), "GET", "/big.zip", headers, [
        "content-disposition",
      ]);
      expect(igloBase).toEqual(upstream);
    }
    const ig = await rawRequest(pair().igloBase.url, "GET", "/big.zip");
    expect(ig.headers.get("content-disposition")).toBe(`filename="big.zip"`);
  });

  test("a large multipart/byteranges body: the same parts (reported difference)", async () => {
    const { upstream, igloBase } = await both(
      pair(),
      "GET",
      "/big.png",
      { Range: "bytes=0-9437183,9437184-" },
      ["content-disposition"],
    );
    expect(igloBase).toEqual(upstream);
  });
});
