// Upstream: apis/base.go (NewRouter: the default middlewares and their
// order, the router's catch-all and ErrorHandler), apis/middlewares.go
// (panicRecover, securityHeaders) and safeRedirectPath (upstream has no
// table for it; the cases follow its comment).
//
// The router is built in-process so that test-only routes (a handler that
// panics, a middleware order probe) can be added; nothing here ships.

import { afterAll, describe, expect, test } from "bun:test";

import { newRouter, safeRedirectPath } from "@/apis/base";
import {
  DefaultActivityLoggerMiddlewareId,
  DefaultBodyLimitMiddlewareId,
  DefaultLoadAuthTokenMiddlewareId,
  DefaultPanicRecoverMiddlewareId,
  DefaultRateLimitMiddlewareId,
  DefaultSecurityHeadersMiddlewareId,
  DefaultSuperuserIPsWhitelistMiddlewareId,
} from "@/middlewares/middlewares";
import { newBadRequestError } from "@/server/error";
import { serveTest } from "@test/support/router";
import { openFixtureApp } from "@test/app/app";

const app = await openFixtureApp({ clock: { now: () => new Date(0) } });
afterAll(() => app.cleanup());

const securityHeaders = {
  "x-xss-protection": "1; mode=block",
  "x-content-type-options": "nosniff",
  "x-frame-options": "SAMEORIGIN",
  "cross-origin-opener-policy": "same-origin",
};

function expectSecurityHeaders(res: Response): void {
  for (const [k, v] of Object.entries(securityHeaders)) {
    expect(res.headers.get(k)).toBe(v);
  }
}

test("the default middlewares run in upstream's priority order", async () => {
  const router = newRouter(app);
  const order: string[] = [];
  // wrap each default middleware to record the order it runs in
  for (const m of router.middlewares) {
    const inner = m.func;
    m.func = (e) => {
      order.push(m.id ?? "");
      return inner(e);
    };
  }
  router.GET("/test-order", (e) => e.noContent(204));

  const res = await serveTest(router.buildMux(), { target: "/test-order" });
  expect(res.status).toBe(204);
  expect(order).toEqual([
    DefaultActivityLoggerMiddlewareId,
    DefaultPanicRecoverMiddlewareId,
    DefaultLoadAuthTokenMiddlewareId,
    DefaultSuperuserIPsWhitelistMiddlewareId,
    DefaultSecurityHeadersMiddlewareId,
    DefaultRateLimitMiddlewareId,
    DefaultBodyLimitMiddlewareId,
  ]);
});

describe("panicRecover", () => {
  test("a throwing handler returns upstream's 500 body", async () => {
    const router = newRouter(app);
    router.GET("/test-panic", () => {
      throw new Error("test panic");
    });

    const res = await serveTest(router.buildMux(), { target: "/test-panic" });
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toBe("application/json");
    expectSecurityHeaders(res);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      data: {},
      message: "Something went wrong while processing your request.",
      status: 500,
    });
    expect(text).not.toContain("test panic");
  });

  test("a rejected async handler is recovered too", async () => {
    const router = newRouter(app);
    router.POST("/test-panic", async () => {
      await Promise.resolve();
      throw new TypeError("boom");
    });

    const res = await serveTest(router.buildMux(), { method: "POST", target: "/test-panic" });
    expect(res.status).toBe(500);
  });

  test("a response written before the panic is kept", async () => {
    const router = newRouter(app);
    router.GET("/test-panic", (e) => {
      e.string(201, "partial");
      throw new Error("after write");
    });

    const res = await serveTest(router.buildMux(), { target: "/test-panic" });
    expect(res.status).toBe(201);
    expect(await res.text()).toBe("partial");
  });
});

describe("ErrorHandler", () => {
  test("a returned error that is not an ApiError is a 400", async () => {
    const router = newRouter(app);
    router.GET("/test-error", () => new Error("internal detail"));

    const res = await serveTest(router.buildMux(), { target: "/test-error" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      data: {},
      message: "Something went wrong while processing your request.",
      status: 400,
    });
  });

  test("ApiError data is serialized with sorted keys and no body for HEAD", async () => {
    const router = newRouter(app);
    router.GET("/test-error", () =>
      newBadRequestError("custom", { b: "x", a: new Error("hidden") }),
    );
    const mux = router.buildMux();

    const res = await serveTest(mux, { target: "/test-error" });
    expect(await res.text()).toBe(
      `{"data":{"a":{"code":"validation_invalid_value","message":"Invalid value."},"b":{"code":"validation_invalid_value","message":"Invalid value."}},"message":"Custom.","status":400}`,
    );

    const head = await serveTest(mux, { method: "HEAD", target: "/test-error" });
    expect(head.status).toBe(400);
    expect(await head.text()).toBe("");
  });

  test("an explicit Content-Type is kept", async () => {
    const router = newRouter(app);
    router.GET("/test-error", (e) => {
      e.response.header.set("Content-Type", "text/test");
      return newBadRequestError("", undefined);
    });

    const res = await serveTest(router.buildMux(), { target: "/test-error" });
    expect(res.headers.get("content-type")).toBe("text/test");
  });
});

describe("routing", () => {
  const mux = newRouter(app).buildMux();

  test("GET /api/health", async () => {
    const res = await serveTest(mux, { target: "/api/health" });
    expect(res.status).toBe(200);
    expectSecurityHeaders(res);
    expect(await res.text()).toBe(`{"message":"API is healthy.","code":200,"data":{}}`);
  });

  const notFound: [string, string, string][] = [
    ["GET", "/missing", "File not found."],
    ["HEAD", "/missing", "File not found."],
    ["GET", "/api/health/", "File not found."],
    ["GET", "/api%2Fhealth", "File not found."],
    ["POST", "/api/health", "The requested resource wasn't found."],
    ["DELETE", "/missing", "The requested resource wasn't found."],
  ];
  for (const [method, target, message] of notFound) {
    test(`${method} ${target}`, async () => {
      const res = await serveTest(mux, { method, target });
      expect(res.status).toBe(404);
      expectSecurityHeaders(res);
      const text = await res.text();
      if (method === "HEAD") {
        expect(text).toBe("");
      } else {
        expect(text).toBe(JSON.stringify({ data: {}, message, status: 404 }));
      }
    });
  }

  // Go's ServeMux redirects unclean paths before any middleware runs
  const redirects: [string, string, string][] = [
    ["GET", "/api/../api/health", "/api/health"],
    ["GET", "//api/health", "/api/health"],
    ["GET", "/api/health/.", "/api/health"],
    ["GET", "/api//health?x=1", "/api/health?x=1"],
    ["GET", "/./api/health", "/api/health"],
    ["POST", "/api/./health", "/api/health"],
  ];
  for (const [method, target, location] of redirects) {
    test(`${method} ${target} redirects`, async () => {
      const res = await serveTest(mux, { method, target });
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toBe(location);
      expect(res.headers.get("x-frame-options")).toBeNull();
      if (method === "GET") {
        expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
        expect(await res.text()).toBe(`<a href="${location}">Temporary Redirect</a>.\n\n`);
      } else {
        expect(res.headers.get("content-type")).toBeNull();
        expect(await res.text()).toBe("");
      }
    });
  }
});

describe("safeRedirectPath", () => {
  const scenarios: [string, string][] = [
    ["", ""],
    ["/", "/"],
    ["////", "/"],
    ["//test", "/test"],
    ["\\\\test", "/test"],
    ["/\\test", "/test"],
    ["\\/test", "/test"],
    ["/test", "/test"],
    ["/a/b/c", "/a/b/c"],
  ];
  for (const [input, expected] of scenarios) {
    test(JSON.stringify(input), () => {
      expect(safeRedirectPath(input)).toBe(expected);
    });
  }
});
