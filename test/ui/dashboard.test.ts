// Upstream: apis/serve.go (the /_/ route), apis/base.go (Static) and
// apis/extensions_test.go (the extensions script, with the differences in
// docs/design/04-api-compatibility.md): the embedded dashboard served by the
// compiled executable, through HTTP only.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { startServer, tempDir, type RunningServer } from "@test/support/executable";
import { rawRequest } from "@test/support/raw-http";

const csp =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' http://127.0.0.1:* https://tile.openstreetmap.org data: blob:; connect-src 'self' http://127.0.0.1:* https://nominatim.openstreetmap.org; script-src 'self' http://127.0.0.1:*; frame-ancestors 'none'";
const cacheControl = "max-age=1209600, stale-while-revalidate=86400";

let server: RunningServer;
let devServer: RunningServer;

beforeAll(async () => {
  [server, devServer] = await Promise.all([
    startServer([], join(tempDir(), "pb_data")),
    startServer(["--dev"], join(tempDir(), "pb_data")),
  ]);
});

afterAll(async () => {
  await Promise.all([server?.stop(), devServer?.stop()]);
});

interface Raw {
  status: number;
  headers: Headers;
  body: Uint8Array;
}

// the response as sent: no redirect following, no decompression
async function get(
  path: string,
  headers: Record<string, string> = {},
  method = "GET",
  base = server.url,
): Promise<Raw> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    redirect: "manual",
    decompress: false,
  });
  return { status: res.status, headers: res.headers, body: await res.bytes() };
}

const text = (b: Uint8Array): string => new TextDecoder().decode(b);

// the asset paths index.html references, relative to /_/
async function indexAssets(): Promise<string[]> {
  const html = text((await get("/_/")).body);
  return [...html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map((m) => m[1] ?? "");
}

describe("index", () => {
  test("GET /_/ serves index.html without Cache-Control", async () => {
    const res = await get("/_/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toBe(csp);
    expect(res.headers.get("cache-control")).toBeNull();
    expect(res.headers.get("vary")).toBe("Accept-Encoding");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    const html = text(res.body);
    expect(html).toContain("<title>iglo.base</title>");
    expect(Number(res.headers.get("content-length"))).toBe(res.body.length);
  });

  test("gzip when the client accepts it", async () => {
    const plain = await get("/_/");
    const res = await get("/_/", { "Accept-Encoding": "gzip, deflate" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(text(gunzipSync(res.body))).toBe(text(plain.body));
  });

  test("HEAD has the headers and no body", async () => {
    const res = await get("/_/", {}, "HEAD");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.body.length).toBe(0);
  });

  test("the dashboard does not load /_/extensions.js", async () => {
    const scripts = (await indexAssets()).filter((p) => p.endsWith(".js"));
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      expect(text((await get(`/_/${script}`)).body)).not.toContain("extensions.js");
    }
  });
});

describe("assets", () => {
  test("index.html's assets are served with their types and caching", async () => {
    const assets = await indexAssets();
    expect(assets.some((p) => p.startsWith("assets/") && p.endsWith(".js"))).toBe(true);
    expect(assets.some((p) => p.endsWith(".css"))).toBe(true);
    for (const asset of assets) {
      const res = await get(`/_/${asset}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe(cacheControl);
      expect(res.headers.get("content-security-policy")).toBe(csp);
      const type = asset.endsWith(".css")
        ? "text/css; charset=utf-8"
        : "text/javascript; charset=utf-8";
      expect(res.headers.get("content-type")).toBe(type);
    }
  });

  const types: [string, string][] = [
    ["images/favicon.png", "image/png"],
    ["images/favicon_prod.png", "image/png"],
    ["images/logo.svg", "image/svg+xml"],
    ["images/logo_white.svg", "image/svg+xml"],
    ["fonts/remixicon/remixicon.woff2", "font/woff2"],
    ["libs/tinymce/tinymce.min.js", "text/javascript; charset=utf-8"],
    ["libs/uplot/uplot.css", "text/css; charset=utf-8"],
  ];
  for (const [path, type] of types) {
    test(`${path} is ${type}`, async () => {
      const res = await get(`/_/${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(type);
      expect(res.body.length).toBeGreaterThan(0);
    });
  }

  test("--dev sends no Cache-Control", async () => {
    const res = await get("/_/images/favicon.png", {}, "GET", devServer.url);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBeNull();
    expect(res.headers.get("content-security-policy")).toBe(csp);
  });
});

describe("ranges and preconditions", () => {
  test("a single range", async () => {
    const full = (await get("/_/images/favicon.png")).body;
    const res = await get("/_/images/favicon.png", { Range: "bytes=0-9" });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 0-9/${full.length}`);
    expect([...res.body]).toEqual([...full.subarray(0, 10)]);
  });

  test("a suffix range", async () => {
    const full = (await get("/_/images/favicon.png")).body;
    const res = await get("/_/images/favicon.png", { Range: "bytes=-5" });
    expect(res.status).toBe(206);
    expect([...res.body]).toEqual([...full.subarray(full.length - 5)]);
  });

  test("several ranges", async () => {
    const full = (await get("/_/images/favicon.png")).body;
    const res = await get("/_/images/favicon.png", { Range: "bytes=0-1,4-5" });
    expect(res.status).toBe(206);
    const type = res.headers.get("content-type") ?? "";
    expect(type).toMatch(/^multipart\/byteranges; boundary=[0-9a-f]{60}$/);
    const boundary = type.slice(type.indexOf("=") + 1);
    const body = Buffer.from(res.body).toString("latin1");
    const expected =
      `--${boundary}\r\nContent-Range: bytes 0-1/${full.length}\r\nContent-Type: image/png\r\n\r\n` +
      Buffer.from(full.subarray(0, 2)).toString("latin1") +
      `\r\n--${boundary}\r\nContent-Range: bytes 4-5/${full.length}\r\nContent-Type: image/png\r\n\r\n` +
      Buffer.from(full.subarray(4, 6)).toString("latin1") +
      `\r\n--${boundary}--\r\n`;
    expect(body).toBe(expected);
  });

  test("a range past the end", async () => {
    const full = (await get("/_/images/favicon.png")).body;
    const res = await get("/_/images/favicon.png", { Range: "bytes=999999-" });
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe(`bytes */${full.length}`);
    expect(res.headers.get("cache-control")).toBeNull();
    expect(text(res.body)).toBe("invalid range: failed to overlap\n");
  });

  test("an invalid range", async () => {
    const res = await get("/_/images/favicon.png", { Range: "bytes=5-1" });
    expect(res.status).toBe(416);
    expect(text(res.body)).toBe("invalid range\n");
  });

  test("If-None-Match: * is not modified", async () => {
    const res = await get("/_/images/favicon.png", { "If-None-Match": "*" });
    expect(res.status).toBe(304);
    expect(res.headers.get("content-type")).toBeNull();
  });

  test("If-Match with an ETag fails the precondition", async () => {
    const res = await get("/_/images/favicon.png", { "If-Match": '"abc"' });
    expect(res.status).toBe(412);
  });

  test("If-Range ignores the range", async () => {
    const res = await get("/_/images/favicon.png", { Range: "bytes=0-9", "If-Range": '"abc"' });
    expect(res.status).toBe(200);
  });
});

describe("redirects and missing files", () => {
  const redirects: [string, number, string][] = [
    ["/_", 307, "/_/"],
    ["/_/index.html", 301, "/_/"],
    ["/_/assets", 301, "/_/assets/"],
    ["/_/images/favicon.png/", 301, "/_/images/favicon.png"],
  ];
  for (const [path, status, location] of redirects) {
    test(`${path} redirects to ${location}`, async () => {
      const res = await get(path);
      expect(res.status).toBe(status);
      expect(res.headers.get("location")).toBe(location);
    });
  }

  for (const path of [
    "/_/missing.js",
    "/_/assets/",
    "/_/libs/",
    "/_/extensions/ext1/test.txt",
    "/_/extensions/ext3%20with%20spaces/test.txt",
  ]) {
    test(`${path} is 404`, async () => {
      const res = await get(path, { "Accept-Encoding": "gzip" });
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toBe("application/json");
      expect(res.headers.get("content-encoding")).toBeNull();
      expect(res.headers.get("cache-control")).toBe(cacheControl);
      expect(res.headers.get("vary")).toBe("Accept-Encoding");
      expect(JSON.parse(text(res.body))).toEqual({
        data: {},
        message: "File not found.",
        status: 404,
      });
    });
  }

  test("escaped dot segments do not leave the dashboard", async () => {
    const res = await rawRequest(server.url, "GET", "/_/%2e%2e/%2e%2e/etc/passwd");
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ data: {}, message: "File not found.", status: 404 });
  });
});

describe("extensions script", () => {
  // upstream's "no extensions" scenario; "with extensions" and the
  // extension files are differences (no extension surface)
  test("GET /_/extensions.js is an empty script", async () => {
    const res = await get("/_/extensions.js", { "Accept-Encoding": "gzip" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript");
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("cache-control")).toBe(cacheControl);
    expect(res.headers.get("content-security-policy")).toBe(csp);
    expect(res.body.length).toBe(0);
  });

  test("--dev sends no Cache-Control", async () => {
    const res = await get("/_/extensions.js", {}, "GET", devServer.url);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBeNull();
  });
});
