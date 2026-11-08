// docs/design/13-ssr.md ("Framework adapters", "Session cookie", "Browser client and realtime",
// "OAuth2", "CSRF"). The Astro middleware through its public API, with a stub iglo.base.
import { describe, expect, test } from "bun:test";
import {
  createSessionCache,
  createSuperuserClient,
  ServerClient,
  SSR_NO_CACHE_HEADERS,
} from "@sdk/ssr/index";
import { createAstroAuth, type AstroAuth, type AstroContext } from "@sdk/ssr/astro";
import type { AdapterOptions, AdapterRoutes } from "@sdk/ssr/adapter";
import {
  API,
  APP,
  authToken,
  json,
  record,
  stubApi,
  superuserToken,
  testClock,
  type Handler,
} from "@sdk-test/ssr/browser-support";

const T0 = Math.floor(Date.now() / 1000);
const clock = testClock(T0 * 1000);

const routesWith = (routes: Partial<AdapterRoutes>) => ({ routes });

interface CookieWrite {
  name: string;
  value: string;
  options: Record<string, unknown>;
}

/** The user id a token names. */
function idOf(token: string | null): string {
  const payload = JSON.parse(Buffer.from((token ?? "").split(".")[1] ?? "", "base64").toString());
  return String(payload.id);
}

/** An iglo.base that refreshes every session to a token that lasts an hour. */
function iglo(
  routes: Record<string, Handler> = {},
  refreshed = (id: string) => authToken(T0 + 3600, id),
) {
  return stubApi(clock, {
    "POST /api/collections/users/auth-refresh": (call) => {
      const id = idOf(call.headers.get("authorization"));
      return json(clock, 200, { token: refreshed(id), record: record(id) });
    },
    ...routes,
  });
}

async function adapter(
  api: ReturnType<typeof iglo>,
  extra: Partial<AdapterOptions> = {},
): Promise<AstroAuth> {
  const superuser = await createSuperuserClient({
    url: API,
    token: superuserToken(T0 + 99999),
    fetch: api.fetch,
    clock,
  });
  return createAstroAuth({
    url: API,
    origin: APP,
    sessionCache: createSessionCache(),
    superuser,
    clock,
    fetch: api.fetch,
    ...extra,
  });
}

/** An Astro context whose cookie store records what the middleware sets. */
function makeContext(
  path: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    cookies?: Record<string, string>;
  } = {},
) {
  const url = new URL(path, APP);
  const jar = Object.entries(init.cookies ?? {}).map(([name, value]) => ({ name, value }));
  const headers = new Headers(init.headers);
  if (jar.length > 0) {
    headers.set("cookie", jar.map((c) => `${c.name}=${encodeURIComponent(c.value)}`).join("; "));
  }
  const request = new Request(url, { method: init.method ?? "GET", headers, body: init.body });
  const sets: CookieWrite[] = [];
  const deletes: string[] = [];
  const context: AstroContext = {
    request,
    url,
    cookies: {
      get: (name) => {
        const found = jar.find((c) => c.name === name);
        return found ? { value: found.value } : undefined;
      },
      set: (name, value, options) => {
        sets.push({ name, value, options: options ?? {} });
      },
      delete: (name) => {
        deletes.push(name);
      },
    },
    locals: {},
  };
  return { context, sets, deletes };
}

/** The `next` of an app that answers `200 app` and records the contexts it saw. */
function appNext(context: AstroContext) {
  const seen: AstroContext[] = [];
  const next = async (): Promise<Response> => {
    seen.push(context);
    return new Response("app", { status: 200 });
  };
  return { next, seen };
}

function sessionCookie(token: string, id = "u1") {
  return JSON.stringify({ token, record: record(id) });
}

async function run(auth: AstroAuth, path: string, init?: Parameters<typeof makeContext>[1]) {
  const made = makeContext(path, init);
  const app = appNext(made.context);
  const response = await auth.onRequest(made.context, app.next);
  return { response, sets: made.sets, deletes: made.deletes, context: made.context, app };
}

describe("createAstroAuth", () => {
  test("throws a TypeError without a superuser client and without readableCookie", () => {
    expect(() => createAstroAuth({ url: API, sessionCache: createSessionCache() })).toThrow(
      TypeError,
    );
  });

  test("accepts readableCookie without a superuser client", () => {
    expect(() =>
      createAstroAuth({ url: API, sessionCache: createSessionCache(), readableCookie: true }),
    ).not.toThrow();
  });
});

describe("onRequest: the session on locals", () => {
  test("resumes the session and sets pb and pbBrowserToken", async () => {
    const api = iglo({
      "POST /api/collections/users/impersonate/u1": () =>
        json(clock, 200, { token: authToken(T0 + 900, "u1"), record: record("u1") }),
    });
    const auth = await adapter(api);
    const { app, context } = await run(auth, "/dashboard", {
      cookies: { pb_auth: sessionCookie(authToken(T0 + 3600, "u1")) },
    });

    const locals = app.seen[0]?.locals as {
      pb?: ServerClient;
      pbBrowserToken?: () => Promise<{ token: string; record: { id: string } } | null>;
    };
    expect(locals.pb).toBeInstanceOf(ServerClient);
    expect(locals.pb?.authStore.record?.id).toBe("u1");
    expect(locals.pb?.authStore.isValid).toBe(true);
    expect(app.seen[0]).toBe(context);

    const minted = await locals.pbBrowserToken?.();
    expect(minted?.token).toBe(authToken(T0 + 900, "u1"));
    expect(minted?.record?.id).toBe("u1");
  });

  test("pbBrowserToken resolves to null when nobody is signed in", async () => {
    const api = iglo();
    const auth = await adapter(api);
    const { app } = await run(auth, "/");
    const locals = app.seen[0]?.locals as {
      pb?: ServerClient;
      pbBrowserToken?: () => Promise<unknown>;
    };
    expect(locals.pb?.authStore.isValid).toBe(false);
    expect(await locals.pbBrowserToken?.()).toBeNull();
    expect(api.calls.filter((c) => c.path.includes("/impersonate/"))).toHaveLength(0);
  });
});

describe("onRequest: cookie writes", () => {
  test("a refreshed session is written through context.cookies with the attributes, and no-cache headers are set", async () => {
    const auth = await adapter(iglo());
    const { response, sets } = await run(auth, "/", {
      cookies: { pb_auth: sessionCookie(authToken(T0 + 60, "u1")) },
    });

    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatchObject({ name: "pb_auth" });
    expect(sets[0]?.options).toMatchObject({
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      maxAge: 3600,
    });
    expect(response.headers.get("cache-control")).toBe(
      SSR_NO_CACHE_HEADERS["Cache-Control"] ?? null,
    );
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(response.headers.get("expires")).toBe("0");
  });

  test("on https the cookie is __Host- prefixed and Secure", async () => {
    const auth = await adapter(iglo(), { origin: "https://app.example.com" });
    const { sets } = await run(auth, "https://app.example.com/", {
      cookies: { "__Host-pb_auth": sessionCookie(authToken(T0 + 60, "u1")) },
    });
    expect(sets[0]?.name).toBe("__Host-pb_auth");
    expect(sets[0]?.options).toMatchObject({ path: "/", secure: true });
  });

  test("a revoked session writes a cleared cookie", async () => {
    const api = iglo({
      "POST /api/collections/users/auth-refresh": () => json(clock, 401, { message: "gone" }),
    });
    const auth = await adapter(api);
    const { sets, app } = await run(auth, "/", {
      cookies: { pb_auth: sessionCookie(authToken(T0 + 3600, "u1")) },
    });

    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatchObject({ name: "pb_auth", value: "", options: { maxAge: 0 } });
    const locals = app.seen[0]?.locals as { pb?: ServerClient };
    expect(locals.pb?.authStore.isValid).toBe(false);
  });

  test("a request that writes no cookie gets no no-cache headers", async () => {
    const auth = await adapter(iglo());
    const { response, sets } = await run(auth, "/");
    expect(sets).toHaveLength(0);
    expect(response.headers.get("cache-control")).toBeNull();
  });
});

describe("onRequest: CSRF guard", () => {
  test("a POST with the session cookie from a foreign origin is rejected with 403 before next", async () => {
    const auth = await adapter(iglo());
    const { response, app } = await run(auth, "/api/things", {
      method: "POST",
      headers: { origin: "https://evil.example" },
      cookies: { pb_auth: sessionCookie(authToken(T0 + 3600, "u1")) },
    });
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Cross-site request rejected.");
    expect(app.seen).toHaveLength(0);
  });

  test("csrf: false lets the same request through", async () => {
    const auth = await adapter(iglo(), { csrf: false });
    const { response, app } = await run(auth, "/api/things", {
      method: "POST",
      headers: { origin: "https://evil.example" },
      cookies: { pb_auth: sessionCookie(authToken(T0 + 3600, "u1")) },
    });
    expect(response.status).toBe(200);
    expect(app.seen).toHaveLength(1);
  });

  test("a GET from a foreign origin is never rejected", async () => {
    const auth = await adapter(iglo());
    const { response, app } = await run(auth, "/", {
      headers: { origin: "https://evil.example" },
      cookies: { pb_auth: sessionCookie(authToken(T0 + 3600, "u1")) },
    });
    expect(response.status).toBe(200);
    expect(app.seen).toHaveLength(1);
  });
});

describe("onRequest: adapter routes", () => {
  test("the renew route answers at its path with a minted token", async () => {
    const api = iglo({
      "POST /api/collections/users/impersonate/u1": () =>
        json(clock, 200, { token: authToken(T0 + 900, "u1"), record: record("u1") }),
    });
    const auth = await adapter(api);
    const { response, app } = await run(auth, "/api/pb/renew", {
      method: "POST",
      headers: { origin: APP },
      cookies: { pb_auth: sessionCookie(authToken(T0 + 3600, "u1")) },
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { token: string }).token).toBe(authToken(T0 + 900, "u1"));
    expect(app.seen).toHaveLength(0);
  });

  test("the renew route is not mounted at other paths", async () => {
    const auth = await adapter(iglo());
    const { app } = await run(auth, "/api/other/renew", {
      method: "POST",
      headers: { origin: APP },
    });
    expect(app.seen).toHaveLength(1);
  });

  test("routes: { renew: false } leaves the renew path to the app", async () => {
    const auth = await adapter(iglo(), routesWith({ renew: false }));
    const { app } = await run(auth, "/api/pb/renew", { method: "POST", headers: { origin: APP } });
    expect(app.seen).toHaveLength(1);
  });

  test("a configured renew path replaces the default one", async () => {
    const auth = await adapter(iglo(), routesWith({ renew: "/session/renew" }));
    const custom = await run(auth, "/session/renew", { method: "POST", headers: { origin: APP } });
    expect(custom.response.status).toBe(401);
    expect(custom.app.seen).toHaveLength(0);

    const defaults = await run(auth, "/api/pb/renew", { method: "POST", headers: { origin: APP } });
    expect(defaults.app.seen).toHaveLength(1);
  });

  test("the popup route completes a popup sign-in and writes the session cookie on its response", async () => {
    const auth = await adapter(iglo({}, () => authToken(T0 + 3600, "u1")));
    const { response, sets, app } = await run(auth, "/api/pb/popup", {
      method: "POST",
      headers: { origin: APP, "content-type": "application/json" },
      body: JSON.stringify({ token: authToken(T0 + 600, "u1") }),
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { record: { id: string } }).record.id).toBe("u1");
    expect(response.headers.getSetCookie().some((c) => c.startsWith("pb_auth="))).toBe(true);
    expect(sets).toHaveLength(0);
    expect(app.seen).toHaveLength(0);
  });

  test("the popup route is not mounted at other paths", async () => {
    const auth = await adapter(iglo(), routesWith({ popup: "/sign-in/popup" }));
    const { app } = await run(auth, "/api/pb/popup", {
      method: "POST",
      headers: { origin: APP, "content-type": "application/json" },
      body: "{}",
    });
    expect(app.seen).toHaveLength(1);
  });

  test("the OAuth2 start route redirects to the provider with the callback as redirect_uri", async () => {
    const callback = `${APP}/api/pb/oauth2/callback`;
    const api = iglo({
      "GET /api/collections/users/auth-methods": () =>
        json(clock, 200, {
          password: { enabled: false, identityFields: [] },
          otp: { enabled: false, duration: 0 },
          mfa: { enabled: false, duration: 0 },
          oauth2: {
            enabled: true,
            providers: [
              {
                name: "oidc",
                displayName: "OIDC",
                state: "S1",
                codeVerifier: "V1",
                codeChallenge: "C1",
                codeChallengeMethod: "S256",
                authURL: "https://idp.example/authorize?client_id=c&state=S1&redirect_uri=",
              },
            ],
          },
        }),
    });
    const auth = await adapter(api);
    const { response, sets } = await run(auth, "/api/pb/oauth2/start/oidc?redirectTo=/home");
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe("https://idp.example");
    expect(location.searchParams.get("redirect_uri")).toBe(callback);
    expect(response.headers.getSetCookie().some((c) => c.startsWith("pb_oauth2="))).toBe(true);
    expect(sets).toHaveLength(0);
  });

  test("the OAuth2 start route answers 404 for an unknown provider", async () => {
    const api = iglo({
      "GET /api/collections/users/auth-methods": () =>
        json(clock, 200, { oauth2: { enabled: true, providers: [] } }),
    });
    const auth = await adapter(api);
    const { response } = await run(auth, "/api/pb/oauth2/start/nobody");
    expect(response.status).toBe(404);
  });

  test("the OAuth2 callback without the temporary cookie redirects with the error", async () => {
    const auth = await adapter(iglo());
    const { response } = await run(auth, "/api/pb/oauth2/callback?code=x&state=y");
    expect(response.status).toBe(302);
    // absolute, as Next.js needs it; the path and the error query are what matters
    const target = new URL(response.headers.get("location") ?? "");
    expect(target.pathname).toBe("/");
    expect(target.search).toBe("?oauth2_error=missing-cookie");
  });

  test("the OAuth2 routes are not mounted when their paths are false", async () => {
    const auth = await adapter(iglo(), routesWith({ oauth2Start: false, oauth2Callback: false }));
    const start = await run(auth, "/api/pb/oauth2/start/oidc");
    const callback = await run(auth, "/api/pb/oauth2/callback?code=x&state=y");
    expect(start.app.seen).toHaveLength(1);
    expect(callback.app.seen).toHaveLength(1);
  });
});

describe("onRequest: concurrent requests", () => {
  test("two users in parallel each see their own record", async () => {
    const api = iglo();
    const auth = await adapter(api);
    const users = ["u1", "u2"];

    const results = await Promise.all(
      users.map(async (id) => {
        const { context } = makeContext("/", {
          cookies: { pb_auth: sessionCookie(authToken(T0 + 3600, id), id) },
        });
        let seenId = "";
        let seenPb: ServerClient | undefined;
        await auth.onRequest(context, async () => {
          const locals = context.locals as { pb?: ServerClient };
          seenId = locals.pb?.authStore.record?.id ?? "";
          seenPb = locals.pb;
          return new Response(seenId);
        });
        return { seenId, seenPb };
      }),
    );

    expect(results.map((r) => r.seenId)).toEqual(["u1", "u2"]);
    expect(results[0]?.seenPb).not.toBe(results[1]?.seenPb);
    expect(api.calls.map((c) => idOf(c.headers.get("authorization")))).toEqual(["u1", "u2"]);
  });
});
