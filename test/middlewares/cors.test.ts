// Upstream: apis/middlewares_cors_test.go (TestCorsExactWildcardMatch), and
// the CORS middleware as apis/serve.go binds it (--origins): in-process on
// the router `serve` serves, on a test app bootstrapped on a copy of the
// vendored fixture. test/differential/serve/cors.test.ts compares the same
// kinds of requests with upstream's binary.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { exactWildcardMatch } from "@/middlewares/cors";
import type { Mux } from "@/server/router";
import { newServeRouter } from "@/server/serve";

import { openFixtureApp, type TestApp } from "@test/app/app";
import { tempDir } from "@test/support/executable";
import { serveTest } from "@test/support/router";

describe("TestCorsExactWildcardMatch", () => {
  const scenarios: [domain: string, pattern: string, expected: boolean][] = [
    ["", "", false],
    ["http://example.com", "", false],
    ["", "http://example.com", false],
    ["http://example.com", "https://example.com", false],
    ["abc://example.com", "abc://example.com", true],
    ["https://example.com", "https://example.com", true],
    ["https://a.example.com", "https://example.com", false],
    ["https://example.com", "https://a.example.com", false],
    ["https://example.com", "https://*.example.com", false],
    ["https://a.example.com", "https://*.example.com", true],
    ["https://a.example.com", "https://a.*.example.com", false],
    ["https://a.b.example.com", "https://a.*.example.com", true],
    ["https://a.b.example.com", "https://a2.*.example.com", false],
    ["https://a.b.example.com", "https://a.*", false],
    ["https://a.b.example", "https://a.*", false],
    ["https://a.b", "https://a.*", true],
  ];

  for (const [domain, pattern, expected] of scenarios) {
    test(`${domain}:${pattern}`, () => {
      expect(exactWildcardMatch(domain, pattern)).toBe(expected);
    });
  }
});

let app: TestApp;
const muxes = new Map<string, Mux>();

beforeAll(async () => {
  app = await openFixtureApp({ clock: { now: () => new Date(Date.UTC(2026, 9, 29)) } });
});

afterAll(() => app.cleanup());

function mux(origins: string[]): Mux {
  const key = origins.join(" ");
  let m = muxes.get(key);
  if (m === undefined) {
    m = newServeRouter(app, {
      httpAddr: "127.0.0.1:8090",
      httpsAddr: "",
      certificateDomains: [],
      allowedOrigins: origins,
      publicDir: join(tempDir(), "pb_public"),
      indexFallback: true,
      ui: undefined,
    }).buildMux();
    muxes.set(key, m);
  }
  return m;
}

const preflightHeaders = {
  "Access-Control-Request-Method": "PATCH",
  "Access-Control-Request-Headers": "authorization,content-type",
};

const corsHeaders = [
  "vary",
  "access-control-allow-origin",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "access-control-allow-credentials",
  "access-control-expose-headers",
  "access-control-max-age",
];

function picked(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of corsHeaders) {
    const v = res.headers.get(name);
    if (v !== null) {
      out[name] = v;
    }
  }
  return out;
}

describe("CORS with the default origins (*)", () => {
  test("a preflight without an Origin is 204 with Vary only", async () => {
    const res = await serveTest(mux([]), { method: "OPTIONS", target: "/api/health" });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(picked(res)).toEqual({ vary: "Origin" });
    // CORS runs before the security headers
    expect(res.headers.get("x-frame-options")).toBeNull();
  });

  test("a preflight with an Origin allows every origin", async () => {
    const res = await serveTest(mux(["*"]), {
      method: "OPTIONS",
      target: "/api/collections/users/records",
      headers: { Origin: "https://app.example.com", ...preflightHeaders },
    });
    expect(res.status).toBe(204);
    expect(picked(res)).toEqual({
      vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,HEAD,PUT,PATCH,POST,DELETE",
      "access-control-allow-headers": "authorization,content-type",
    });
  });

  test("a preflight to an unknown path is 204 too", async () => {
    const res = await serveTest(mux(["*"]), {
      method: "OPTIONS",
      target: "/missing/path",
      headers: { Origin: "https://app.example.com" },
    });
    expect(res.status).toBe(204);
    expect(picked(res)["access-control-allow-origin"]).toBe("*");
  });

  test("a simple request gets the origin and Vary, and goes on", async () => {
    const res = await serveTest(mux(["*"]), {
      target: "/api/health",
      headers: { Origin: "https://app.example.com", Cookie: "a=b" },
    });
    expect(res.status).toBe(200);
    // never credentials, as upstream's serve never sets AllowCredentials
    expect(picked(res)).toEqual({ vary: "Origin", "access-control-allow-origin": "*" });
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });

  test("a request without an Origin gets Vary: Origin, also on errors", async () => {
    const res = await serveTest(mux(["*"]), { target: "/api/collections/missing/records" });
    expect(res.status).toBe(404);
    expect(picked(res)).toEqual({ vary: "Origin" });
  });
});

describe("CORS with --origins set", () => {
  const origins = ["https://example.com", "https://*.example.org", "http://localhost:*", "abc"];

  const cases: [origin: string, allowed: string | null][] = [
    ["https://example.com", "https://example.com"],
    ["http://example.com", null],
    ["https://a.example.org", "https://a.example.org"],
    ["https://a.b.example.org", "https://a.b.example.org"],
    ["https://example.org", null],
    ["http://localhost:5173", "http://localhost:5173"],
    ["http://localhost", null],
    ["abc", "abc"],
    ["null", null],
    [`https://${"a".repeat(260)}.example.org`, null],
  ];

  for (const [origin, allowed] of cases) {
    test(`preflight from ${origin.slice(0, 40)}`, async () => {
      const res = await serveTest(mux(origins), {
        method: "OPTIONS",
        target: "/api/health",
        headers: { Origin: origin, ...preflightHeaders },
      });
      expect(res.status).toBe(204);
      const h = picked(res);
      expect(h["access-control-allow-origin"] ?? null).toBe(allowed);
      expect(h.vary).toBe(
        allowed === null
          ? "Origin"
          : "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
      );
      expect(h["access-control-allow-methods"] ?? null).toBe(
        allowed === null ? null : "GET,HEAD,PUT,PATCH,POST,DELETE",
      );
    });

    test(`simple request from ${origin.slice(0, 40)}`, async () => {
      const res = await serveTest(mux(origins), {
        target: "/api/health",
        headers: { Origin: origin },
      });
      expect(res.status).toBe(200);
      expect(picked(res)).toEqual(
        allowed === null
          ? { vary: "Origin" }
          : { vary: "Origin", "access-control-allow-origin": allowed },
      );
    });
  }
});
