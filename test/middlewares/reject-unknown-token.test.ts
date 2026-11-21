// Upstream: apis/middlewares_test.go (TestRejectUnknownToken). Each case goes
// through the default router (apis/base.ts) of a test app on the vendored
// fixture, and checks the response a real client gets: the route's own
// response, or upstream's 401 body.

import { afterAll, beforeAll, expect, test } from "bun:test";

import { newRouter } from "@/apis/base";
import type { RequestEvent } from "@/app/event-request";

import { openFixtureApp } from "@test/app/app";
import type { TestApp } from "@test/app/app";
import { serveTest } from "@test/support/router";

const clock = { now: () => new Date(Date.UTC(2026, 9, 29)) };

// a valid regular user token (the fixture's users collection)
const userToken =
  "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6IjRxMXhsY2xtZmxva3UzMyIsInR5cGUiOiJhdXRoIiwiY29sbGVjdGlvbklkIjoiX3BiX3VzZXJzX2F1dGhfIiwiZXhwIjoyNTI0NjA0NDYxLCJyZWZyZXNoYWJsZSI6dHJ1ZX0.ZT3F0Z3iM-xbGgSG3LEKiEzHrPHr8t8IuHLZGGNuxLo";

// an expired token (exp 1640991661)
const expiredToken =
  "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6IjRxMXhsY2xtZmxva3UzMyIsInR5cGUiOiJhdXRoIiwiY29sbGVjdGlvbklkIjoiX3BiX3VzZXJzX2F1dGhfIiwiZXhwIjoxNjQwOTkxNjYxLCJyZWZyZXNoYWJsZSI6dHJ1ZX0.2D3tmqPn3vc5LoqqCz8V-iCDVXo9soYiH0d32G7FQT4";

let testApp: TestApp;

beforeAll(async () => {
  testApp = await openFixtureApp({ clock });
});

afterAll(() => testApp.cleanup());

// the status and body of GET /my/test, and whether the route action ran
async function call(authorization: string | undefined): Promise<{
  status: number;
  body: unknown;
  reached: boolean;
}> {
  const router = newRouter(testApp);
  let reached = false;
  router.GET("/my/test", (e: RequestEvent) => {
    reached = true;
    return e.string(200, "test123");
  });
  const res = await serveTest(router.buildMux(), {
    target: "/my/test",
    headers: authorization === undefined ? {} : { Authorization: authorization },
  });
  const text = await res.text();
  return { status: res.status, body: text === "test123" ? text : JSON.parse(text), reached };
}

const unauthorized = {
  status: 401,
  message: "Missing or invalid authentication.",
  data: {},
};

test("a request without a token reaches the route", async () => {
  expect(await call(undefined)).toEqual({ status: 200, body: "test123", reached: true });
});

test("an empty Authorization header is a guest request", async () => {
  expect(await call("")).toEqual({ status: 200, body: "test123", reached: true });
});

test("a valid token reaches the route", async () => {
  expect(await call(userToken)).toEqual({ status: 200, body: "test123", reached: true });
  expect(await call(`Bearer ${userToken}`)).toEqual({
    status: 200,
    body: "test123",
    reached: true,
  });
});

test("an expired token is rejected with 401 before the route runs", async () => {
  const res = await call(expiredToken);
  expect(res.status).toBe(401);
  expect(res.body).toEqual(unauthorized);
  expect(res.reached).toBe(false);
});

test("an unknown token is rejected with 401, with or without the Bearer prefix", async () => {
  for (const authorization of ["Bearer abc", "abc", "bearer abc", userToken.slice(0, -1)]) {
    const res = await call(authorization);
    expect(res.status).toBe(401);
    expect(res.body).toEqual(unauthorized);
    expect(res.reached).toBe(false);
  }
});
