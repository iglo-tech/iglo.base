// Upstream: apis/middlewares.go (loadAuthToken, getAuthTokenFromRequest)
//
// Upstream has no test of its own for loadAuthToken; its Require* tests
// (require-auth.test.ts) go through it. These cases check the loaded
// record and the cases where the middleware leaves e.auth as it is. The
// router is the default one (apis/base.ts) of a test app bootstrapped on a
// writable copy of the vendored fixture; loadAuthToken reads e.app.

import { afterAll, beforeAll, expect, test } from "bun:test";

import { newRouter } from "@/apis/base";
import type { RequestEvent } from "@/app/event-request";
import { findRecordById } from "@/records/record-query";
import { newFileToken, newVerificationToken } from "@/records/record-tokens";

import { openFixtureApp } from "@test/app/app";
import type { TestApp } from "@test/app/app";
import { serveTest } from "@test/support/router";

const clock = { now: () => new Date(Date.UTC(2026, 9, 29)) };

const userToken =
  "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6IjRxMXhsY2xtZmxva3UzMyIsInR5cGUiOiJhdXRoIiwiY29sbGVjdGlvbklkIjoiX3BiX3VzZXJzX2F1dGhfIiwiZXhwIjoyNTI0NjA0NDYxLCJyZWZyZXNoYWJsZSI6dHJ1ZX0.ZT3F0Z3iM-xbGgSG3LEKiEzHrPHr8t8IuHLZGGNuxLo";

let testApp: TestApp;

beforeAll(async () => {
  testApp = await openFixtureApp({ clock });
});

afterAll(() => testApp.cleanup());

// the e.auth loadAuthToken leaves for the request: "collectionName/id", or ""
// for a guest. A probe at priority 9998 reads it after loadAuthToken and
// before rejectUnknownToken (9999), so a request the router rejects with 401
// still reports its state.
async function authOf(
  token: string | undefined,
  options: { preset?: (e: RequestEvent) => void } = {},
): Promise<string> {
  const router = newRouter(testApp);
  if (options.preset !== undefined) {
    const preset = options.preset;
    // runs before loadAuthToken
    router.bind({ priority: -99_999, func: (e) => (preset(e), e.next()) });
  }
  let seen = "";
  router.bind({
    priority: 9998,
    func: (e) => {
      seen = e.auth === undefined ? "" : `${e.auth.collection().name}/${e.auth.id}`;
      return e.next();
    },
  });
  router.GET("/my/test", (e) => e.noContent(204));
  await serveTest(router.buildMux(), {
    target: "/my/test",
    headers: token === undefined ? {} : { Authorization: token },
  });
  return seen;
}

test("an auth token loads its record", async () => {
  expect(await authOf(userToken)).toBe("users/4q1xlclmfloku33");
  expect(await authOf("bearer " + userToken)).toBe("users/4q1xlclmfloku33");
});

test("no header, an empty header and a broken token leave a guest", async () => {
  expect(await authOf(undefined)).toBe("");
  expect(await authOf("")).toBe("");
  expect(await authOf("invalid")).toBe("");
  expect(await authOf(userToken.slice(0, -1))).toBe("");
});

test("only auth tokens are loaded", async () => {
  const user = findRecordById(testApp, "users", "4q1xlclmfloku33");
  expect(await authOf(newFileToken(user, clock))).toBe("");
  expect(await authOf(newVerificationToken(user, clock))).toBe("");
});

test("an auth record loaded before is kept", async () => {
  const other = findRecordById(testApp, "users", "oap640cot4yru2s");
  expect(
    await authOf(userToken, {
      preset: (e) => {
        e.auth = other;
      },
    }),
  ).toBe("users/oap640cot4yru2s");
});
