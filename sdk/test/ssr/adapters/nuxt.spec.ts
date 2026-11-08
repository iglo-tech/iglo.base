// docs/design/13-ssr.md ("Framework adapters", "Session cookie", "Browser client and realtime",
// "OAuth2", "CSRF"). The Nuxt (Nitro) middleware through its public API, with a stub iglo.base.
import { describe, expect, test } from "bun:test";
import {
  createSessionCache,
  createSuperuserClient,
  ServerClient,
  SSR_NO_CACHE_HEADERS,
} from "@sdk/ssr/index";
import {
  createNuxtAuth,
  type NuxtAuth,
  type NuxtCookieOptions,
  type NuxtEvent,
} from "@sdk/ssr/nuxt";
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

interface SetCookie {
  name: string;
  value: string;
  options: NuxtCookieOptions;
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
): Promise<NuxtAuth> {
  const superuser = await createSuperuserClient({
    url: API,
    token: superuserToken(T0 + 99999),
    fetch: api.fetch,
    clock,
  });
  return createNuxtAuth({
    url: API,
    origin: APP,
    sessionCache: createSessionCache(),
    superuser,
    clock,
    fetch: api.fetch,
    ...extra,
  });
}

/** A Nitro event whose setters record what the middleware writes. */
function makeEvent(
  path: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    cookies?: Record<string, string>;
    body?: unknown;
    readBody?: () => Promise<unknown>;
  } = {},
) {
  const cookieHeader = Object.entries(init.cookies ?? {})
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join("; ");
  const headers: Record<string, string> = { host: "localhost:3000", ...init.headers };
  if (cookieHeader) {
    headers["cookie"] = cookieHeader;
  }
  const setCookies: SetCookie[] = [];
  const setHeaders: Array<[string, string]> = [];
  const readBody = init.readBody ?? (init.body === undefined ? undefined : async () => init.body);
  const event: NuxtEvent = {
    method: init.method ?? "GET",
    path,
    headers,
    context: {},
    readBody,
    setCookie: (name, value, options) => {
      setCookies.push({ name, value, options });
    },
    setHeader: (name, value) => {
      setHeaders.push([name, value]);
    },
  };
  return { event, setCookies, setHeaders };
}

function sessionCookie(token: string, id = "u1") {
  return JSON.stringify({ token, record: record(id) });
}

async function run(auth: NuxtAuth, path: string, init?: Parameters<typeof makeEvent>[1]) {
  const made = makeEvent(path, init);
  const response = await auth.middleware(made.event);
  return { response, ...made };
}

describe("createNuxtAuth", () => {
  test("throws a TypeError without a superuser client and without readableCookie", () => {
    expect(() => createNuxtAuth({ url: API, sessionCache: createSessionCache() })).toThrow(
      TypeError,
    );
  });

  test("accepts readableCookie without a superuser client", () => {
    expect(() =>
      createNuxtAuth({ url: API, sessionCache: createSessionCache(), readableCookie: true }),
    ).not.toThrow();
  });
});

describe("middleware: the session on the event context", () => {
  test("resumes the session and sets pb and pbBrowserToken on the context", async () => {
    const api = iglo({
      "POST /api/collections/users/impersonate/u1": () =>
        json(clock, 200, { token: authToken(T0 + 900, "u1"), record: record("u1") }),
    });
    const auth = await adapter(api);
    const { event, response } = await run(auth, "/dashboard", {
      cookies: { pb_auth: sessionCookie(authToken(T0 + 3600, "u1")) },
    });

    expect(response).toBeUndefined();
    const pb = event.context["pb"];
    expect(pb).toBeInstanceOf(ServerClient);
    expect((pb as ServerClient).authStore.record?.id).toBe("u1");
    expect((pb as ServerClient).authStore.isValid).toBe(true);

    const pbBrowserToken = event.context["pbBrowserToken"] as () => Promise<{
      token: string;
      record: { id: string };
    } | null>;
    const minted = await pbBrowserToken();
    expect(minted?.token).toBe(authToken(T0 + 900, "u1"));
    expect(minted?.record.id).toBe("u1");
  });

  test("pbBrowserToken resolves to null when nobody is signed in", async () => {
    const api = iglo();
    const auth = await adapter(api);
    const { event } = await run(auth, "/");
    const pb = event.context["pb"] as ServerClient;
    expect(pb.authStore.isValid).toBe(false);
    const pbBrowserToken = event.context["pbBrowserToken"] as () => Promise<unknown>;
    expect(await pbBrowserToken()).toBeNull();
    expect(api.calls.filter((c) => c.path.includes("/impersonate/"))).toHaveLength(0);
  });
});

describe("middleware: cookie writes", () => {
  test("a refreshed session is written with setCookie and no-cache headers are set", async () => {
    const auth = await adapter(iglo());
    const { setCookies, setHeaders, response } = await run(auth, "/", {
      cookies: { pb_auth: sessionCookie(authToken(T0 + 60, "u1")) },
    });

    expect(response).toBeUndefined();
    expect(setCookies).toHaveLength(1);
    expect(setCookies[0]).toMatchObject({ name: "pb_auth" });
    expect(setCookies[0]?.options).toMatchObject({
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      maxAge: 3600,
    });
    expect(setHeaders).toEqual(Object.entries(SSR_NO_CACHE_HEADERS));
  });

  test("on https the cookie is __Host- prefixed and Secure", async () => {
    const auth = await adapter(iglo(), { origin: "https://app.example.com" });
    const { setCookies } = await run(auth, "/", {
      cookies: { "__Host-pb_auth": sessionCookie(authToken(T0 + 60, "u1")) },
    });
    expect(setCookies[0]?.name).toBe("__Host-pb_auth");
    expect(setCookies[0]?.options).toMatchObject({ path: "/", secure: true });
  });

  test("a revoked session writes a cleared cookie", async () => {
    const api = iglo({
      "POST /api/collections/users/auth-refresh": () => json(clock, 401, { message: "gone" }),
    });
    const auth = await adapter(api);
    const { setCookies, event } = await run(auth, "/", {
      cookies: { pb_auth: sessionCookie(authToken(T0 + 3600, "u1")) },
    });

    expect(setCookies).toHaveLength(1);
    expect(setCookies[0]).toMatchObject({ name: "pb_auth", value: "", options: { maxAge: 0 } });
    expect((event.context["pb"] as ServerClient).authStore.isValid).toBe(false);
  });

  test("a request that writes no cookie sets no headers", async () => {
    const auth = await adapter(iglo());
    const { setCookies, setHeaders } = await run(auth, "/");
    expect(setCookies).toHaveLength(0);
    expect(setHeaders).toHaveLength(0);
  });

  test("without an origin option the origin comes from the Host and x-forwarded-proto headers", async () => {
    const auth = await adapter(iglo(), { origin: undefined });
    const { setCookies } = await run(auth, "/", {
      headers: { host: "app.example.com", "x-forwarded-proto": "https" },
      cookies: { "__Host-pb_auth": sessionCookie(authToken(T0 + 60, "u1")) },
    });
    expect(setCookies[0]?.name).toBe("__Host-pb_auth");
    expect(setCookies[0]?.options).toMatchObject({ secure: true });
  });
});

describe("middleware: CSRF guard", () => {
  test("a POST with the session cookie from a foreign origin is answered 403", async () => {
    const auth = await adapter(iglo());
    const { response, event } = await run(auth, "/api/things", {
      method: "POST",
      headers: { origin: "https://evil.example" },
      cookies: { pb_auth: sessionCookie(authToken(T0 + 3600, "u1")) },
    });
    expect(response?.status).toBe(403);
    expect(await response?.text()).toContain("Cross-site request rejected.");
    expect(event.context["pb"]).toBeUndefined();
  });

  test("the same origin the app is served from passes, when the origin is derived from Host", async () => {
    const auth = await adapter(iglo(), { origin: undefined });
    const { response, event } = await run(auth, "/api/things", {
      method: "POST",
      headers: { origin: "http://localhost:3000" },
      cookies: { pb_auth: sessionCookie(authToken(T0 + 3600, "u1")) },
    });
    expect(response).toBeUndefined();
    expect(event.context["pb"]).toBeInstanceOf(ServerClient);
  });

  test("csrf: false lets the request through", async () => {
    const auth = await adapter(iglo(), { csrf: false });
    const { response, event } = await run(auth, "/api/things", {
      method: "POST",
      headers: { origin: "https://evil.example" },
      cookies: { pb_auth: sessionCookie(authToken(T0 + 3600, "u1")) },
    });
    expect(response).toBeUndefined();
    expect(event.context["pb"]).toBeInstanceOf(ServerClient);
  });

  test("a GET from a foreign origin is never rejected", async () => {
    const auth = await adapter(iglo());
    const { response } = await run(auth, "/", {
      headers: { origin: "https://evil.example" },
      cookies: { pb_auth: sessionCookie(authToken(T0 + 3600, "u1")) },
    });
    expect(response).toBeUndefined();
  });
});

describe("middleware: adapter routes", () => {
  test("the renew route answers at its path with a minted token", async () => {
    const api = iglo({
      "POST /api/collections/users/impersonate/u1": () =>
        json(clock, 200, { token: authToken(T0 + 900, "u1"), record: record("u1") }),
    });
    const auth = await adapter(api);
    const { response, event } = await run(auth, "/api/pb/renew", {
      method: "POST",
      headers: { origin: APP },
      cookies: { pb_auth: sessionCookie(authToken(T0 + 3600, "u1")) },
    });
    if (!response) {
      throw new Error("the route did not answer");
    }
    expect(response.status).toBe(200);
    expect(((await response.json()) as { token: string }).token).toBe(authToken(T0 + 900, "u1"));
    expect(event.context["pb"]).toBeUndefined();
  });

  test("the renew route is not mounted at other paths", async () => {
    const auth = await adapter(iglo());
    const { response } = await run(auth, "/api/other/renew", {
      method: "POST",
      headers: { origin: APP },
    });
    expect(response).toBeUndefined();
  });

  test("routes: { renew: false } leaves the renew path to the app", async () => {
    const auth = await adapter(iglo(), routesWith({ renew: false }));
    const { response } = await run(auth, "/api/pb/renew", {
      method: "POST",
      headers: { origin: APP },
    });
    expect(response).toBeUndefined();
  });

  test("a configured renew path replaces the default one", async () => {
    const auth = await adapter(iglo(), routesWith({ renew: "/session/renew" }));
    const custom = await run(auth, "/session/renew", { method: "POST", headers: { origin: APP } });
    expect(custom.response?.status).toBe(401);

    const defaults = await run(auth, "/api/pb/renew", { method: "POST", headers: { origin: APP } });
    expect(defaults.response).toBeUndefined();
  });

  test("the popup route reads the JSON body and writes the session cookie on its response", async () => {
    const auth = await adapter(iglo({}, () => authToken(T0 + 3600, "u1")));
    const { response, setCookies } = await run(auth, "/api/pb/popup", {
      method: "POST",
      headers: { origin: APP, "content-type": "application/json" },
      body: { token: authToken(T0 + 600, "u1") },
    });
    if (!response) {
      throw new Error("the route did not answer");
    }
    expect(response.status).toBe(200);
    expect(((await response.json()) as { record: { id: string } }).record.id).toBe("u1");
    expect(response?.headers.getSetCookie().some((c) => c.startsWith("pb_auth="))).toBe(true);
    expect(setCookies).toHaveLength(0);
  });

  test("the popup route answers 400 when the body cannot be read", async () => {
    const auth = await adapter(iglo());
    const { response } = await run(auth, "/api/pb/popup", {
      method: "POST",
      headers: { origin: APP, "content-type": "application/json" },
      readBody: async () => {
        throw new SyntaxError("Unexpected token");
      },
    });
    expect(response?.status).toBe(400);
  });

  test("the popup route answers 400 without a body reader", async () => {
    const auth = await adapter(iglo());
    const { response } = await run(auth, "/api/pb/popup", {
      method: "POST",
      headers: { origin: APP },
    });
    expect(response?.status).toBe(400);
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
    const { response } = await run(auth, "/api/pb/oauth2/start/oidc?redirectTo=/home");
    expect(response?.status).toBe(302);
    const location = new URL(response?.headers.get("location") ?? "");
    expect(location.origin).toBe("https://idp.example");
    expect(location.searchParams.get("redirect_uri")).toBe(callback);
    expect(response?.headers.getSetCookie().some((c) => c.startsWith("pb_oauth2="))).toBe(true);
  });

  test("the OAuth2 callback without the temporary cookie redirects with the error", async () => {
    const auth = await adapter(iglo());
    const { response } = await run(auth, "/api/pb/oauth2/callback?code=x&state=y");
    expect(response?.status).toBe(302);
    // absolute, as Next.js needs it; the path and the error query are what matters
    const target = new URL(response?.headers.get("location") ?? "");
    expect(target.pathname).toBe("/");
    expect(target.search).toBe("?oauth2_error=missing-cookie");
  });

  test("the OAuth2 routes are not mounted when their paths are false", async () => {
    const auth = await adapter(iglo(), routesWith({ oauth2Start: false, oauth2Callback: false }));
    const start = await run(auth, "/api/pb/oauth2/start/oidc");
    const callback = await run(auth, "/api/pb/oauth2/callback?code=x&state=y");
    expect(start.response).toBeUndefined();
    expect(callback.response).toBeUndefined();
  });
});

describe("middleware: concurrent requests", () => {
  test("two users in parallel each see their own record", async () => {
    const api = iglo();
    const auth = await adapter(api);

    const results = await Promise.all(
      ["u1", "u2"].map(async (id) => {
        const { event } = makeEvent("/", {
          cookies: { pb_auth: sessionCookie(authToken(T0 + 3600, id), id) },
        });
        await auth.middleware(event);
        return event.context["pb"] as ServerClient;
      }),
    );

    expect(results.map((pb) => pb.authStore.record?.id)).toEqual(["u1", "u2"]);
    expect(results[0]).not.toBe(results[1]);
    expect(api.calls.map((c) => idOf(c.headers.get("authorization")))).toEqual(["u1", "u2"]);
  });
});
