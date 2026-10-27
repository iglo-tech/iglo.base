// Upstream: apis/health_test.go (guest and regular user scenarios; the
// superuser scenario needs auth, M2.3), the catch-all 404 from
// tools/router/router.go BuildMux, the securityHeaders middleware
// (apis/middlewares.go) and Go's ServeMux path cleaning.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { startServer, tempDir, type RunningServer } from "@test/support/executable";
import { rawRequest } from "@test/support/raw-http";

let server: RunningServer;

beforeAll(async () => {
  server = await startServer([], join(tempDir(), "pb_data"));
});

afterAll(async () => {
  await server.stop();
});

// GET and HEAD fall through to the binary's GET /{path...} static route
// (examples/base/main.go), which answers router.ErrFileNotFound when there
// is no matching file; other methods reach the router's catch-all.
const fileNotFoundBody = { data: {}, message: "File not found.", status: 404 };
const notFoundBody = {
  data: {},
  message: "The requested resource wasn't found.",
  status: 404,
};

// securityHeaders, bound to every route
function expectSecurityHeaders(res: Response): void {
  expect(res.headers.get("x-xss-protection")).toBe("1; mode=block");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin");
}

describe("GET /api/health", () => {
  test("guest", async () => {
    const res = await fetch(`${server.url}/api/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expectSecurityHeaders(res);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ message: "API is healthy.", code: 200, data: {} });
    for (const hidden of ["canBackup", "realIP", "possibleProxyHeader"]) {
      expect(text).not.toContain(hidden);
    }
  });

  test("regular user token gets the guest response", async () => {
    const res = await fetch(`${server.url}/api/health`, {
      headers: {
        Authorization:
          "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6IjRxMXhsY2xtZmxva3UzMyIsInR5cGUiOiJhdXRoIiwiY29sbGVjdGlvbklkIjoiX3BiX3VzZXJzX2F1dGhfIiwiZXhwIjoyNTI0NjA0NDYxLCJyZWZyZXNoYWJsZSI6dHJ1ZX0.ZT3F0Z3iM-xbGgSG3LEKiEzHrPHr8t8IuHLZGGNuxLo",
      },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ message: "API is healthy.", code: 200, data: {} });
    for (const hidden of ["canBackup", "realIP", "possibleProxyHeader"]) {
      expect(text).not.toContain(hidden);
    }
  });

  test.todo("superuser gets canBackup, realIP and possibleProxyHeader (M2.3)");

  test("HEAD matches like GET, without a body", async () => {
    const res = await fetch(`${server.url}/api/health`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expectSecurityHeaders(res);
    expect(await res.text()).toBe("");
  });
});

describe("wildcard listen address", () => {
  // Go's net.Listen("tcp", ":port") and "0.0.0.0:port" accept IPv4 and IPv6
  for (const host of ["", "0.0.0.0"]) {
    test(`--http ${host}:<port> serves IPv4 and IPv6 loopback`, async () => {
      const wildcard = await startServer([], join(tempDir(), "pb_data"), host);
      try {
        const port = new URL(wildcard.url).port;
        for (const url of [`http://127.0.0.1:${port}`, `http://[::1]:${port}`]) {
          const res = await fetch(`${url}/api/health`);
          expect(res.status).toBe(200);
        }
      } finally {
        await wildcard.stop();
      }
    });
  }
});

describe("host name listen address", () => {
  // Go's net.Listen picks the first IPv4 address of a host name
  test("--http localhost:<port> serves IPv4 loopback", async () => {
    const named = await startServer([], join(tempDir(), "pb_data"), "localhost");
    try {
      const res = await fetch(`${named.url}/api/health`);
      expect(res.status).toBe(200);
    } finally {
      await named.stop();
    }
  });
});

describe("unknown routes", () => {
  for (const [method, path, body] of [
    ["GET", "/", fileNotFoundBody],
    ["GET", "/api/missing", fileNotFoundBody],
    ["GET", "/api/health/", fileNotFoundBody],
    ["POST", "/api/health", notFoundBody],
    ["POST", "/api/missing", notFoundBody],
    ["DELETE", "/api/health", notFoundBody],
  ] as const) {
    test(`${method} ${path} returns the 404 error body`, async () => {
      const res = await fetch(`${server.url}${path}`, { method });
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toBe("application/json");
      expectSecurityHeaders(res);
      expect(await res.json()).toEqual(body);
    });
  }

  test("HEAD of an unknown path is a 404 without a body", async () => {
    const res = await fetch(`${server.url}/api/missing`, { method: "HEAD" });
    expect(res.status).toBe(404);
    expectSecurityHeaders(res);
    expect(await res.text()).toBe("");
  });
});

describe("request targets", () => {
  // fetch() normalizes URLs, so these go over a raw socket
  test("//api/health redirects to the clean path with 307", async () => {
    const res = await rawRequest(server.url, "GET", "//api/health?a=b");
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("/api/health?a=b");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.body).toBe(`<a href="/api/health?a=b">Temporary Redirect</a>.\n\n`);
  });

  test("an escaped slash is not a separator", async () => {
    const res = await rawRequest(server.url, "GET", "/api%2Fhealth");
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toEqual(fileNotFoundBody);
  });

  test("an invalid escape is a 400 before routing", async () => {
    const res = await rawRequest(server.url, "GET", "/a%zz");
    expect(res.status).toBe(400);
    expect(res.body).toBe("400 Bad Request");
  });
});
