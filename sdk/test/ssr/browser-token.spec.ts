// docs/design/13-ssr.md ("Browser client and realtime", "Fallback without superuser credentials").
// Minting at render, and the renew route, through the public SSR API with a stub iglo.base.
import { describe, expect, test } from "bun:test";
import {
  createServerClient,
  createSessionCache,
  createSuperuserClient,
  handleBrowserTokenRenew,
  mintBrowserToken,
  type CookieAdapter,
} from "@sdk/ssr/index";
import {
  API,
  APP,
  authToken,
  json,
  record,
  stubApi,
  superuserToken,
  testClock,
} from "@sdk-test/ssr/browser-support";

const T0 = Math.floor(Date.now() / 1000);

function cookieHeader(token: string, rec = record()): string {
  return `pb_auth=${encodeURIComponent(JSON.stringify({ token, record: rec }))}`;
}

/** A request from the app's page, the way a browser sends it. */
function renewRequest(cookie?: string): Request {
  const headers = new Headers({ origin: APP });
  if (cookie) {
    headers.set("cookie", cookie);
  }
  return new Request(`${APP}/api/session/renew`, { method: "POST", headers });
}

function setCookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

describe("mintBrowserToken", () => {
  test("mints a 15-minute token with impersonate and returns the server's record", async () => {
    const clock = testClock(T0 * 1000);
    const session = authToken(T0 + 3600, "u1");
    const minted = authToken(T0 + 900, "u1");
    const { fetch, calls } = stubApi(clock, {
      [`POST /api/collections/users/impersonate/u1`]: (call) => {
        expect(call.headers.get("authorization")).toBe(superuserToken(T0 + 99999));
        expect(call.body).toEqual({ duration: 900 });
        return json(clock, 200, { token: minted, record: record("forged") });
      },
    });
    const server = await createServerClient({
      url: API,
      cookies: {
        getAll: () => [
          { name: "pb_auth", value: JSON.stringify({ token: session, record: record() }) },
        ],
      },
      clock,
      fetch,
      origin: APP,
      sessionCache: createSessionCache({ clock }),
    });
    const su = await createSuperuserClient({
      url: API,
      token: superuserToken(T0 + 99999),
      fetch,
      clock,
    });

    const result = await mintBrowserToken(server, su);

    expect(result).toEqual({
      token: minted,
      record: record(),
      expiresAt: (T0 + 900) * 1000,
      serverTime: T0 * 1000,
    });
    expect(calls.map((c) => c.method + " " + c.path)).toContain(
      "POST /api/collections/users/impersonate/u1",
    );
  });

  test("the duration is configurable", async () => {
    const clock = testClock(T0 * 1000);
    const session = authToken(T0 + 3600);
    const { fetch, calls } = stubApi(clock, {
      "POST /api/collections/users/impersonate/u1": (call) => {
        expect(call.body).toEqual({ duration: 120 });
        return json(clock, 200, { token: authToken(T0 + 120), record: record() });
      },
    });
    const server = await createServerClient({
      url: API,
      cookies: {
        getAll: () => [
          { name: "pb_auth", value: JSON.stringify({ token: session, record: record() }) },
        ],
      },
      clock,
      fetch,
      origin: APP,
    });
    const su = await createSuperuserClient({ url: API, token: superuserToken(T0 + 99999), fetch });
    await mintBrowserToken(server, su, { duration: 120 });
    expect(calls.filter((c) => c.path.includes("/impersonate/"))).toHaveLength(1);
  });

  test("returns null when nobody is signed in, without a request", async () => {
    const clock = testClock(T0 * 1000);
    const { fetch, calls } = stubApi(clock, {});
    const server = await createServerClient({
      url: API,
      cookies: { getAll: () => [] },
      clock,
      fetch,
      origin: APP,
    });
    const su = await createSuperuserClient({ url: API, token: superuserToken(T0 + 99999), fetch });
    expect(await mintBrowserToken(server, su)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("without superuser credentials, a server client that is not in fallback mode is refused", async () => {
    const clock = testClock(T0 * 1000);
    const session = authToken(T0 + 3600);
    const { fetch } = stubApi(clock, {
      "POST /api/collections/users/auth-refresh": () =>
        json(clock, 200, { token: session, record: record() }),
    });
    const server = await createServerClient({
      url: API,
      cookies: {
        getAll: () => [
          { name: "pb_auth", value: JSON.stringify({ token: session, record: record() }) },
        ],
      },
      clock,
      fetch,
      origin: APP,
    });
    await expect(mintBrowserToken(server, undefined)).rejects.toThrow(TypeError);
  });

  test("in fallback mode without superuser credentials, the session token itself is returned", async () => {
    const clock = testClock(T0 * 1000);
    const session = authToken(T0 + 3600);
    const { fetch, calls } = stubApi(clock, {
      "POST /api/collections/users/auth-refresh": () =>
        json(clock, 200, { token: session, record: record() }),
    });
    const server = await createServerClient({
      url: API,
      cookies: {
        getAll: () => [
          { name: "pb_auth", value: JSON.stringify({ token: session, record: record() }) },
        ],
      },
      clock,
      fetch,
      origin: APP,
      readableCookie: true,
    });
    const minted = await mintBrowserToken(server, undefined);
    expect(minted).toEqual({
      token: session,
      record: record(),
      expiresAt: (T0 + 3600) * 1000,
      serverTime: T0 * 1000,
    });
    expect(calls.every((c) => c.path !== "/api/collections/users/impersonate/u1")).toBe(true);
  });
});

describe("handleBrowserTokenRenew", () => {
  test("POST with a valid session answers a freshly minted token, with no-cache headers", async () => {
    const clock = testClock(T0 * 1000);
    const session = authToken(T0 + 3600);
    const minted = authToken(T0 + 900);
    const { fetch } = stubApi(clock, {
      "POST /api/collections/users/auth-refresh": () =>
        json(clock, 200, { token: session, record: record() }),
      "POST /api/collections/users/impersonate/u1": () =>
        json(clock, 200, { token: minted, record: record() }),
    });
    const su = await createSuperuserClient({ url: API, token: superuserToken(T0 + 99999), fetch });

    const res = await handleBrowserTokenRenew(renewRequest(cookieHeader(session)), {
      url: API,
      clock,
      fetch,
      superuser: su,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(
      "private, no-cache, no-store, must-revalidate, max-age=0",
    );
    expect(res.headers.get("pragma")).toBe("no-cache");
    expect(await res.json()).toEqual({
      token: minted,
      record: record(),
      expiresAt: (T0 + 900) * 1000,
      serverTime: T0 * 1000,
    });
  });

  test("a GET is refused with 405 and Allow: POST", async () => {
    const clock = testClock(T0 * 1000);
    const { fetch, calls } = stubApi(clock, {});
    const res = await handleBrowserTokenRenew(
      new Request(`${APP}/api/session/renew`, { method: "GET", headers: { origin: APP } }),
      { url: API, clock, fetch },
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(calls).toHaveLength(0);
  });

  test("a foreign origin is refused with 403 before the session is read", async () => {
    const clock = testClock(T0 * 1000);
    const { fetch, calls } = stubApi(clock, {});
    const res = await handleBrowserTokenRenew(
      new Request(`${APP}/api/session/renew`, {
        method: "POST",
        headers: { origin: "https://evil.example", cookie: cookieHeader(authToken(T0 + 60)) },
      }),
      { url: API, clock, fetch },
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(calls).toHaveLength(0);
  });

  test("a request without an Origin is refused with 403", async () => {
    const clock = testClock(T0 * 1000);
    const { fetch } = stubApi(clock, {});
    const res = await handleBrowserTokenRenew(
      new Request(`${APP}/api/session/renew`, {
        method: "POST",
        headers: { cookie: cookieHeader(authToken(T0 + 60)) },
      }),
      { url: API, clock, fetch },
    );
    expect(res.status).toBe(403);
  });

  test("no cookie is 401 without a request, with no-cache headers", async () => {
    const clock = testClock(T0 * 1000);
    const { fetch, calls } = stubApi(clock, {});
    const superuser = await createSuperuserClient({
      url: API,
      token: superuserToken(T0 + 99999),
      fetch,
      clock,
    });
    const res = await handleBrowserTokenRenew(renewRequest(), {
      url: API,
      clock,
      fetch,
      superuser,
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(calls).toHaveLength(0);
  });

  test("a revoked session is 401, and the cookies are cleared", async () => {
    const clock = testClock(T0 * 1000);
    const session = authToken(T0 + 3600);
    const { fetch } = stubApi(clock, {
      "POST /api/collections/users/auth-refresh": () =>
        json(clock, 401, { status: 401, message: "revoked", data: {} }),
    });
    const su = await createSuperuserClient({ url: API, token: superuserToken(T0 + 99999), fetch });
    const res = await handleBrowserTokenRenew(renewRequest(cookieHeader(session)), {
      url: API,
      clock,
      fetch,
      superuser: su,
    });
    expect(res.status).toBe(401);
    const cleared = setCookies(res).filter((c) => /Max-Age=0/i.test(c));
    expect(cleared.length).toBeGreaterThan(0);
  });

  test("a session revoked after a successful renewal is 401: the cache does not hide it", async () => {
    const clock = testClock(T0 * 1000);
    const cache = createSessionCache({ clock });
    const session = authToken(T0 + 3600);
    let revoked = false;
    const { fetch } = stubApi(clock, {
      "POST /api/collections/users/auth-refresh": () =>
        revoked
          ? json(clock, 401, { status: 401, message: "revoked", data: {} })
          : json(clock, 200, { token: session, record: record() }),
      "POST /api/collections/users/impersonate/u1": () =>
        json(clock, 200, { token: authToken(T0 + 900), record: record() }),
    });
    const su = await createSuperuserClient({ url: API, token: superuserToken(T0 + 99999), fetch });
    const options = { url: API, clock, fetch, superuser: su, sessionCache: cache };

    const first = await handleBrowserTokenRenew(renewRequest(cookieHeader(session)), options);
    expect(first.status).toBe(200);

    revoked = true;
    const second = await handleBrowserTokenRenew(renewRequest(cookieHeader(session)), options);
    expect(second.status).toBe(401);
  });

  test("iglo.base unreachable is 503, and the session is kept", async () => {
    const clock = testClock(T0 * 1000);
    const session = authToken(T0 + 3600);
    const { fetch } = stubApi(clock, {
      "POST /api/collections/users/auth-refresh": () =>
        json(clock, 503, { status: 503, message: "busy", data: {} }),
    });
    const res = await handleBrowserTokenRenew(renewRequest(cookieHeader(session)), {
      url: API,
      clock,
      fetch,
      superuser: await createSuperuserClient({
        url: API,
        token: superuserToken(T0 + 99999),
        fetch,
      }),
    });
    expect(res.status).toBe(503);
    expect(setCookies(res).filter((c) => /Max-Age=0/i.test(c))).toHaveLength(0);
  });

  test("fallback mode answers the session token, and the cookie is readable by page JavaScript", async () => {
    const clock = testClock(T0 * 1000);
    const session = authToken(T0 + 3600);
    const refreshed = authToken(T0 + 7200);
    const { fetch } = stubApi(clock, {
      "POST /api/collections/users/auth-refresh": () =>
        json(clock, 200, { token: refreshed, record: record() }),
    });
    const res = await handleBrowserTokenRenew(renewRequest(cookieHeader(session)), {
      url: API,
      clock,
      fetch,
      readableCookie: true,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      token: refreshed,
      record: record(),
      expiresAt: (T0 + 7200) * 1000,
      serverTime: T0 * 1000,
    });
    const written = setCookies(res).find((c) => c.startsWith("pb_auth="));
    expect(written).toBeDefined();
    expect(written).not.toMatch(/HttpOnly/i);
    expect(written).toMatch(/SameSite=Lax/i);
    expect(written).toMatch(/Path=\//);
  });
});

describe("fallback cookie attributes", () => {
  test("a secure origin writes __Host-pb_auth without HttpOnly, and never a plain name", async () => {
    const clock = testClock(T0 * 1000);
    const session = authToken(T0 + 3600);
    const written: string[] = [];
    const adapter: CookieAdapter = {
      getAll: () => [
        { name: "__Host-pb_auth", value: JSON.stringify({ token: session, record: record() }) },
      ],
      setAll: (list) => {
        for (const c of list) {
          written.push(c.name);
        }
      },
      isSecure: true,
    };
    const { fetch } = stubApi(clock, {
      "POST /api/collections/users/auth-refresh": () =>
        json(clock, 200, { token: authToken(T0 + 7200), record: record() }),
    });
    const server = await createServerClient({
      url: API,
      cookies: adapter,
      clock,
      fetch,
      readableCookie: true,
    });
    expect(server.readableCookie).toBe(true);
    await server.auth.verify();
    expect(written.length).toBeGreaterThan(0);
    expect(written.every((n) => n === "__Host-pb_auth")).toBe(true);
  });
});

describe("handleBrowserTokenRenew: configuration and mint failures", () => {
  test("a missing configuration throws before the session is read or refreshed", async () => {
    const clock = testClock(T0 * 1000);
    const session = authToken(T0 + 3600);
    const { fetch, calls } = stubApi(clock, {});
    await expect(
      handleBrowserTokenRenew(renewRequest(cookieHeader(session)), { url: API, clock, fetch }),
    ).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });

  test("impersonate answering 404 (user deleted after the check) is 401, and the cookies are cleared", async () => {
    const clock = testClock(T0 * 1000);
    const session = authToken(T0 + 3600);
    const { fetch, calls } = stubApi(clock, {
      "POST /api/collections/users/auth-refresh": () =>
        json(clock, 200, { token: session, record: record() }),
      "POST /api/collections/users/impersonate/u1": () =>
        json(clock, 404, { status: 404, message: "gone", data: {} }),
    });
    const su = await createSuperuserClient({
      url: API,
      token: superuserToken(T0 + 99999),
      fetch,
      clock,
    });
    const res = await handleBrowserTokenRenew(renewRequest(cookieHeader(session)), {
      url: API,
      clock,
      fetch,
      superuser: su,
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(setCookies(res).filter((c) => /Max-Age=0/i.test(c)).length).toBeGreaterThan(0);
    expect(calls.some((c) => c.path.endsWith("/impersonate/u1"))).toBe(true);
  });

  test("impersonate answering 401 (the superuser token is missing, expired or revoked) is 503, and the session cookie is kept", async () => {
    const clock = testClock(T0 * 1000);
    const session = authToken(T0 + 3600);
    const refused = await renewWhenImpersonateAnswers(401, session);
    expect(refused.res.status).toBe(503);
    expect(refused.res.headers.get("cache-control")).toContain("no-store");
    expect(setCookies(refused.res).filter((c) => /Max-Age=0/i.test(c))).toHaveLength(0);

    // the user's session is untouched: once the superuser credentials work again, the same
    // cookie renews
    const { fetch } = stubApi(clock, {
      "POST /api/collections/users/auth-refresh": () =>
        json(clock, 200, { token: session, record: record() }),
      "POST /api/collections/users/impersonate/u1": () =>
        json(clock, 200, { token: authToken(T0 + 900), record: record() }),
    });
    const su = await createSuperuserClient({
      url: API,
      token: superuserToken(T0 + 99999),
      fetch,
      clock,
    });
    const again = await handleBrowserTokenRenew(renewRequest(cookieHeader(session)), {
      url: API,
      clock,
      fetch,
      superuser: su,
    });
    expect(again.status).toBe(200);
  });

  test("impersonate answering 403 (the token is not a superuser's) is 503, and the session cookie is kept", async () => {
    const { res } = await renewWhenImpersonateAnswers(403);
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(setCookies(res).filter((c) => /Max-Age=0/i.test(c))).toHaveLength(0);
  });

  test("impersonate answering 500 is 503, and the session cookie is kept", async () => {
    const { res } = await renewWhenImpersonateAnswers(500);
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(setCookies(res).filter((c) => /Max-Age=0/i.test(c))).toHaveLength(0);
  });

  test("a 503 for refused superuser credentials still writes the session cookie the check refreshed", async () => {
    const clock = testClock(T0 * 1000);
    const session = authToken(T0 + 3600);
    const refreshed = authToken(T0 + 7200);
    const { fetch } = stubApi(clock, {
      "POST /api/collections/users/auth-refresh": () =>
        json(clock, 200, { token: refreshed, record: record() }),
      "POST /api/collections/users/impersonate/u1": () =>
        json(clock, 401, { status: 401, message: "no", data: {} }),
    });
    const su = await createSuperuserClient({
      url: API,
      token: superuserToken(T0 + 99999),
      fetch,
      clock,
    });
    const res = await handleBrowserTokenRenew(renewRequest(cookieHeader(session)), {
      url: API,
      clock,
      fetch,
      superuser: su,
    });
    expect(res.status).toBe(503);
    expect(setCookies(res).some((c) => c.startsWith("pb_auth=") && !/Max-Age=0/i.test(c))).toBe(
      true,
    );
  });
});

/**
 * A renew request whose superuser client reaches impersonate, which answers `status`. The
 * session cookie carries `session`, and the session check (auth-refresh) succeeds.
 */
async function renewWhenImpersonateAnswers(status: number, session = authToken(T0 + 3600)) {
  const clock = testClock(T0 * 1000);
  const { fetch, calls } = stubApi(clock, {
    "POST /api/collections/users/auth-refresh": () =>
      json(clock, 200, { token: session, record: record() }),
    "POST /api/collections/users/impersonate/u1": () =>
      json(clock, status, { status, message: "answered", data: {} }),
  });
  const su = await createSuperuserClient({
    url: API,
    token: superuserToken(T0 + 99999),
    fetch,
    clock,
  });
  const res = await handleBrowserTokenRenew(renewRequest(cookieHeader(session)), {
    url: API,
    clock,
    fetch,
    superuser: su,
  });
  return { res, calls };
}
