// Upstream: apis/middlewares_test.go (TestRequireGuestOnly, TestRequireAuth,
// TestRequireSuperuserAuth, TestRequireSuperuserOrOwnerAuth,
// TestRequireSameCollectionContextAuth)
//
// As upstream's scenarios, each case registers its test route with the
// guard on the default router (apis/base.ts newRouter), and requests go
// through the whole middleware chain. The router is a test app's,
// bootstrapped on a writable copy of the vendored fixture, with a fixed
// clock before the fixture tokens' exp
// (2050-01-01). Upstream checks that the body contains `"data":{}`; here
// the whole body is compared with the ApiError upstream writes for the
// message in its source. The hook-event expectations are dropped.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { newRouter } from "@/apis/base";
import type { RequestEvent } from "@/app/event-request";
import {
  requireAuth,
  requireGuestOnly,
  requireSameCollectionContextAuth,
  requireSuperuserAuth,
  requireSuperuserOrOwnerAuth,
} from "@/middlewares/require-auth";
import { CollectionNameSuperusers } from "@/records/record-model-superusers";
import type { Router } from "@/server/router";

import { openFixtureApp, type TestApp } from "@test/app/app";
import { serveTest } from "@test/support/router";

const clock = { now: () => new Date(Date.UTC(2026, 9, 29)) };

const userToken =
  "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6IjRxMXhsY2xtZmxva3UzMyIsInR5cGUiOiJhdXRoIiwiY29sbGVjdGlvbklkIjoiX3BiX3VzZXJzX2F1dGhfIiwiZXhwIjoyNTI0NjA0NDYxLCJyZWZyZXNoYWJsZSI6dHJ1ZX0.ZT3F0Z3iM-xbGgSG3LEKiEzHrPHr8t8IuHLZGGNuxLo";
const userStaticToken =
  "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6IjRxMXhsY2xtZmxva3UzMyIsInR5cGUiOiJhdXRoIiwiY29sbGVjdGlvbklkIjoiX3BiX3VzZXJzX2F1dGhfIiwiZXhwIjoyNTI0NjA0NDYxLCJyZWZyZXNoYWJsZSI6ZmFsc2V9.4IsO6YMsR19crhwl_YWzvRH8pfq2Ri4Gv2dzGyneLak";
const userExpiredToken =
  "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6IjRxMXhsY2xtZmxva3UzMyIsInR5cGUiOiJhdXRoIiwiY29sbGVjdGlvbklkIjoiX3BiX3VzZXJzX2F1dGhfIiwiZXhwIjoxNjQwOTkxNjYxLCJyZWZyZXNoYWJsZSI6dHJ1ZX0.2D3tmqPn3vc5LoqqCz8V-iCDVXo9soYiH0d32G7FQT4";
const superuserToken =
  "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6InN5d2JoZWNuaDQ2cmhtMCIsInR5cGUiOiJhdXRoIiwiY29sbGVjdGlvbklkIjoicGJjXzMxNDI2MzU4MjMiLCJleHAiOjI1MjQ2MDQ0NjEsInJlZnJlc2hhYmxlIjp0cnVlfQ.UXgO3j-0BumcugrFjbd7j0M4MQvbrLggLlcu_YNGjoY";
const superuserExpiredToken =
  "eyJhbGciOiJIUzI1NiJ9.eyJpZCI6InN5d2JoZWNuaDQ2cmhtMCIsInR5cGUiOiJhdXRoIiwiY29sbGVjdGlvbklkIjoicGJjXzMxNDI2MzU4MjMiLCJleHAiOjE2NDA5OTE2NjEsInJlZnJlc2hhYmxlIjp0cnVlfQ.0pDcBPGDpL2Khh76ivlRi7ugiLBSYvasct3qpHV3rfs";
// a superuser file token (not an auth token)
const superuserFileToken =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6InN5d2JoZWNuaDQ2cmhtMCIsImV4cCI6MjUyNDYwNDQ2MSwidHlwZSI6ImZpbGUiLCJjb2xsZWN0aW9uSWQiOiJwYmNfMzE0MjYzNTgyMyJ9.Lupz541xRvrktwkrl55p5pPCF77T69ZRsohsIcb2dxc";

// the ApiError body (router.ApiError: data, message, status)
function apiError(status: number, message: string): string {
  return JSON.stringify({ data: {}, message, status });
}

interface Scenario {
  name: string;
  url: string;
  token?: string;
  // registers the test route on the router (upstream's BeforeTestFunc)
  route: (router: Router<RequestEvent>) => void;
  expectedStatus: number;
  expectedBody: string;
}

const handler = (e: RequestEvent) => e.string(200, "test123");

const guestOnlyRoute = (router: Router<RequestEvent>) => {
  router.GET("/my/test", handler).bind(requireGuestOnly());
};

const authRoute =
  (...names: string[]) =>
  (router: Router<RequestEvent>) => {
    router.GET("/my/test", handler).bind(requireAuth(...names));
  };

const superuserRoute = (router: Router<RequestEvent>) => {
  router.GET("/my/test", handler).bind(requireSuperuserAuth());
};

const ownerRoute =
  (pattern: string, ownerIdPathParam: string) => (router: Router<RequestEvent>) => {
    router.GET(pattern, handler).bind(requireSuperuserOrOwnerAuth(ownerIdPathParam));
  };

const sameCollectionRoute = (collectionPathParam: string) => (router: Router<RequestEvent>) => {
  router
    .GET("/my/test/{collection}", handler)
    .bind(requireSameCollectionContextAuth(collectionPathParam));
};

let testApp: TestApp;

beforeAll(() => {
  testApp = openFixtureApp({ clock });
});

afterAll(() => testApp.cleanup());

function run(scenarios: Scenario[]): void {
  for (const s of scenarios) {
    test(s.name, async () => {
      const router = newRouter(testApp);
      s.route(router);

      const res = await serveTest(router.buildMux(), {
        target: s.url,
        headers: s.token === undefined ? {} : { Authorization: s.token },
      });
      expect(res.status).toBe(s.expectedStatus);
      expect(await res.text()).toBe(s.expectedBody);
    });
  }
}

describe("TestRequireGuestOnly", () => {
  const guestsOnly = apiError(400, "The request can be accessed only by guests.");

  run([
    {
      name: "valid regular user token",
      url: "/my/test",
      token: userToken,
      route: guestOnlyRoute,
      expectedStatus: 400,
      expectedBody: guestsOnly,
    },
    {
      name: "valid superuser auth token",
      url: "/my/test",
      token: superuserToken,
      route: guestOnlyRoute,
      expectedStatus: 400,
      expectedBody: guestsOnly,
    },
    {
      name: "expired/invalid token",
      url: "/my/test",
      token: userExpiredToken,
      route: guestOnlyRoute,
      expectedStatus: 200,
      expectedBody: "test123",
    },
    {
      name: "guest",
      url: "/my/test",
      route: guestOnlyRoute,
      expectedStatus: 200,
      expectedBody: "test123",
    },
  ]);
});

describe("TestRequireAuth", () => {
  const unauthorized = apiError(401, "The request requires valid record authorization token.");

  run([
    {
      name: "guest",
      url: "/my/test",
      route: authRoute(),
      expectedStatus: 401,
      expectedBody: unauthorized,
    },
    {
      name: "expired token",
      url: "/my/test",
      token: userExpiredToken,
      route: authRoute(),
      expectedStatus: 401,
      expectedBody: unauthorized,
    },
    {
      name: "invalid token",
      url: "/my/test",
      token: superuserFileToken,
      route: authRoute(),
      expectedStatus: 401,
      expectedBody: unauthorized,
    },
    {
      name: "valid record auth token with no collection restrictions",
      url: "/my/test",
      token: userToken,
      route: authRoute(),
      expectedStatus: 200,
      expectedBody: "test123",
    },
    {
      name: "valid record static auth token",
      url: "/my/test",
      token: userStaticToken,
      route: authRoute(),
      expectedStatus: 200,
      expectedBody: "test123",
    },
    {
      name: "valid record auth token with collection not in the restricted list",
      url: "/my/test",
      token: superuserToken,
      route: authRoute("users", "demo1"),
      expectedStatus: 403,
      expectedBody: apiError(403, "The authorized record is not allowed to perform this action."),
    },
    {
      name: "valid record auth token with collection in the restricted list",
      url: "/my/test",
      token: superuserToken,
      route: authRoute("users", CollectionNameSuperusers),
      expectedStatus: 200,
      expectedBody: "test123",
    },
    {
      name: "valid record auth token with Bearer case-insensitive prefix",
      url: "/my/test",
      token: "BeArEr " + userToken,
      route: authRoute(),
      expectedStatus: 200,
      expectedBody: "test123",
    },
    // not upstream's: the Authorization header variants of getAuthTokenFromRequest
    {
      name: "Bearer prefix",
      url: "/my/test",
      token: "Bearer " + userToken,
      route: authRoute(),
      expectedStatus: 200,
      expectedBody: "test123",
    },
    {
      name: "Bearer prefix only",
      url: "/my/test",
      token: "Bearer ",
      route: authRoute(),
      expectedStatus: 401,
      expectedBody: unauthorized,
    },
    {
      name: "Bearer prefix without the space",
      url: "/my/test",
      token: "Bearer" + userToken,
      route: authRoute(),
      expectedStatus: 401,
      expectedBody: unauthorized,
    },
    {
      name: "Bearer prefix twice",
      url: "/my/test",
      token: "Bearer Bearer " + userToken,
      route: authRoute(),
      expectedStatus: 401,
      expectedBody: unauthorized,
    },
    {
      name: "another scheme",
      url: "/my/test",
      token: "Token " + userToken,
      route: authRoute(),
      expectedStatus: 401,
      expectedBody: unauthorized,
    },
  ]);
});

describe("TestRequireSuperuserAuth", () => {
  const unauthorized = apiError(401, "The request requires valid record authorization token.");

  run([
    {
      name: "guest",
      url: "/my/test",
      route: superuserRoute,
      expectedStatus: 401,
      expectedBody: unauthorized,
    },
    {
      name: "expired/invalid token",
      url: "/my/test",
      token: superuserExpiredToken,
      route: superuserRoute,
      expectedStatus: 401,
      expectedBody: unauthorized,
    },
    {
      name: "valid regular user auth token",
      url: "/my/test",
      token: userToken,
      route: superuserRoute,
      expectedStatus: 403,
      expectedBody: apiError(403, "The authorized record is not allowed to perform this action."),
    },
    {
      name: "valid superuser auth token",
      url: "/my/test",
      token: superuserToken,
      route: superuserRoute,
      expectedStatus: 200,
      expectedBody: "test123",
    },
  ]);
});

describe("TestRequireSuperuserOrOwnerAuth", () => {
  const unauthorized = apiError(
    401,
    "The request requires superuser or record authorization token.",
  );
  const forbidden = apiError(403, "You are not allowed to perform this request.");

  run([
    {
      name: "guest",
      url: "/my/test/4q1xlclmfloku33",
      route: ownerRoute("/my/test/{id}", ""),
      expectedStatus: 401,
      expectedBody: unauthorized,
    },
    {
      name: "expired/invalid token",
      url: "/my/test/4q1xlclmfloku33",
      token: superuserExpiredToken,
      route: ownerRoute("/my/test/{id}", ""),
      expectedStatus: 401,
      expectedBody: unauthorized,
    },
    {
      name: "valid record auth token (different user)",
      url: "/my/test/oap640cot4yru2s",
      token: userToken,
      route: ownerRoute("/my/test/{id}", ""),
      expectedStatus: 403,
      expectedBody: forbidden,
    },
    {
      name: "valid record auth token (owner)",
      url: "/my/test/4q1xlclmfloku33",
      token: userToken,
      route: ownerRoute("/my/test/{id}", ""),
      expectedStatus: 200,
      expectedBody: "test123",
    },
    {
      name: "valid record auth token (owner + non-matching custom owner param)",
      url: "/my/test/4q1xlclmfloku33",
      token: userToken,
      route: ownerRoute("/my/test/{id}", "test"),
      expectedStatus: 403,
      expectedBody: forbidden,
    },
    {
      name: "valid record auth token (owner + matching custom owner param)",
      url: "/my/test/4q1xlclmfloku33",
      token: userToken,
      route: ownerRoute("/my/test/{test}", "test"),
      expectedStatus: 200,
      expectedBody: "test123",
    },
    {
      name: "valid superuser auth token",
      url: "/my/test/4q1xlclmfloku33",
      token: superuserToken,
      route: ownerRoute("/my/test/{id}", ""),
      expectedStatus: 200,
      expectedBody: "test123",
    },
  ]);
});

describe("TestRequireSameCollectionContextAuth", () => {
  // upstream's last three scenarios bind RequireSuperuserOrOwnerAuth
  const unauthorized = apiError(401, "The request requires valid record authorization token.");

  run([
    {
      name: "guest",
      url: "/my/test/_pb_users_auth_",
      route: sameCollectionRoute(""),
      expectedStatus: 401,
      expectedBody: unauthorized,
    },
    {
      name: "expired/invalid token",
      url: "/my/test/_pb_users_auth_",
      token: userExpiredToken,
      route: sameCollectionRoute(""),
      expectedStatus: 401,
      expectedBody: unauthorized,
    },
    {
      name: "valid record auth token (different collection)",
      url: "/my/test/clients",
      token: userToken,
      route: sameCollectionRoute(""),
      expectedStatus: 403,
      expectedBody: apiError(403, "The request requires auth record from users collection."),
    },
    {
      name: "valid record auth token (same collection)",
      url: "/my/test/_pb_users_auth_",
      token: userToken,
      route: sameCollectionRoute(""),
      expectedStatus: 200,
      expectedBody: "test123",
    },
    {
      name: "valid record auth token (non-matching/missing collection param)",
      url: "/my/test/_pb_users_auth_",
      token: userToken,
      route: ownerRoute("/my/test/{id}", ""),
      expectedStatus: 403,
      expectedBody: apiError(403, "You are not allowed to perform this request."),
    },
    {
      name: "valid record auth token (matching custom collection param)",
      url: "/my/test/_pb_users_auth_",
      token: userToken,
      route: ownerRoute("/my/test/{test}", "test"),
      expectedStatus: 403,
      expectedBody: apiError(403, "You are not allowed to perform this request."),
    },
    {
      name: "superuser no exception check",
      url: "/my/test/_pb_users_auth_",
      token: superuserToken,
      route: sameCollectionRoute(""),
      expectedStatus: 403,
      expectedBody: apiError(403, "The request requires auth record from _superusers collection."),
    },
    // not upstream's: the collection by name, a missing collection and a
    // custom path parameter
    {
      name: "same collection by name",
      url: "/my/test/users",
      token: userToken,
      route: sameCollectionRoute(""),
      expectedStatus: 200,
      expectedBody: "test123",
    },
    {
      name: "missing collection",
      url: "/my/test/missing",
      token: userToken,
      route: sameCollectionRoute(""),
      expectedStatus: 403,
      expectedBody: apiError(403, "The request requires auth record from users collection."),
    },
    {
      name: "custom collection param that the route does not have",
      url: "/my/test/users",
      token: userToken,
      route: sameCollectionRoute("other"),
      expectedStatus: 403,
      expectedBody: apiError(403, "The request requires auth record from users collection."),
    },
  ]);
});
