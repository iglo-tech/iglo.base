// docs/design/13-ssr.md ("OAuth2"). Unit tests through the public SSR API, against a routing fetch
// that stands in for iglo.base. Cookies travel as the browser sends them: each Set-Cookie header is
// parsed into a jar, and the jar is sent back as a Cookie header on the next request.
import { describe, expect, test } from "bun:test";
import { dummyJWT } from "@sdk-test/mocks";
import { ClientResponseError } from "@sdk/ClientResponseError";
import {
  createRequestCookieAdapter,
  createServerClient,
  createSessionCache,
  handlePopupHandOff,
  OAuth2Error,
} from "@sdk/ssr/index";

const API = "http://127.0.0.1:8090";
const APP = "https://app.example.com";
const CALLBACK = `${APP}/callback`;
const STATE = "st_state_0123456789abcdefghij";
const VERIFIER = "verifier_0123456789abcdefghijklmnopqrstuvwxyz";
const AUTH_URL =
  "https://idp.example.com/authorize?client_id=123&code_challenge=CHAL_abc&code_challenge_method=S256&response_type=code&scope=openid&state=" +
  STATE +
  "&redirect_uri=";

const NOW_SEC = Math.floor(Date.now() / 1000);

interface Seen {
  method: string;
  path: string;
  headers: Headers;
  body: unknown;
}

type Route = (seen: Seen) => Response | Promise<Response>;

/** A fetch that answers by `METHOD /path` and records every call. */
function fakeIglo(routes: Record<string, Route>) {
  const calls: Seen[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const seen: Seen = {
      method,
      path: url.pathname,
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(seen);
    const route = routes[`${method} ${url.pathname}`];
    if (!route) {
      throw new Error(`no route for ${method} ${url.pathname}`);
    }
    return route(seen);
  };
  return { fetch, calls };
}

function json(status: number, body: unknown, date = new Date()): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", Date: date.toUTCString() },
  });
}

const authMethods = (overrides: { enabled?: boolean; providers?: unknown[] } = {}) => ({
  password: { enabled: false, identityFields: [] },
  otp: { enabled: false, duration: 0 },
  mfa: { enabled: false, duration: 0 },
  oauth2: {
    enabled: overrides.enabled ?? true,
    providers: overrides.providers ?? [
      {
        name: "oidc",
        displayName: "OIDC",
        state: STATE,
        authURL: AUTH_URL,
        codeVerifier: VERIFIER,
        codeChallenge: "CHAL_abc",
        codeChallengeMethod: "S256",
      },
    ],
  },
});

/** A token shaped like the server's: `exp`, no `iat`, `type: auth`. */
function serverToken(exp: number, id = "u1", collectionId = "users"): string {
  return dummyJWT({ exp, id, collectionId, type: "auth", refreshable: true });
}

/** A browser's cookie jar: stores Set-Cookie headers, sends them back in Cookie headers. */
class Browser {
  readonly jar = new Map<string, string>();

  store(response: Response): void {
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(";")[0] ?? "";
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      if (/Max-Age=0/i.test(line)) {
        this.jar.delete(name);
      } else {
        this.jar.set(name, value);
      }
    }
  }

  get cookieHeader(): string {
    return [...this.jar].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  request(url: string, init: RequestInit = {}): Request {
    const headers = new Headers(init.headers);
    if (this.jar.size > 0) {
      headers.set("cookie", this.cookieHeader);
    }
    return new Request(url, { ...init, headers });
  }
}

/** The start route: the redirect to the provider and the cookies it sets. */
async function startRoute(
  browser: Browser,
  iglo: ReturnType<typeof fakeIglo>,
  options: { provider?: string; redirectTo?: string; origin?: string; clock?: () => number } = {},
): Promise<{ location: string; response: Response }> {
  const origin = options.origin ?? APP;
  const request = browser.request(`${origin}/login`);
  const cookies = createRequestCookieAdapter(request);
  const pb = await createServerClient({
    url: API,
    cookies,
    request,
    fetch: iglo.fetch,
    clock: options.clock,
  });
  const location = await pb.startOAuth2(options.provider ?? "oidc", {
    callbackUrl: `${origin}/callback`,
    redirectTo: options.redirectTo,
  });
  const response = new Response(null, { status: 302, headers: { Location: location } });
  cookies.applyToResponse(response);
  browser.store(response);
  return { location, response };
}

/** The callback route: completeOAuth2 on the callback URL the browser came back to. */
async function callbackRoute(
  browser: Browser,
  iglo: ReturnType<typeof fakeIglo>,
  query: string,
  options: {
    clock?: () => number;
    sessionCache?: ReturnType<typeof createSessionCache>;
    origin?: string;
  } = {},
) {
  const request = browser.request(`${options.origin ?? APP}/callback?${query}`);
  const cookies = createRequestCookieAdapter(request);
  const pb = await createServerClient({
    url: API,
    cookies,
    request,
    fetch: iglo.fetch,
    clock: options.clock,
    sessionCache: options.sessionCache,
  });
  const result = await pb.completeOAuth2(request.url);
  const response = new Response(null, { status: 302, headers: { Location: result.redirectTo } });
  cookies.applyToResponse(response);
  browser.store(response);
  return { result, response };
}

const authOk = (id = "u1", exp = NOW_SEC + 3600) => ({
  "GET /api/collections/users/auth-methods": () => json(200, authMethods()),
  "POST /api/collections/users/auth-with-oauth2": () =>
    json(200, {
      token: serverToken(exp, id),
      record: { id, collectionId: "users", collectionName: "users", email: "a@example.com" },
      meta: {},
    }),
});

const popupRequest = (
  token: unknown,
  init: { origin?: string | null; method?: string; cookie?: string } = {},
) => {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (init.origin !== null) {
    headers["Origin"] = init.origin ?? APP;
  }
  if (init.cookie) {
    headers["Cookie"] = init.cookie;
  }
  return new Request(`${APP}/api/popup-sign-in`, {
    method: init.method ?? "POST",
    headers,
    body: JSON.stringify({ token }),
  });
};

describe("OAuth2 redirect flow: start", () => {
  test("sets the temporary cookie with the attributes of the flow", async () => {
    const browser = new Browser();
    const iglo = fakeIglo(authOk());
    const { response } = await startRoute(browser, iglo, { redirectTo: "/dashboard" });

    const setCookie = response.headers
      .getSetCookie()
      .find((c) => c.startsWith("__Host-pb_oauth2="));
    expect(setCookie).toBeDefined();
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("Max-Age=600");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Secure");
    expect(setCookie).not.toContain("Domain=");
  });

  test("returns the provider URL with the callback as redirect_uri and the server's state and PKCE", async () => {
    const browser = new Browser();
    const iglo = fakeIglo(authOk());
    const { location } = await startRoute(browser, iglo);

    const url = new URL(location);
    expect(url.origin + url.pathname).toBe("https://idp.example.com/authorize");
    expect(url.searchParams.get("state")).toBe(STATE);
    expect(url.searchParams.get("code_challenge")).toBe("CHAL_abc");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe(CALLBACK);
  });

  test("starts with no session request and no session cookie", async () => {
    const browser = new Browser();
    const iglo = fakeIglo(authOk());
    const { response } = await startRoute(browser, iglo);

    expect(iglo.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /api/collections/users/auth-methods",
    ]);
    expect(response.headers.getSetCookie().some((c) => c.includes("pb_auth"))).toBe(false);
  });

  test("uses the plain cookie name on http localhost", async () => {
    const browser = new Browser();
    const iglo = fakeIglo(authOk());
    const request = browser.request("http://localhost:3000/login");
    const cookies = createRequestCookieAdapter(request);
    const pb = await createServerClient({
      url: API,
      cookies,
      request,
      fetch: iglo.fetch,
    });
    await pb.startOAuth2("oidc", { callbackUrl: "http://localhost:3000/callback" });
    const names = cookies.queuedCookies.map((c) => c.name);
    expect(names).toEqual(["pb_oauth2"]);
    expect(cookies.queuedCookies[0]?.options?.secure).toBe(false);
  });

  test("an unknown provider throws a typed error and writes no cookie", async () => {
    const browser = new Browser();
    const iglo = fakeIglo(authOk());
    const request = browser.request(`${APP}/login`);
    const cookies = createRequestCookieAdapter(request);
    const pb = await createServerClient({ url: API, cookies, request, fetch: iglo.fetch });
    const error = await pb
      .startOAuth2("github", { callbackUrl: CALLBACK })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OAuth2Error);
    expect((error as OAuth2Error).kind).toBe("unknown-provider");
    expect(cookies.queuedCookies).toEqual([]);
  });

  test("a disabled OAuth2 collection is an unknown provider", async () => {
    const iglo = fakeIglo({
      "GET /api/collections/users/auth-methods": () => json(200, authMethods({ enabled: false })),
    });
    const pb = await createServerClient({
      url: API,
      cookies: createRequestCookieAdapter(new Request(`${APP}/login`)),
      fetch: iglo.fetch,
    });
    const error = await pb.startOAuth2("oidc", { callbackUrl: CALLBACK }).catch((e: unknown) => e);
    expect((error as OAuth2Error).kind).toBe("unknown-provider");
  });

  test("a server refusal of the auth methods is the server's ClientResponseError", async () => {
    const iglo = fakeIglo({
      "GET /api/collections/users/auth-methods": () =>
        json(404, { status: 404, message: "Missing collection.", data: {} }),
    });
    const pb = await createServerClient({
      url: API,
      cookies: createRequestCookieAdapter(new Request(`${APP}/login`)),
      fetch: iglo.fetch,
    });
    const error = await pb.startOAuth2("oidc", { callbackUrl: CALLBACK }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClientResponseError);
  });

  test("an invalid callback URL is rejected before any request", async () => {
    const iglo = fakeIglo(authOk());
    const pb = await createServerClient({
      url: API,
      cookies: createRequestCookieAdapter(new Request(`${APP}/login`)),
      fetch: iglo.fetch,
    });
    const error = await pb
      .startOAuth2("oidc", { callbackUrl: "/callback" })
      .catch((e: unknown) => e);
    expect((error as OAuth2Error).kind).toBe("invalid-callback");
    expect(iglo.calls).toEqual([]);
  });
});

describe("OAuth2 redirect flow: complete", () => {
  test("a valid state signs in, writes the session cookie and clears the temporary cookie", async () => {
    const browser = new Browser();
    const iglo = fakeIglo(authOk("u1"));
    await startRoute(browser, iglo, { redirectTo: "/dashboard" });
    expect(browser.jar.has("__Host-pb_oauth2")).toBe(true);

    const { result, response } = await callbackRoute(browser, iglo, `code=123&state=${STATE}`);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("unreachable");
    }
    expect(result.redirectTo).toBe("/dashboard");
    expect(result.auth.record.id).toBe("u1");
    expect(response.headers.getSetCookie().some((c) => c.startsWith("__Host-pb_auth="))).toBe(true);
    expect(browser.jar.has("__Host-pb_oauth2")).toBe(false);
    expect(browser.jar.has("__Host-pb_auth")).toBe(true);
  });

  test("the token exchange sends the stored verifier and redirect URL", async () => {
    const browser = new Browser();
    const iglo = fakeIglo(authOk());
    await startRoute(browser, iglo);
    await callbackRoute(browser, iglo, `code=123&state=${STATE}`);

    const exchange = iglo.calls.find((c) => c.path === "/api/collections/users/auth-with-oauth2");
    expect(exchange?.body).toEqual({
      provider: "oidc",
      code: "123",
      codeVerifier: VERIFIER,
      redirectURL: CALLBACK,
      createData: undefined,
    });
  });

  test("the next request resumes the user from the cookie", async () => {
    const browser = new Browser();
    const iglo = fakeIglo(authOk("u1"));
    const cache = createSessionCache();
    await startRoute(browser, iglo);
    await callbackRoute(browser, iglo, `code=123&state=${STATE}`, { sessionCache: cache });

    const next = browser.request(`${APP}/dashboard`);
    const pb = await createServerClient({
      url: API,
      cookies: createRequestCookieAdapter(next),
      request: next,
      fetch: iglo.fetch,
      sessionCache: cache,
    });
    expect(pb.authStore.record?.id).toBe("u1");
    expect(pb.authStore.isValid).toBe(true);
  });

  test("a replayed callback fails with missing-cookie and leaves no session", async () => {
    const browser = new Browser();
    const iglo = fakeIglo(authOk());
    await startRoute(browser, iglo);
    await callbackRoute(browser, iglo, `code=123&state=${STATE}`);

    const exchangesBefore = iglo.calls.filter((c) => c.path.endsWith("auth-with-oauth2")).length;
    const { result, response } = await callbackRoute(browser, iglo, `code=123&state=${STATE}`);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("unreachable");
    }
    expect((result.error as OAuth2Error).kind).toBe("missing-cookie");
    expect(iglo.calls.filter((c) => c.path.endsWith("auth-with-oauth2")).length).toBe(
      exchangesBefore,
    );
    expect(response.headers.getSetCookie().some((c) => c.includes("pb_auth="))).toBe(false);
  });

  test("a state mismatch clears the temporary cookie and signs nobody in", async () => {
    const browser = new Browser();
    const iglo = fakeIglo(authOk());
    await startRoute(browser, iglo);

    const { result } = await callbackRoute(browser, iglo, "code=123&state=forged");

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("unreachable");
    }
    expect((result.error as OAuth2Error).kind).toBe("state-mismatch");
    expect(browser.jar.has("__Host-pb_oauth2")).toBe(false);
    expect(browser.jar.has("__Host-pb_auth")).toBe(false);
    expect(iglo.calls.some((c) => c.path.endsWith("auth-with-oauth2"))).toBe(false);
  });

  test("a callback without state is a state mismatch", async () => {
    const browser = new Browser();
    const iglo = fakeIglo(authOk());
    await startRoute(browser, iglo);
    const { result } = await callbackRoute(browser, iglo, "code=123");
    expect((result as { error: OAuth2Error }).error.kind).toBe("state-mismatch");
    expect(browser.jar.has("__Host-pb_oauth2")).toBe(false);
  });

  test("a missing temporary cookie is typed and clears nothing else", async () => {
    const browser = new Browser();
    const iglo = fakeIglo(authOk());
    const { result, response } = await callbackRoute(browser, iglo, `code=123&state=${STATE}`);
    expect(result.ok).toBe(false);
    expect(result.redirectTo).toBe("/");
    expect((result.ok ? undefined : result.error) instanceof OAuth2Error).toBe(true);
    expect(response.headers.getSetCookie().some((c) => c.includes("pb_auth="))).toBe(false);
  });

  test("a tampered temporary cookie is a missing cookie and is cleared", async () => {
    const browser = new Browser();
    const iglo = fakeIglo(authOk());
    await startRoute(browser, iglo);
    browser.jar.set("__Host-pb_oauth2", "not-json");

    const { result } = await callbackRoute(browser, iglo, `code=123&state=${STATE}`);

    expect((result as { error: OAuth2Error }).error.kind).toBe("missing-cookie");
    expect(browser.jar.has("__Host-pb_oauth2")).toBe(false);
    expect(iglo.calls.some((c) => c.path.endsWith("auth-with-oauth2"))).toBe(false);
  });

  test("a temporary cookie with a wrong shape is a missing cookie", async () => {
    const browser = new Browser();
    const iglo = fakeIglo(authOk());
    await startRoute(browser, iglo);
    browser.jar.set(
      "__Host-pb_oauth2",
      encodeURIComponent(JSON.stringify({ state: STATE, collection: "users; drop", exp: 1 })),
    );
    const { result } = await callbackRoute(browser, iglo, `code=123&state=${STATE}`);
    expect((result as { error: OAuth2Error }).error.kind).toBe("missing-cookie");
  });

  test("an expired temporary cookie fails and is cleared", async () => {
    const browser = new Browser();
    const iglo = fakeIglo(authOk());
    const start = Date.now();
    await startRoute(browser, iglo, { clock: () => start });

    const { result } = await callbackRoute(browser, iglo, `code=123&state=${STATE}`, {
      clock: () => start + 601_000,
    });

    expect((result as { error: OAuth2Error }).error.kind).toBe("expired");
    expect(browser.jar.has("__Host-pb_oauth2")).toBe(false);
    expect(iglo.calls.some((c) => c.path.endsWith("auth-with-oauth2"))).toBe(false);
  });

  test("a provider error= callback fails with the provider's code and clears the cookie", async () => {
    const browser = new Browser();
    const iglo = fakeIglo(authOk());
    await startRoute(browser, iglo);

    const { result } = await callbackRoute(browser, iglo, `error=access_denied&state=${STATE}`);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("unreachable");
    }
    const error = result.error as OAuth2Error;
    expect(error.kind).toBe("provider-error");
    expect(error.providerError).toBe("access_denied");
    expect(browser.jar.has("__Host-pb_oauth2")).toBe(false);
    expect(iglo.calls.some((c) => c.path.endsWith("auth-with-oauth2"))).toBe(false);
  });

  test("a callback without code fails before the exchange", async () => {
    const browser = new Browser();
    const iglo = fakeIglo(authOk());
    await startRoute(browser, iglo);
    const { result } = await callbackRoute(browser, iglo, `state=${STATE}`);
    expect((result as { error: OAuth2Error }).error.kind).toBe("missing-code");
    expect(browser.jar.has("__Host-pb_oauth2")).toBe(false);
  });

  test("a server 400 on the exchange is the ClientResponseError, with no session and the cookie cleared", async () => {
    const browser = new Browser();
    const iglo = fakeIglo({
      "GET /api/collections/users/auth-methods": () => json(200, authMethods()),
      "POST /api/collections/users/auth-with-oauth2": () =>
        json(400, { status: 400, message: "Failed to fetch OAuth2 token.", data: {} }),
    });
    await startRoute(browser, iglo);

    const { result, response } = await callbackRoute(browser, iglo, `code=bad&state=${STATE}`);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("unreachable");
    }
    expect(result.error).toBeInstanceOf(ClientResponseError);
    expect((result.error as ClientResponseError).status).toBe(400);
    expect(browser.jar.has("__Host-pb_oauth2")).toBe(false);
    expect(browser.jar.has("__Host-pb_auth")).toBe(false);
    expect(response.headers.getSetCookie().some((c) => c.includes("pb_auth="))).toBe(false);
  });

  test("a network failure on the exchange is a ClientResponseError with status 0 and clears the cookie", async () => {
    const browser = new Browser();
    const iglo = fakeIglo({
      "GET /api/collections/users/auth-methods": () => json(200, authMethods()),
      "POST /api/collections/users/auth-with-oauth2": () => {
        throw new TypeError("fetch failed");
      },
    });
    await startRoute(browser, iglo);
    const { result } = await callbackRoute(browser, iglo, `code=1&state=${STATE}`);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("unreachable");
    }
    expect(result.error).toBeInstanceOf(ClientResponseError);
    expect((result.error as ClientResponseError).status).toBe(0);
    expect(browser.jar.has("__Host-pb_oauth2")).toBe(false);
    expect(browser.jar.has("__Host-pb_auth")).toBe(false);
  });

  test("open-redirect inputs fall back to /", async () => {
    for (const redirectTo of [
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      "javascript:alert(1)",
      "evil",
      "/%09/evil.example",
    ]) {
      const browser = new Browser();
      const iglo = fakeIglo(authOk());
      await startRoute(browser, iglo, { redirectTo });
      const { result } = await callbackRoute(browser, iglo, `code=123&state=${STATE}`);
      expect(result.redirectTo).toBe(
        redirectTo === "/%09/evil.example" ? "/%09/evil.example" : "/",
      );
    }
  });

  test("a tampered redirectTo in the cookie falls back to / on completion", async () => {
    const browser = new Browser();
    const iglo = fakeIglo(authOk());
    await startRoute(browser, iglo);
    const stored = JSON.parse(
      decodeURIComponent(browser.jar.get("__Host-pb_oauth2") ?? "{}"),
    ) as Record<string, unknown>;
    browser.jar.set(
      "__Host-pb_oauth2",
      encodeURIComponent(JSON.stringify({ ...stored, redirectTo: "//evil.example" })),
    );
    const { result } = await callbackRoute(browser, iglo, `code=123&state=${STATE}`);
    expect(result.ok).toBe(true);
    expect(result.redirectTo).toBe("/");
  });

  test("a failed sign-in still returns the stored same-origin redirectTo", async () => {
    const browser = new Browser();
    const iglo = fakeIglo(authOk());
    await startRoute(browser, iglo, { redirectTo: "/login" });
    const { result } = await callbackRoute(browser, iglo, `error=access_denied&state=${STATE}`);
    expect(result.redirectTo).toBe("/login");
  });

  test("the cookie survives one serialize and parse round trip", async () => {
    const browser = new Browser();
    const iglo = fakeIglo(authOk());
    await startRoute(browser, iglo, { redirectTo: "/a?b=c&d=%20" });
    const { result } = await callbackRoute(browser, iglo, `code=123&state=${STATE}`);
    expect(result.ok).toBe(true);
    expect(result.redirectTo).toBe("/a?b=c&d=%20");
  });

  test("a complete() with a stale state is rejected even when the code is valid", async () => {
    const browser = new Browser();
    const iglo = fakeIglo(authOk());
    await startRoute(browser, iglo);
    const { result } = await callbackRoute(browser, iglo, `code=123&state=${STATE}x`);
    expect((result as { error: OAuth2Error }).error.kind).toBe("state-mismatch");
  });
});

describe("popup hand-off", () => {
  test("a valid token is checked with one auth-refresh and sets the HttpOnly session cookie", async () => {
    const fresh = serverToken(NOW_SEC + 3600, "u9");
    const iglo = fakeIglo({
      "POST /api/collections/users/auth-refresh": () =>
        json(200, {
          token: fresh,
          record: { id: "u9", collectionId: "users", email: "b@example.com" },
        }),
    });
    const posted = serverToken(NOW_SEC + 3600, "u9");
    const response = await handlePopupHandOff(popupRequest(posted), {
      url: API,
      fetch: iglo.fetch,
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { record: { id: string }; token?: string };
    expect(body.record.id).toBe("u9");
    expect(body.token).toBeUndefined();
    expect(iglo.calls.map((c) => c.path)).toEqual(["/api/collections/users/auth-refresh"]);
    expect(iglo.calls[0]?.headers.get("authorization")).toBe(posted);

    const setCookie = response.headers.getSetCookie().find((c) => c.startsWith("__Host-pb_auth="));
    expect(setCookie).toBeDefined();
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");
    expect(decodeURIComponent(setCookie ?? "")).toContain(fresh);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  test("the record in the body is the server's, not the posted one", async () => {
    const token = serverToken(NOW_SEC + 3600, "u9");
    const iglo = fakeIglo({
      "POST /api/collections/users/auth-refresh": () =>
        json(200, {
          token,
          record: { id: "u9", collectionId: "users", email: "server@example.com" },
        }),
    });
    const request = new Request(`${APP}/api/popup-sign-in`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: APP },
      body: JSON.stringify({ token, record: { id: "u9", email: "forged@example.com" } }),
    });
    const response = await handlePopupHandOff(request, { url: API, fetch: iglo.fetch });
    const body = (await response.json()) as { record: { email: string } };
    expect(body.record.email).toBe("server@example.com");
  });

  test("a revoked token (401) sets no cookie", async () => {
    const iglo = fakeIglo({
      "POST /api/collections/users/auth-refresh": () =>
        json(401, { status: 401, message: "Invalid token.", data: {} }),
    });
    const response = await handlePopupHandOff(popupRequest(serverToken(NOW_SEC + 3600)), {
      url: API,
      fetch: iglo.fetch,
    });
    expect(response.status).toBe(401);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  test("a foreign origin is rejected with 403 before any request", async () => {
    const iglo = fakeIglo({});
    const response = await handlePopupHandOff(
      popupRequest(serverToken(NOW_SEC + 3600), { origin: "https://evil.example" }),
      { url: API, fetch: iglo.fetch },
    );
    expect(response.status).toBe(403);
    expect(iglo.calls).toEqual([]);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  test("a request without Origin is rejected", async () => {
    const iglo = fakeIglo({});
    const response = await handlePopupHandOff(
      popupRequest(serverToken(NOW_SEC + 3600), { origin: null }),
      { url: API, fetch: iglo.fetch },
    );
    expect(response.status).toBe(403);
  });

  test("GET is refused with 405", async () => {
    const iglo = fakeIglo({});
    const response = await handlePopupHandOff(
      new Request(`${APP}/api/popup-sign-in`, { method: "GET", headers: { Origin: APP } }),
      { url: API, fetch: iglo.fetch },
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  test("a body that is not an auth token is a 400 with no request", async () => {
    const iglo = fakeIglo({});
    const response = await handlePopupHandOff(popupRequest("not-a-token"), {
      url: API,
      fetch: iglo.fetch,
    });
    expect(response.status).toBe(400);
    expect(iglo.calls).toEqual([]);
  });

  test("a non-JSON body is a 400", async () => {
    const response = await handlePopupHandOff(
      new Request(`${APP}/api/popup-sign-in`, {
        method: "POST",
        headers: { Origin: APP },
        body: "token=abc",
      }),
      { url: API, fetch: fakeIglo({}).fetch },
    );
    expect(response.status).toBe(400);
  });

  test("allowedOrigins admits another origin", async () => {
    const token = serverToken(NOW_SEC + 3600, "u9");
    const iglo = fakeIglo({
      "POST /api/collections/users/auth-refresh": () =>
        json(200, { token, record: { id: "u9", collectionId: "users" } }),
    });
    const response = await handlePopupHandOff(
      popupRequest(token, { origin: "https://www.example.com" }),
      { url: API, fetch: iglo.fetch, allowedOrigins: ["https://www.example.com"] },
    );
    expect(response.status).toBe(200);
  });
});

describe("OAuth2 redirect flow: cookie names follow the origin", () => {
  test("on https a temporary cookie under the plain name is ignored (cookie tossing)", async () => {
    // A sibling subdomain sets the plain name with its own state and verifier. The victim's
    // callback must not use it: missing-cookie, no code exchange, and the plain cookie is cleared.
    const browser = new Browser();
    const iglo = fakeIglo(authOk("attacker"));
    const planted = {
      state: STATE,
      codeVerifier: "attacker_verifier_0123456789abcdefghijklmnop",
      provider: "oidc",
      collection: "users",
      redirectURL: CALLBACK,
      redirectTo: "/",
      exp: Date.now() + 600_000,
    };
    browser.jar.set("pb_oauth2", encodeURIComponent(JSON.stringify(planted)));

    const { result, response } = await callbackRoute(browser, iglo, `code=C&state=${STATE}`);

    expect(result.ok).toBe(false);
    expect((result as { error: OAuth2Error }).error.kind).toBe("missing-cookie");
    expect(iglo.calls.some((c) => c.path.endsWith("auth-with-oauth2"))).toBe(false);
    expect(browser.jar.has("pb_oauth2")).toBe(false);
    expect(response.headers.getSetCookie().some((c) => c.startsWith("pb_auth="))).toBe(false);
  });

  test("on http the plain name is the one written and read: the flow signs in", async () => {
    const LOCAL = "http://localhost:3000";
    const browser = new Browser();
    const iglo = fakeIglo(authOk("u1"));
    await startRoute(browser, iglo, { origin: LOCAL });
    expect(browser.jar.has("pb_oauth2")).toBe(true);

    const { result, response } = await callbackRoute(browser, iglo, `code=123&state=${STATE}`, {
      origin: LOCAL,
    });

    expect(result.ok).toBe(true);
    expect(response.headers.getSetCookie().some((c) => c.startsWith("pb_auth="))).toBe(true);
    expect(browser.jar.has("pb_oauth2")).toBe(false);
    expect(browser.jar.has("pb_auth")).toBe(true);
  });

  test("Sign in with Apple (response_mode=form_post) is refused before any cookie is written", async () => {
    const APPLE_AUTH_URL =
      "https://appleid.apple.com/auth/authorize?client_id=com.example.app&response_mode=form_post" +
      "&response_type=code&scope=name%20email&state=" +
      STATE +
      "&redirect_uri=";
    const iglo = fakeIglo({
      "GET /api/collections/users/auth-methods": () =>
        json(
          200,
          authMethods({
            providers: [
              { name: "apple", displayName: "Apple", state: STATE, authURL: APPLE_AUTH_URL },
            ],
          }),
        ),
    });
    const request = new Request(`${APP}/login`);
    const cookies = createRequestCookieAdapter(request);
    const pb = await createServerClient({ url: API, cookies, request, fetch: iglo.fetch });

    const error = await pb.startOAuth2("apple", { callbackUrl: CALLBACK }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OAuth2Error);
    expect((error as OAuth2Error).kind).toBe("unsupported-provider");
    expect(cookies.queuedCookies).toEqual([]);
    expect(iglo.calls.map((c) => c.path)).toEqual(["/api/collections/users/auth-methods"]);
  });
});
