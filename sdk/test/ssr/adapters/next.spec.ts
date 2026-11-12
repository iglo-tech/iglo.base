// docs/design/13-ssr.md ("Framework adapters": @iglo.tech/iglo.base/ssr/next; "Session cookie"; "CSRF"; "OAuth2").
// The Next.js adapter through its public API: the middleware's pass-through response and the request
// it forwards, and what serverSession reads from that request. iglo.base is a fake fetch that
// answers the requests the adapter sends and fails any other, so no test touches the network.
import { describe, expect, test } from "bun:test";
import { dummyJWT } from "@sdk-test/mocks";
import { immutableResponse } from "@sdk-test/ssr/immutable-response";
import { createSessionCache, SSR_NO_CACHE_HEADERS } from "@sdk/ssr/index";
import { createNextAuth, type NextAuthOptions, type NextCookieStore } from "@sdk/ssr/next";
import { getTokenPayload } from "@sdk/tools/jwt";

const API = "http://127.0.0.1:8090";
const APP = "https://app.example.com";
const NOW_SEC = Math.floor(Date.now() / 1000);
const NOW_UTC = new Date(NOW_SEC * 1000).toUTCString();

type Fetch = (url: RequestInfo | URL, config?: RequestInit) => Promise<Response>;

/** A token shaped like iglo.base's: `exp`, no `iat`, `type: auth`. `ver` tells a refreshed token apart. */
function token(id: string, ver: number): string {
  return dummyJWT({
    exp: NOW_SEC + 600,
    id,
    collectionId: "users",
    type: "auth",
    refreshable: true,
    ver,
  });
}

function tokenVersion(tok: string): unknown {
  return getTokenPayload(tok)["ver"];
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", Date: NOW_UTC },
  });
}

const STATE = "st_state_0123456789abcdefghij";
const AUTH_URL = `https://idp.example.com/authorize?client_id=123&response_type=code&scope=openid&state=${STATE}`;

/**
 * A fake iglo.base. A refresh answers a new token (version 2) for the same user, unless the user is
 * `revoked`, which gets a 401. The auth methods list one OAuth2 provider.
 */
function fakeIglo(): Fetch {
  return async (url, config) => {
    const { pathname } = new URL(String(url));
    const method = (config?.method ?? "GET").toUpperCase();
    if (method === "POST" && pathname === "/api/collections/users/auth-refresh") {
      const old = getTokenPayload(new Headers(config?.headers).get("authorization") ?? "");
      const id = String(old["id"]);
      if (id === "revoked") {
        return json(401, {
          status: 401,
          message: "The request requires valid record authorization token.",
          data: {},
        });
      }
      return json(200, {
        token: token(id, 2),
        record: { id, collectionId: "users", collectionName: "users", email: `${id}@example.com` },
      });
    }
    if (method === "GET" && pathname === "/api/collections/users/auth-methods") {
      return json(200, {
        password: { enabled: false, identityFields: [] },
        otp: { enabled: false, duration: 0 },
        mfa: { enabled: false, duration: 0 },
        oauth2: {
          enabled: true,
          providers: [
            {
              name: "oidc",
              displayName: "OIDC",
              state: STATE,
              authURL: AUTH_URL,
              codeVerifier: "verifier_0123456789abcdefghijklmnopqrstuvwxyz",
              codeChallenge: "CHAL",
              codeChallengeMethod: "S256",
            },
          ],
        },
      });
    }
    throw new Error(`not answered by the fake iglo.base: ${method} ${pathname}`);
  };
}

/**
 * An adapter for the tests. It runs in fallback mode (`readableCookie`), so no superuser fake is
 * needed; the cookie's flags are the core's concern. `forwarded` collects the request headers the
 * middleware passes on.
 */
function setup(overrides: Partial<NextAuthOptions> = {}) {
  const forwarded: Headers[] = [];
  const auth = createNextAuth({
    url: API,
    origin: APP,
    readableCookie: true,
    sessionCache: createSessionCache(),
    fetch: fakeIglo(),
    next: (init) => {
      forwarded.push(init.request.headers);
      return new Response("next", { status: 200 });
    },
    ...overrides,
  });
  return { auth, forwarded };
}

function record(id: string) {
  return { id, collectionId: "users", collectionName: "users", email: `${id}@example.com` };
}

/** The Cookie header a browser sends for a session: the session JSON, percent-encoded. */
function sessionCookie(name: string, tok: string, id: string): string {
  return `${name}=${encodeURIComponent(JSON.stringify({ token: tok, record: record(id) }))}`;
}

function request(
  path: string,
  init: {
    method?: string;
    cookie?: string;
    origin?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Request {
  const headers = new Headers(init.headers);
  if (init.cookie !== undefined) {
    headers.set("cookie", init.cookie);
  }
  if (init.origin !== undefined) {
    headers.set("origin", init.origin);
  }
  return new Request(`${APP}${path}`, { method: init.method ?? "GET", headers, body: init.body });
}

/** The Set-Cookie line of one cookie, or undefined. */
function cookieLine(response: Response, name: string): string | undefined {
  return response.headers.getSetCookie().find((line) => line.startsWith(`${name}=`));
}

/** The session token in a Set-Cookie line, read as the browser stores it. */
function sessionTokenOf(line: string | undefined): string {
  const raw = (line ?? "").slice((line ?? "").indexOf("=") + 1).split(";")[0] ?? "";
  return (JSON.parse(decodeURIComponent(raw)) as { token: string }).token;
}

/** A cookie store as next/headers gives it: raw values as sent, and no `set` (read-only). */
function readOnlyStore(cookieHeader: string): NextCookieStore {
  const cookies = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map((part) => {
      const eq = part.indexOf("=");
      return { name: part.slice(0, eq), value: part.slice(eq + 1) };
    });
  return { getAll: () => cookies };
}

/** The user a forwarded Cookie header carries, read as the request adapter reads it. */
function forwardedUser(headers: Headers): { tokenId: unknown; recordId: unknown } {
  const pair = (headers.get("cookie") ?? "").split(";").map((part) => part.trim())[0] ?? "";
  const raw = pair.slice(pair.indexOf("=") + 1);
  const session = JSON.parse(decodeURIComponent(raw)) as { token: string; record: { id: string } };
  return { tokenId: getTokenPayload(session.token)["id"], recordId: session.record.id };
}

describe("createNextAuth: middleware", () => {
  test("resumes the session and writes the refreshed cookie onto the pass-through response", async () => {
    const { auth } = setup();

    const response = await auth.middleware(
      request("/dashboard", { cookie: sessionCookie("__Host-pb_auth", token("u1", 1), "u1") }),
    );

    expect(await response.text()).toBe("next");
    expect(tokenVersion(sessionTokenOf(cookieLine(response, "__Host-pb_auth")))).toBe(2);
  });

  test("a revoked session clears its cookie on the pass-through response", async () => {
    const { auth } = setup();

    const response = await auth.middleware(
      request("/dashboard", {
        cookie: sessionCookie("__Host-pb_auth", token("revoked", 1), "revoked"),
      }),
    );

    const line = cookieLine(response, "__Host-pb_auth");
    expect(line).toContain("Max-Age=0");
    expect(line?.startsWith("__Host-pb_auth=;")).toBe(true);
  });

  test("a response that writes a cookie carries the no-cache headers", async () => {
    const { auth } = setup();

    const response = await auth.middleware(
      request("/dashboard", { cookie: sessionCookie("__Host-pb_auth", token("u1", 1), "u1") }),
    );

    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(response.headers.get("expires")).toBe("0");
  });

  test("a request without a session writes no cookie and no no-cache headers", async () => {
    const { auth } = setup();

    const response = await auth.middleware(request("/public"));

    expect(response.headers.getSetCookie()).toEqual([]);
    expect(response.headers.get("cache-control")).toBeNull();
  });

  test("the forwarded request carries the refreshed session, so Server Components read it", async () => {
    const { auth, forwarded } = setup();
    await auth.middleware(
      request("/dashboard", { cookie: sessionCookie("__Host-pb_auth", token("u1", 1), "u1") }),
    );
    const headers = forwarded[0];
    if (!headers) {
      throw new Error("the middleware did not pass the request on");
    }

    const session = await auth.serverSession({
      cookies: readOnlyStore(headers.get("cookie") ?? ""),
      headers,
    });

    expect(tokenVersion(session.server.authStore.token)).toBe(2);
  });

  test("a client-supplied x-iglo-base-* header is dropped and the flag is the middleware's", async () => {
    const { auth, forwarded } = setup();

    await auth.middleware(
      request("/dashboard", {
        headers: { "x-iglo-base-secure": "0", "x-iglo-base-other": "x" },
      }),
    );
    const headers = forwarded[0];
    if (!headers) {
      throw new Error("the middleware did not pass the request on");
    }

    expect(headers.get("x-iglo-base-secure")).toBe("1");
    expect(headers.get("x-iglo-base-other")).toBeNull();
  });

  test("a POST from a foreign origin with the session cookie is answered 403", async () => {
    const { auth, forwarded } = setup();

    const response = await auth.middleware(
      request("/account", {
        method: "POST",
        origin: "https://evil.example",
        cookie: sessionCookie("__Host-pb_auth", token("u1", 1), "u1"),
      }),
    );

    expect(response.status).toBe(403);
    expect(forwarded).toHaveLength(0);
  });

  test("the same POST with csrf: false goes through", async () => {
    const { auth } = setup({ csrf: false });

    const response = await auth.middleware(
      request("/account", {
        method: "POST",
        origin: "https://evil.example",
        cookie: sessionCookie("__Host-pb_auth", token("u1", 1), "u1"),
      }),
    );

    expect(await response.text()).toBe("next");
  });

  test("a GET from a foreign origin is never rejected", async () => {
    const { auth } = setup();

    const response = await auth.middleware(
      request("/account", {
        origin: "https://evil.example",
        cookie: sessionCookie("__Host-pb_auth", token("u1", 1), "u1"),
      }),
    );

    expect(await response.text()).toBe("next");
  });

  test("the renew route answers at its configured path only", async () => {
    const { auth } = setup({ routes: { renew: "/auth/renew" } });
    const cookie = sessionCookie("__Host-pb_auth", token("u1", 1), "u1");

    const answered = await auth.middleware(
      request("/auth/renew", { method: "POST", origin: APP, cookie }),
    );
    const passed = await auth.middleware(
      request("/api/pb/renew", { method: "POST", origin: APP, cookie }),
    );

    expect(answered.status).toBe(200);
    expect(((await answered.json()) as { token: string }).token).toBe(token("u1", 2));
    expect(await passed.text()).toBe("next");
  });

  test("renew: false leaves the default renew path to the app", async () => {
    const { auth } = setup({ routes: { renew: false } });

    const response = await auth.middleware(
      request("/api/pb/renew", {
        method: "POST",
        origin: APP,
        cookie: sessionCookie("__Host-pb_auth", token("u1", 1), "u1"),
      }),
    );

    expect(await response.text()).toBe("next");
  });

  test("the popup route answers at its configured path only", async () => {
    const { auth } = setup({ routes: { popup: "/auth/popup" } });
    const body = JSON.stringify({ token: token("u1", 1) });

    const answered = await auth.middleware(
      request("/auth/popup", {
        method: "POST",
        origin: APP,
        body,
        headers: { "content-type": "application/json" },
      }),
    );
    const passed = await auth.middleware(
      request("/api/pb/popup", {
        method: "POST",
        origin: APP,
        body,
        headers: { "content-type": "application/json" },
      }),
    );

    expect(answered.status).toBe(200);
    expect(((await answered.json()) as { record: { id: string } }).record.id).toBe("u1");
    expect(await passed.text()).toBe("next");
  });

  test("the OAuth2 start route redirects at its configured path only", async () => {
    const { auth } = setup({ routes: { oauth2Start: "/login" } });

    const answered = await auth.middleware(request("/login/oidc"));
    const passed = await auth.middleware(request("/api/pb/oauth2/start/oidc"));

    expect(answered.status).toBe(302);
    expect(answered.headers.get("location")?.startsWith("https://idp.example.com/authorize")).toBe(
      true,
    );
    expect(await passed.text()).toBe("next");
  });

  test("the OAuth2 callback route answers at its configured path only", async () => {
    const { auth } = setup({ routes: { oauth2Callback: "/login/callback" } });

    const answered = await auth.middleware(request("/login/callback?code=x&state=y"));
    const passed = await auth.middleware(request("/api/pb/oauth2/callback?code=x&state=y"));

    expect(answered.status).toBe(302);
    expect(answered.headers.get("location")).toContain("oauth2_error=missing-cookie");
    expect(await passed.text()).toBe("next");
  });

  test("two parallel requests for two users each carry only their own session", async () => {
    const { auth, forwarded } = setup();

    const responses = await Promise.all([
      auth.middleware(
        request("/a", { cookie: sessionCookie("__Host-pb_auth", token("u1", 1), "u1") }),
      ),
      auth.middleware(
        request("/b", { cookie: sessionCookie("__Host-pb_auth", token("u2", 1), "u2") }),
      ),
    ]);

    expect(sessionTokenOf(cookieLine(responses[0]!, "__Host-pb_auth"))).toBe(token("u1", 2));
    expect(sessionTokenOf(cookieLine(responses[1]!, "__Host-pb_auth"))).toBe(token("u2", 2));
    const users = forwarded
      .map(forwardedUser)
      .map((user) => `${String(user.tokenId)}/${String(user.recordId)}`);
    expect(users).toHaveLength(2);
    expect(users).toContain("u1/u1");
    expect(users).toContain("u2/u2");
  });
});

describe("createNextAuth: serverSession", () => {
  test("a read-only cookie store does not throw, and the refresh updates memory only", async () => {
    const { auth } = setup();
    let writes = 0;
    const store: NextCookieStore = {
      getAll: () => [
        {
          name: "__Host-pb_auth",
          value: encodeURIComponent(
            JSON.stringify({ token: token("u1", 1), record: record("u1") }),
          ),
        },
      ],
      set: () => {
        writes++;
        throw new Error("Cookies can only be modified in a Server Action or Route Handler.");
      },
    };

    const session = await auth.serverSession({ cookies: store });

    expect(tokenVersion(session.server.authStore.token)).toBe(2);
    expect(writes).toBeGreaterThan(0);
  });

  test("the x-iglo-base-secure header names the cookie, ahead of the app origin", async () => {
    const { auth } = setup();
    const headers = new Headers({ "x-iglo-base-secure": "0" });
    // origin is https, so the origin alone would look for __Host-pb_auth; the plain name is read
    const store = readOnlyStore(
      `pb_auth=${encodeURIComponent(JSON.stringify({ token: token("u1", 1), record: record("u1") }))}`,
    );

    const session = await auth.serverSession({ cookies: store, headers });

    expect(tokenVersion(session.server.authStore.token)).toBe(2);
  });
});

describe("createNextAuth: no-cache headers and runtime", () => {
  test("the pass-through response of a request that carries the session cookie gets the no-cache headers", async () => {
    const { auth } = setup({
      fetch: async () => json(500, { message: "down" }),
    });

    const response = await auth.middleware(
      request("/dashboard", { cookie: sessionCookie("__Host-pb_auth", token("u1", 1), "u1") }),
    );

    expect(response.headers.get("cache-control")).toBe(
      SSR_NO_CACHE_HEADERS["Cache-Control"] ?? null,
    );
    expect(response.headers.get("pragma")).toBe("no-cache");
  });

  test("a pass-through response with immutable headers is sent as a copy with its headers, cookies and no-cache headers", async () => {
    const { auth } = setup({
      next: () =>
        immutableResponse(new Response("next", { status: 200, headers: { "x-app": "1" } })),
    });

    const response = await auth.middleware(
      request("/dashboard", { cookie: sessionCookie("__Host-pb_auth", token("u1", 1), "u1") }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("next");
    expect(response.headers.get("x-app")).toBe("1");
    expect(cookieLine(response, "__Host-pb_auth")).toBeDefined();
    expect(response.headers.get("cache-control")).toBe(
      SSR_NO_CACHE_HEADERS["Cache-Control"] ?? null,
    );
  });

  test("an anonymous pass-through response with immutable headers is returned as it is", async () => {
    const original = immutableResponse(new Response("public"));
    const { auth } = setup({ next: () => original });

    const response = await auth.middleware(request("/public"));

    expect(response).toBe(original);
  });

  test("the browser stub names the Node.js runtime for a bundle that loads the server-only module", async () => {
    await expect(import("@sdk/ssr/browser")).rejects.toThrow(/Node\.js runtime/);
  });
});
