// Upstream: apis/middlewares_rate_limit_test.go (TestDefaultRateLimitMiddleware,
// TestDefaultRateLimitMiddlewareSkipChecks), and the order of the rate limit
// checks in apis/record_crud.go, apis/record_auth.go, apis/file.go and
// apis/batch.go.
//
// Each case is a sequence of requests to one server. `bun test` runs them
// against iglo.base in-process with an injected clock
// (test/apis/rate-limit.test.ts); `bun run test:reference` runs them against
// upstream and iglo.base (test/differential/rate-limit/rate-limit.test.ts),
// where a step's waitMs is real time.
//
// Upstream's tests add custom routes, which are a deliberate difference
// (no extension surface), so the `/rate/...` and `/norate` paths here are
// served by the catch-all static route: 404 (allowed) stands for their 200.
//
// Durations are an hour unless a case is about windows, so that only the
// `timed` cases depend on the wall clock. No rule reaches `/api/health`: the
// harness polls it until a server is ready. An OPTIONS request is not here:
// upstream's CORS middleware answers a preflight before the limiter, and
// CORS is M5.7.

import { insertOTPs, setMFA } from "@test/scenarios/record-auth-prepare";
import { clientsToken, superuserToken, usersToken } from "@test/scenarios/record-crud";
import { type RateLimitRuleData } from "@test/scenarios/prepare";
import type { PrepareContext } from "@test/scenarios/scenario";
import { changeSettings } from "@test/scenarios/settings-prepare";

export interface Step {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  // a string is sent as is, anything else as JSON
  body?: unknown;
  // upstream's `wait`: before the request
  waitMs?: number;
  status: number;
  // an expected body, for a 429 that is not the default one
  message?: string;
  // compare the two servers' successful bodies as well (the bodies of
  // errors are always compared)
  compareBody?: boolean;
}

export interface Case {
  name: string;
  rules: RateLimitRuleData[];
  excludedIPs?: string[];
  // defaults to true
  enabled?: boolean;
  superuserIPs?: string[];
  trustedProxyHeaders?: string[];
  prepare?: (ctx: PrepareContext) => void;
  // window cases: the steps must land in the planned seconds
  timed?: boolean;
  steps: Step[];
}

export const tooManyRequestsBody = `{"data":{},"message":"Too Many Requests.","status":429}\n`;

export function prepareCase(c: Case, ctx: PrepareContext): void {
  changeSettings(ctx.dataDir, (settings) => {
    settings.rateLimits = {
      enabled: c.enabled ?? true,
      excludedIPs: c.excludedIPs ?? [],
      rules: c.rules.map((r) => ({
        label: r.label,
        audience: r.audience ?? "",
        duration: r.duration ?? 3600,
        maxRequests: r.maxRequests,
      })),
    };
    settings.superuserIPs = c.superuserIPs ?? [];
    settings.trustedProxy = { headers: c.trustedProxyHeaders ?? [], useLeftmostIP: false };
  });
  c.prepare?.(ctx);
}

const hour = 3600;
const auth = (token: string): Record<string, string> => ({ Authorization: token });
const user = auth(usersToken);
const client = auth(clientsToken);
const superuser = auth(superuserToken);
const testIP = { "x-test-ip": "127.0.0.1" };

function rule(label: string, maxRequests: number, audience = ""): RateLimitRuleData {
  return { label, maxRequests, audience, duration: hour };
}

function get(url: string, status: number, headers?: Record<string, string>): Step {
  return { url, status, ...(headers ? { headers } : {}) };
}

function times(n: number, step: Step): Step[] {
  return Array.from({ length: n }, () => step);
}

function batch(status: number, ...requests: unknown[]): Step {
  return { method: "POST", url: "/api/batch", body: { requests }, status };
}

const createItem = (title: string, url = "/api/collections/demo2/records"): unknown => ({
  method: "POST",
  url,
  body: { title },
});

function post(url: string, body: unknown, status: number, headers?: Record<string, string>): Step {
  return { method: "POST", url, body, status, ...(headers ? { headers } : {}) };
}

const passwordAuth = post(
  "/api/collections/users/auth-with-password",
  { identity: "test@example.com", password: "wrong" },
  400,
);
const otpAuth = post(
  "/api/collections/users/auth-with-otp",
  { otpId: "aaaaaaaaaaaaaaa", password: "12345" },
  400,
);
const tooMany = (s: Step): Step => ({ ...s, status: 429 });

const saveSettings = (body: unknown, status = 200): Step => ({
  method: "PATCH",
  url: "/api/settings",
  headers: superuser,
  body,
  status,
});

const demo2List = "/api/collections/demo2/records";
const userFile = "/api/files/_pb_users_auth_/4q1xlclmfloku33/300_1SEi6Q6U72.png";

// renames demo2, so its rule is relabeled and saved, then fails validation
const failedRenameImport: Step = {
  method: "PUT",
  url: "/api/collections/import",
  headers: superuser,
  body: {
    collections: [{ id: "sz5l5z67tg7gku0", name: "demo2_renamed", listRule: "title =" }],
    deleteMissing: false,
  },
  status: 400,
};

const otpCapped: Step = {
  ...otpAuth,
  status: 429,
  message: "Too many attempts, please try again later with a new OTP.",
};

export const cases: Case[] = [
  // TestDefaultRateLimitMiddleware
  {
    name: "TestDefaultRateLimitMiddleware",
    timed: true,
    rules: [
      { label: "/rate/", maxRequests: 2, duration: 1 },
      { label: "/rate/b", maxRequests: 3, duration: 1 },
      { label: "POST /rate/b", maxRequests: 1, duration: 1 },
      { label: "/rate/guest", maxRequests: 1, duration: 1, audience: "@guest" },
      { label: "/rate/auth", maxRequests: 1, duration: 1, audience: "@auth" },
    ],
    steps: [
      ...times(5, get("/norate", 404)),

      get("/rate/a", 404),
      { ...get("/rate/a", 404), waitMs: 900 }, // (fixed window check) wait enough to ensure that it can't fit more than 2 requests in 1s
      { ...get("/rate/a", 404), waitMs: 900 },
      get("/rate/a", 404),
      get("/rate/a", 429),
      get("/rate/a", 429),
      { ...get("/rate/a", 404), waitMs: 1000 },
      get("/rate/a", 404),
      get("/rate/a", 429),

      get("/rate/b", 404),
      get("/rate/b", 404),
      get("/rate/b", 404),
      get("/rate/b", 429),
      { ...get("/rate/b", 404), waitMs: 1000 },
      get("/rate/b", 404),
      get("/rate/b", 404),
      get("/rate/b", 429),

      // "auth" with guest (should fallback to the /rate/ rule)
      get("/rate/auth", 404),
      get("/rate/auth", 404),
      get("/rate/auth", 429),
      get("/rate/auth", 429),

      // "auth" rule with regular user (should match the /rate/auth rule)
      get("/rate/auth", 404, user),
      get("/rate/auth", 429, user),
      get("/rate/auth", 429, user),

      // "guest" with guest (should match the /rate/guest rule)
      get("/rate/guest", 404),
      get("/rate/guest", 429),
      get("/rate/guest", 429),

      // "guest" rule with regular user (should fallback to the /rate/ rule)
      { ...get("/rate/guest", 404, user), waitMs: 1000 },
      get("/rate/guest", 404, user),
      get("/rate/guest", 429, user),
      get("/rate/guest", 429, user),
    ],
  },

  // TestDefaultRateLimitMiddlewareSkipChecks
  {
    name: "skip checks: base check",
    rules: [{ label: "/rate", maxRequests: 1, duration: 5 }],
    steps: [get("/rate", 404), get("/rate", 429), get("/rate", 429)],
  },
  {
    name: "skip checks: disabled rate limiter",
    enabled: false,
    rules: [{ label: "/rate", maxRequests: 1, duration: 5 }],
    steps: times(3, get("/rate", 404)),
  },
  {
    name: "skip checks: authenticated as superuser",
    rules: [{ label: "/rate", maxRequests: 1, duration: 5 }],
    steps: times(3, get("/rate", 404, superuser)),
  },
  {
    name: "skip checks: excludedIPs (different)",
    excludedIPs: ["10.0.0.0"],
    trustedProxyHeaders: ["x-test-ip"],
    rules: [{ label: "/rate", maxRequests: 1, duration: 5 }],
    steps: [get("/rate", 404, testIP), get("/rate", 429, testIP), get("/rate", 429, testIP)],
  },
  {
    name: "skip checks: excludedIPs (match)",
    excludedIPs: ["127.0.0.1"],
    trustedProxyHeaders: ["x-test-ip"],
    rules: [{ label: "/rate", maxRequests: 1, duration: 5 }],
    steps: times(3, get("/rate", 404, testIP)),
  },
  {
    name: "excludedIPs: a subnet, on collection and auth routes and batch items",
    excludedIPs: ["bad", "127.0.0.0/8"],
    rules: [rule("*:list", 0), rule("*:auth", 0), rule("/rate", 0), rule("*:create", 0)],
    steps: [
      get(demo2List, 200),
      passwordAuth,
      get("/rate", 404),
      batch(200, createItem("excluded")),
    ],
  },
  {
    name: "excludedIPs: another subnet",
    excludedIPs: ["127.0.0.0/32", "::1/128"],
    rules: [rule("/rate", 0)],
    steps: [get("/rate", 429)],
  },
  {
    name: "a disabled limiter skips collection, auth and file rules",
    enabled: false,
    rules: [rule("*:list", 0), rule("*:auth", 0), rule("*:file", 0), rule("*:create", 0)],
    steps: [
      get(demo2List, 200),
      passwordAuth,
      get(userFile, 200),
      batch(200, createItem("disabled")),
    ],
  },

  // windows
  {
    name: "a collection rule's fixed window",
    timed: true,
    rules: [{ label: "demo2:list", maxRequests: 1, duration: 1 }],
    steps: [
      get(demo2List, 200),
      get(demo2List, 429),
      { ...get(demo2List, 200), waitMs: 1000 },
      get(demo2List, 429),
    ],
  },
  {
    name: "a window starts at its first request, and is not extended by refused ones",
    timed: true,
    rules: [{ label: "/rate/a", maxRequests: 1, duration: 2 }],
    steps: [
      get("/rate/a", 404),
      { ...get("/rate/a", 429), waitMs: 1000 },
      { ...get("/rate/a", 404), waitMs: 1000 },
      { ...get("/rate/a", 429), waitMs: 1000 },
    ],
  },
  {
    name: "a rule with no duration opens a new window for every request",
    rules: [{ label: "/rate/a", maxRequests: 1, duration: 0 }],
    steps: times(3, get("/rate/a", 404)),
  },
  {
    name: "a rule with no requests refuses everyone",
    rules: [{ label: "/rate/a", maxRequests: 0, duration: 0 }],
    steps: [get("/rate/a", 429), get("/rate/a", 429, user)],
  },

  // audiences and the client key
  {
    name: "an @guest rule applies to guests only",
    rules: [rule("/rate/a", 1, "@guest")],
    steps: [
      get("/rate/a", 404),
      get("/rate/a", 429),
      get("/rate/a", 404, user),
      get("/rate/a", 404, user),
    ],
  },
  {
    name: "an @auth rule applies to authenticated clients only",
    rules: [rule("/rate/a", 1, "@auth")],
    steps: [
      get("/rate/a", 404, user),
      get("/rate/a", 429, user),
      get("/rate/a", 404),
      get("/rate/a", 404),
    ],
  },
  {
    name: "the same label for both audiences",
    rules: [rule("/rate/a", 1, "@guest"), rule("/rate/a", 2, "@auth")],
    steps: [
      get("/rate/a", 404),
      get("/rate/a", 429),
      get("/rate/a", 404, user),
      get("/rate/a", 404, user),
      get("/rate/a", 429, user),
    ],
  },
  {
    name: "a collection rule by audience, with the fallback to the next label",
    rules: [rule("demo2:list", 1, "@auth"), rule("*:list", 2, "@guest")],
    steps: [
      get(demo2List, 200, user),
      get(demo2List, 429, user),
      get(demo2List, 200),
      get(demo2List, 200),
      get(demo2List, 429),
    ],
  },
  {
    name: "the client is its IP: guests and users share an allowance",
    rules: [rule("/rate/a", 2)],
    steps: [
      get("/rate/a", 404),
      get("/rate/a", 404, user),
      get("/rate/a", 429, client),
      get("/rate/a", 429),
    ],
  },
  {
    name: "an invalid token is a guest",
    rules: [rule("/rate/a", 0, "@guest"), rule("/rate/b", 0, "@auth")],
    steps: [get("/rate/a", 429, auth("invalid")), get("/rate/b", 404, auth("invalid"))],
  },
  {
    name: "a superuser is never limited on collection routes",
    rules: [rule("demo1:list", 0), rule("*:auth", 0)],
    steps: [
      ...times(2, get("/api/collections/demo1/records", 200, superuser)),
      {
        ...post("/api/collections/users/auth-refresh", {}, 403, superuser),
      },
    ],
  },
  {
    name: "a superuser outside the whitelist gets the whitelist's 403, a guest the limit",
    superuserIPs: ["10.0.0.1"],
    rules: [rule("/rate/a", 0)],
    steps: [get("/rate/a", 403, superuser), get("/rate/a", 429)],
  },

  // labels
  {
    name: "<collection>:<action> before *:<action>, each with its own limiter",
    rules: [rule("*:list", 2), rule("demo2:list", 1)],
    steps: [
      get(demo2List, 200),
      get(demo2List, 429),
      get("/api/collections/view2/records", 200),
      get("/api/collections/view2/records", 200),
      get("/api/collections/view2/records", 429),
    ],
  },
  {
    name: "*:<action> counts per collection",
    rules: [rule("*:list", 1)],
    steps: [
      get(demo2List, 200),
      get("/api/collections/view2/records", 200),
      get(demo2List, 429),
      get("/api/collections/view2/records", 429),
    ],
  },
  {
    name: "a collection by name or id shares its limiter",
    rules: [rule("demo2:list", 1)],
    steps: [get(demo2List, 200), get("/api/collections/sz5l5z67tg7gku0/records", 429)],
  },
  {
    name: "tags before path rules, whatever the stored order",
    rules: [rule("/api/collections/demo2/records", 0), rule("*:list", 1)],
    steps: [get(demo2List, 200), get(demo2List, 429)],
  },
  {
    name: "the plain * label is never checked",
    rules: [rule("*", 0)],
    steps: [get(demo2List, 200), get("/rate/a", 404)],
  },
  {
    name: "a path rule with the method before one without",
    rules: [rule("/api/collections/demo2/records", 5), rule("GET " + demo2List, 1)],
    steps: [
      get(demo2List, 200),
      get(demo2List, 429),
      post(demo2List, { title: "with a method" }, 200),
    ],
  },
  {
    name: "a path rule on a collection route, without a method",
    rules: [rule(demo2List, 1)],
    steps: [get(demo2List, 200), post(demo2List, { title: "second" }, 200), get(demo2List, 429)],
  },
  {
    name: "a prefix rule with a method",
    rules: [rule("GET /api/collections/demo2/", 1)],
    steps: [
      get(demo2List, 200),
      get(demo2List + "/0yxhwia2amd8gec", 200),
      get(demo2List, 429),
      post(demo2List, { title: "another method" }, 200),
    ],
  },
  {
    name: "HEAD is not GET for a rule",
    rules: [rule("GET /api/settings", 0)],
    steps: [{ method: "HEAD", url: "/api/settings", status: 401 }, get("/api/settings", 429)],
  },
  {
    name: "a prefix rule matches its own path, and the query does not count",
    rules: [rule("/rate/", 2)],
    steps: [get("/rate", 404), get("/rate/?a=1", 404), get("/rate/x/y?b=2", 429)],
  },
  {
    name: "labels read the decoded path",
    rules: [rule("/rate/b", 0)],
    steps: [get("/rate%2Fb", 429)],
  },
  {
    name: "the longest label is not looked for: a direct match, then prefixes in stored order",
    rules: [rule("/rate/", 1), rule("/rate/x/", 3), rule("/rate/x/b", 2)],
    steps: [
      get("/rate/x/b", 404),
      get("/rate/x/b", 404),
      get("/rate/x/b", 429),
      get("/rate/x/a", 404),
      get("/rate/x/a", 429),
    ],
  },
  {
    name: "prefix rules in the other stored order",
    rules: [rule("/rate/x/", 3), rule("/rate/", 1)],
    steps: [...times(3, get("/rate/x/a", 404)), get("/rate/x/a", 429)],
  },
  {
    name: "a prefix rule on the collection routes, shared by actions",
    rules: [rule("/api/collections/", 1)],
    steps: [
      get(demo2List, 200),
      get(demo2List, 429),
      // each collection route has its own limiter
      get(demo2List + "/0yxhwia2amd8gec", 200),
      get(demo2List + "/0yxhwia2amd8gec", 429),
    ],
  },
  {
    name: "routes without a collection: realtime, settings, the dashboard path",
    rules: [rule("/api/realtime", 0), rule("/api/settings", 0), rule("/_/", 0)],
    steps: [
      get("/api/realtime", 429),
      post("/api/realtime", {}, 429),
      get("/api/settings", 429),
      get("/_/", 429),
    ],
  },
  {
    name: "a method no route has is limited too",
    rules: [rule("/rate/a", 0), rule("POST /rate/b", 0)],
    steps: [post("/rate/a", {}, 429), post("/rate/b", {}, 429), get("/rate/b", 404)],
  },

  // order against the other failures
  {
    name: "an unknown collection is a 404 before any limit",
    rules: [rule("*:list", 0), rule("*:view", 0), rule("*:auth", 0), rule("*:file", 0)],
    steps: [
      get("/api/collections/missing/records", 404),
      get("/api/collections/missing/records/abc", 404),
      post("/api/collections/missing/auth-with-password", {}, 404),
      get("/api/files/missing/abc/file.png", 404),
    ],
  },
  {
    name: "an unknown collection is a 404 before a path rule on its route",
    rules: [rule("/api/collections/", 0), rule("/api/files/", 0)],
    steps: [
      get("/api/collections/missing/records", 404),
      post("/api/collections/missing/auth-with-password", {}, 404),
      get("/api/files/missing/abc/file.png", 404),
      get("/api/collections", 429),
    ],
  },
  {
    name: "a view collection's write is a 400 before the limit, its reads are limited",
    rules: [
      rule("*:list", 0),
      rule("*:view", 0),
      rule("*:create", 0),
      rule("*:update", 0),
      rule("*:delete", 0),
    ],
    steps: [
      post("/api/collections/view2/records", {}, 400),
      { method: "PATCH", url: "/api/collections/view2/records/abc", body: {}, status: 400 },
      { method: "DELETE", url: "/api/collections/view2/records/abc", status: 400 },
      get("/api/collections/view2/records", 429),
      get("/api/collections/view2/records/abc", 429),
    ],
  },
  {
    name: "the limit comes before the body is read",
    rules: [rule("demo2:create", 1), rule("users:authWithPassword", 1)],
    steps: [
      post(demo2List, "{", 400),
      post(demo2List, "{", 429),
      post("/api/collections/users/auth-with-password", "{", 400),
      post("/api/collections/users/auth-with-password", "{", 429),
    ],
  },
  {
    name: "the limit comes before the record lookup",
    rules: [rule("demo2:view", 1), rule("demo2:update", 1), rule("demo2:delete", 1)],
    steps: [
      get(demo2List + "/missing", 404),
      get(demo2List + "/missing", 429),
      { method: "PATCH", url: demo2List + "/missing", body: {}, status: 404 },
      { method: "PATCH", url: demo2List + "/missing", body: {}, status: 429 },
      { method: "DELETE", url: demo2List + "/missing", status: 404 },
      { method: "DELETE", url: demo2List + "/missing", status: 429 },
    ],
  },
  {
    name: "the limit comes before the 401 of a route's auth guard",
    rules: [rule("users:authRefresh", 1), rule("users:requestEmailChange", 0)],
    steps: [
      post("/api/collections/users/auth-refresh", {}, 401),
      post("/api/collections/users/auth-refresh", {}, 429),
      post("/api/collections/users/request-email-change", { newEmail: "a@b.c" }, 429),
    ],
  },
  {
    name: "the limit comes before the 403 of a route's auth guard",
    rules: [rule("users:authRefresh", 1)],
    steps: [
      post("/api/collections/users/auth-refresh", {}, 403, client),
      post("/api/collections/users/auth-refresh", {}, 429, client),
    ],
  },
  {
    name: "the limit comes before a superuser-only list's 403",
    rules: [rule("demo1:list", 1)],
    steps: [get("/api/collections/demo1/records", 403), get("/api/collections/demo1/records", 429)],
  },
  {
    name: "the global limit comes before a route's guard",
    rules: [rule("/api/settings", 2)],
    steps: [
      get("/api/settings", 401),
      get("/api/settings", 403, user),
      get("/api/settings", 429),
      get("/api/settings", 200, superuser),
    ],
  },

  // auth routes and their tags
  {
    name: "the action tag before the shared auth tag",
    rules: [rule("users:auth", 5), rule("users:authWithPassword", 1)],
    steps: [passwordAuth, tooMany(passwordAuth)],
  },
  {
    name: "<collection>:auth before *:authWithPassword",
    rules: [rule("*:authWithPassword", 1), rule("users:auth", 2)],
    steps: [passwordAuth, passwordAuth, tooMany(passwordAuth)],
  },
  {
    name: "*:authWithPassword before *:auth",
    rules: [rule("*:auth", 2), rule("*:authWithPassword", 1)],
    steps: [passwordAuth, tooMany(passwordAuth)],
  },
  {
    name: "a shared auth tag counts per route",
    rules: [rule("users:auth", 1)],
    steps: [passwordAuth, otpAuth, tooMany(passwordAuth), tooMany(otpAuth)],
  },
  {
    name: "an auth route with no matching tag falls back to its path",
    rules: [rule("/api/collections/users/auth-with-password", 1)],
    steps: [passwordAuth, tooMany(passwordAuth)],
  },
  {
    name: "a prefix rule on the auth routes counts per route",
    rules: [rule("/api/collections/", 1)],
    steps: [
      get("/api/collections/users/auth-methods", 200),
      get("/api/collections/users/auth-methods", 429),
      passwordAuth,
      tooMany(passwordAuth),
    ],
  },
  {
    name: "the file route's tag, and a missing file counts",
    rules: [rule("users:file", 2)],
    steps: [
      get("/api/files/_pb_users_auth_/4q1xlclmfloku33/missing.png", 404),
      get(userFile, 200),
      get(userFile, 429),
    ],
  },

  // batch items
  {
    name: "a batch item's collection rule, with its own limiter",
    rules: [rule("demo2:create", 1)],
    steps: [
      batch(200, createItem("batch 1")),
      batch(400, createItem("batch 2")),
      post(demo2List, { title: "route 1" }, 200),
      post(demo2List, { title: "route 2" }, 429),
      batch(400, createItem("batch 3")),
    ],
  },
  {
    name: "a batch item past the limit fails the batch, and what it used stays used",
    rules: [rule("demo2:create", 2)],
    steps: [
      batch(400, createItem("a"), createItem("b"), createItem("c")),
      get(`${demo2List}?filter=title~'a'`, 200),
      batch(400, createItem("d")),
    ],
  },
  {
    name: "a batch item's *:<action>",
    rules: [rule("*:update", 0)],
    steps: [
      batch(400, { method: "PATCH", url: demo2List + "/0yxhwia2amd8gec", body: { title: "x" } }),
    ],
  },
  {
    name: "a batch item's delete rule",
    rules: [rule("demo2:delete", 0)],
    steps: [batch(400, { method: "DELETE", url: demo2List + "/0yxhwia2amd8gec" })],
  },
  {
    name: "an upsert item checks the action it becomes",
    rules: [rule("demo2:update", 0)],
    steps: [
      batch(200, { method: "PUT", url: demo2List, body: { title: "upserted" } }),
      batch(400, { method: "PUT", url: demo2List, body: { id: "0yxhwia2amd8gec", title: "x" } }),
    ],
  },
  {
    name: "a batch item's path rule reads the item's method and path, without its query",
    rules: [rule("POST " + demo2List, 1)],
    steps: [
      batch(200, createItem("p1", demo2List + "?expand=x")),
      batch(400, createItem("p2", demo2List + "?expand=y")),
    ],
  },
  {
    name: "a batch item's audience comes from the batch request",
    rules: [rule("demo2:create", 0, "@auth")],
    steps: [
      batch(200, createItem("guest")),
      {
        ...batch(400, {
          ...(createItem("user") as object),
          headers: { Authorization: "ignored" },
        }),
        headers: user,
      },
    ],
  },
  {
    name: "a superuser's batch items are not limited",
    rules: [rule("demo2:create", 0)],
    steps: [{ ...batch(200, createItem("superuser")), headers: superuser }],
  },
  {
    name: "a view item is rejected before its limit",
    rules: [rule("*:create", 0)],
    steps: [batch(400, createItem("view", "/api/collections/view2/records"))],
  },
  {
    name: "the batch route's own rule comes before its items",
    rules: [rule("/api/batch", 1), rule("demo2:create", 5)],
    steps: [
      batch(200, createItem("once")),
      batch(429, createItem("twice")),
      post("/api/batch", "{", 429),
    ],
  },

  // settings
  {
    name: "a saved rule applies without a restart, in fresh windows",
    rules: [rule("/rate/a", 1)],
    steps: [
      get("/rate/a", 404),
      get("/rate/a", 429),
      saveSettings({
        rateLimits: { rules: [{ label: "/rate/a", duration: hour, maxRequests: 2 }] },
      }),
      get("/rate/a", 404),
      get("/rate/a", 404),
      get("/rate/a", 429),
    ],
  },
  {
    name: "enabling and disabling through the settings",
    enabled: false,
    rules: [rule("/rate/a", 1)],
    steps: [
      get("/rate/a", 404),
      get("/rate/a", 404),
      saveSettings({ rateLimits: { enabled: true } }),
      get("/rate/a", 404),
      get("/rate/a", 429),
      saveSettings({ rateLimits: { enabled: false } }),
      get("/rate/a", 404),
    ],
  },
  {
    name: "saving any setting resets the windows",
    rules: [rule("/rate/a", 1), rule("demo2:list", 1)],
    steps: [
      get("/rate/a", 404),
      get("/rate/a", 429),
      get(demo2List, 200),
      get(demo2List, 429),
      saveSettings({ meta: { appName: "renamed" } }),
      get("/rate/a", 404),
      get(demo2List, 200),
    ],
  },
  {
    name: "a failed save keeps the windows",
    rules: [rule("/rate/a", 1)],
    steps: [get("/rate/a", 404), saveSettings({ meta: { appName: "" } }, 400), get("/rate/a", 429)],
  },
  {
    name: "rules saved through the API keep their stored order",
    rules: [],
    steps: [
      saveSettings({
        rateLimits: {
          enabled: true,
          rules: [
            { label: "/", duration: hour, maxRequests: 1 },
            { label: "/rate/", duration: hour, maxRequests: 3 },
          ],
        },
      }),
      get("/rate/a", 404),
      get("/rate/a", 429),
    ],
  },
  {
    name: "the built-in OTP limiter is reset by a settings save too",
    enabled: false,
    rules: [],
    prepare: (ctx) => {
      setMFA("users", false, "")(ctx);
      insertOTPs("users", "test@example.com", { id: "a".repeat(15) })(ctx);
    },
    steps: [
      ...times(5, otpAuth),
      {
        ...otpAuth,
        status: 429,
        message: "Too many attempts, please try again later with a new OTP.",
      },
      saveSettings({ meta: { appName: "renamed" } }),
      otpAuth,
    ],
  },
  {
    name: "a collection rename relabels its rules and resets the windows",
    rules: [rule("demo2:list", 1), rule("/rate/a", 1)],
    steps: [
      get(demo2List, 200),
      get(demo2List, 429),
      get("/rate/a", 404),
      {
        method: "PATCH",
        url: "/api/collections/demo2",
        headers: superuser,
        body: { name: "demo2_renamed" },
        status: 200,
      },
      get("/api/collections/demo2_renamed/records", 200),
      get("/api/collections/demo2_renamed/records", 429),
      get("/rate/a", 404),
    ],
  },
  {
    name: "a collection rename without a matching rule keeps the windows",
    rules: [rule("demo2:list", 1)],
    steps: [
      get(demo2List, 200),
      {
        method: "PATCH",
        url: "/api/collections/demo4",
        headers: superuser,
        body: { name: "demo4_renamed" },
        status: 200,
      },
      get(demo2List, 429),
    ],
  },
  {
    name: "a failed import that renames a collection keeps the windows",
    rules: [rule("/api/collections/view2/records", 1), rule("demo2:list", 1)],
    steps: [
      get("/api/collections/view2/records", 200),
      get("/api/collections/view2/records", 429),
      failedRenameImport,
      get("/api/collections/view2/records", 429),
    ],
  },
  {
    name: "a failed import that renames a collection keeps the built-in OTP limiter",
    rules: [rule("demo2:list", 1)],
    prepare: (ctx) => {
      setMFA("users", false, "")(ctx);
      insertOTPs("users", "test@example.com", { id: "a".repeat(15) })(ctx);
    },
    steps: [...times(5, otpAuth), otpCapped, failedRenameImport, otpCapped],
  },
];
