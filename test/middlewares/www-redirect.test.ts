// Upstream: apis/serve.go (the www->non-www redirect hosts) and
// apis/middlewares.go (wwwRedirect). Upstream has no test of its own; these
// cases go through the router `serve` serves, in-process.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";

import type { Mux } from "@/server/router";
import { newServeRouter } from "@/server/serve";

import { openFixtureApp, type TestApp } from "@test/app/app";
import { tempDir } from "@test/support/executable";
import { serveTest } from "@test/support/router";

let app: TestApp;

beforeAll(async () => {
  app = await openFixtureApp({ clock: { now: () => new Date(Date.UTC(2026, 9, 29)) } });
});

afterAll(() => app.cleanup());

function mux(httpAddr: string): Mux {
  return newServeRouter(app, {
    httpAddr,
    httpsAddr: "",
    certificateDomains: [],
    allowedOrigins: ["*"],
    publicDir: join(tempDir(), "pb_public"),
    indexFallback: true,
    ui: undefined,
  }).buildMux();
}

test("the www host of the listener's host redirects to the host, with the request URI", async () => {
  const res = await serveTest(mux("example.com:80"), {
    target: "/api/health?a=1&b=%20",
    headers: { Host: "www.example.com" },
  });
  expect(res.status).toBe(307);
  expect(res.headers.get("location")).toBe("http://example.com/api/health?a=1&b=%20");
  // before every other middleware: no security or CORS headers
  expect(res.headers.get("vary")).toBeNull();
  expect(res.headers.get("x-frame-options")).toBeNull();
});

test("a POST is redirected with 307 too", async () => {
  const res = await serveTest(mux("example.com:80"), {
    method: "POST",
    target: "/api/collections/users/auth-with-password",
    headers: { Host: "www.example.com" },
  });
  expect(res.status).toBe(307);
  expect(res.headers.get("location")).toBe(
    "http://example.com/api/collections/users/auth-with-password",
  );
});

test("a Host with a port, or another host, is not redirected", async () => {
  const m = mux("example.com:80");
  for (const host of [
    "www.example.com:80",
    "example.com",
    "www.other.com",
    "www.www.example.com",
  ]) {
    const res = await serveTest(m, { target: "/api/health", headers: { Host: host } });
    expect(`${host} ${res.status}`).toBe(`${host} 200`);
  }
});

test("the default listener redirects its own www host", async () => {
  const res = await serveTest(mux("127.0.0.1:8090"), {
    target: "/x",
    headers: { Host: "www.127.0.0.1" },
  });
  expect(res.status).toBe(307);
  expect(res.headers.get("location")).toBe("http://127.0.0.1/x");
});

test("a www listener host has no redirect", async () => {
  const res = await serveTest(mux("www.example.com:80"), {
    target: "/api/health",
    headers: { Host: "www.example.com" },
  });
  expect(res.status).toBe(200);
});
