// Upstream: apis/health_test.go (guest and regular user scenarios; the
// superuser scenario needs auth, M2.3) and the catch-all 404 from
// tools/router/router.go BuildMux.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { startServer, tempDir, type RunningServer } from "@test/support/executable";

let server: RunningServer;

beforeAll(async () => {
  server = await startServer([], join(tempDir(), "pb_data"));
});

afterAll(async () => {
  await server.stop();
});

const notFoundBody = {
  data: {},
  message: "The requested resource wasn't found.",
  status: 404,
};

describe("GET /api/health", () => {
  test("guest", async () => {
    const res = await fetch(`${server.url}/api/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
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

describe("unknown routes", () => {
  for (const [method, path] of [
    ["GET", "/"],
    ["GET", "/api/missing"],
    ["GET", "/api/health/"],
    ["POST", "/api/health"],
    ["DELETE", "/api/health"],
  ] as const) {
    test(`${method} ${path} returns the 404 error body`, async () => {
      const res = await fetch(`${server.url}${path}`, { method });
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toBe("application/json");
      expect(await res.json()).toEqual(notFoundBody);
    });
  }
});
