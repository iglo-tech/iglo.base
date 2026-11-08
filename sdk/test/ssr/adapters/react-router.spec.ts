// docs/design/13-ssr.md ("Framework adapters": iglo.base/ssr/react-router; "Session cookie"; "CSRF";
// "OAuth2"). The React Router adapter through its public API: session() on a Web Request, which
// answers with a route response or with the resumed session and the headers it wrote. iglo.base is
// a fake fetch that answers the requests the adapter sends and fails any other.
import { describe, expect, test } from "bun:test";
import { dummyJWT } from "@sdk-test/mocks";
import type { RequestSession } from "@sdk/ssr/adapter";
import { createSessionCache } from "@sdk/ssr/index";
import { createReactRouterAuth, type ReactRouterAuth } from "@sdk/ssr/react-router";
import { getTokenPayload } from "@sdk/tools/jwt";

const API = "http://127.0.0.1:8090";
const APP = "https://app.example.com";
const NOW_SEC = Math.floor(Date.now() / 1000);
const NOW_UTC = new Date(NOW_SEC * 1000).toUTCString();

type Fetch = (url: RequestInfo | URL, config?: RequestInit) => Promise<Response>;
type AuthOptions = Parameters<typeof createReactRouterAuth>[0];

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
    if (method === "POST" && pathname === "/api/collections/users/auth-with-password") {
      const body = JSON.parse(String(config?.body ?? "{}")) as { identity?: string };
      const id = (body.identity ?? "").split("@")[0] ?? "";
      return json(200, { token: token(id, 1), record: record(id) });
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

/** An adapter for the tests, in fallback mode (`readableCookie`), so no superuser fake is needed. */
function setup(overrides: Partial<AuthOptions> = {}): ReactRouterAuth {
  return createReactRouterAuth({
    url: API,
    origin: APP,
    readableCookie: true,
    sessionCache: createSessionCache(),
    fetch: fakeIglo(),
    ...overrides,
  });
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
function cookieLine(headers: Headers, name: string): string | undefined {
  return headers.getSetCookie().find((line) => line.startsWith(`${name}=`));
}

/** The session token in a Set-Cookie line, read as the browser stores it. */
function sessionTokenOf(line: string | undefined): string {
  const value = (line ?? "").slice((line ?? "").indexOf("=") + 1).split(";")[0] ?? "";
  return (JSON.parse(decodeURIComponent(value)) as { token: string }).token;
}

/**
 * The session of a request the adapter does not answer itself, and the headers it has at the
 * moment the test reads them (the route reads them when it responds).
 */
async function sessionOf(
  auth: ReactRouterAuth,
  req: Request,
): Promise<{ session: RequestSession; headers: Headers }> {
  const result = await auth.session(req);
  if (!("session" in result)) {
    throw new Error("the request was answered by the adapter, not passed on");
  }
  return { session: result.session, headers: result.headers() };
}

/** The response of a request the adapter answers itself; throws when it does not. */
async function responseOf(auth: ReactRouterAuth, req: Request): Promise<Response> {
  const result = await auth.session(req);
  if (!("response" in result)) {
    throw new Error("the request was passed on, not answered by the adapter");
  }
  return result.response;
}

describe("createReactRouterAuth: session", () => {
  test("resumes the session and returns the refreshed cookie in the headers", async () => {
    const auth = setup();

    const { session, headers } = await sessionOf(
      auth,
      request("/dashboard", { cookie: sessionCookie("__Host-pb_auth", token("u1", 1), "u1") }),
    );

    expect(tokenVersion(session.server.authStore.token)).toBe(2);
    expect(tokenVersion(sessionTokenOf(cookieLine(headers, "__Host-pb_auth")))).toBe(2);
  });

  test("a revoked session returns its cleared cookie", async () => {
    const auth = setup();

    const { headers } = await sessionOf(
      auth,
      request("/dashboard", {
        cookie: sessionCookie("__Host-pb_auth", token("revoked", 1), "revoked"),
      }),
    );

    const line = cookieLine(headers, "__Host-pb_auth");
    expect(line).toContain("Max-Age=0");
    expect(line?.startsWith("__Host-pb_auth=;")).toBe(true);
  });

  test("the headers of a cookie write carry the no-cache headers", async () => {
    const auth = setup();

    const { headers } = await sessionOf(
      auth,
      request("/dashboard", { cookie: sessionCookie("__Host-pb_auth", token("u1", 1), "u1") }),
    );

    expect(headers.get("cache-control")).toContain("no-store");
    expect(headers.get("pragma")).toBe("no-cache");
    expect(headers.get("expires")).toBe("0");
  });

  test("a sign-in made after session() is in the headers the route reads when it responds", async () => {
    const auth = setup();
    const result = await auth.session(request("/login", { method: "POST", origin: APP }));
    if (!("session" in result)) {
      throw new Error("the request was answered by the adapter, not passed on");
    }
    // the handler signs in after the adapter has resumed the (anonymous) session
    await result.session.server.collection("users").authWithPassword("u2@example.com", "pw");

    const headers = result.headers();
    const line = cookieLine(headers, "__Host-pb_auth");
    expect(line).toBeDefined();
    expect(line).not.toContain("Max-Age=0");
    expect(getTokenPayload(sessionTokenOf(line))["id"]).toBe("u2");
    expect(headers.get("cache-control")).toContain("no-store");
  });

  test("a sign-out made after session() clears the cookie in the headers the route reads", async () => {
    const auth = setup();
    const result = await auth.session(
      request("/logout", {
        method: "POST",
        origin: APP,
        cookie: sessionCookie("__Host-pb_auth", token("u1", 1), "u1"),
      }),
    );
    if (!("session" in result)) {
      throw new Error("the request was answered by the adapter, not passed on");
    }
    result.session.server.authStore.clear();

    // the session check refreshed the cookie first; the browser applies the lines in order, so the
    // last line for the name is the one that stays
    const lines = result
      .headers()
      .getSetCookie()
      .filter((l) => l.startsWith("__Host-pb_auth="));
    const last = lines[lines.length - 1];
    expect(lines.length).toBe(2);
    expect(last?.startsWith("__Host-pb_auth=;")).toBe(true);
    expect(last).toContain("Max-Age=0");
  });

  test("a request carrying the session cookie gets the no-cache headers on its CSRF rejection", async () => {
    const auth = setup();
    const response = await responseOf(
      auth,
      request("/logout", {
        method: "POST",
        origin: "https://evil.example",
        cookie: sessionCookie("__Host-pb_auth", token("u1", 1), "u1"),
      }),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  test("a request without a session returns no Set-Cookie and no no-cache headers", async () => {
    const auth = setup();

    const { headers } = await sessionOf(auth, request("/public"));

    expect(headers.getSetCookie()).toEqual([]);
    expect(headers.get("cache-control")).toBeNull();
  });

  test("a POST from a foreign origin with the session cookie is answered 403", async () => {
    const auth = setup();

    const response = await responseOf(
      auth,
      request("/account", {
        method: "POST",
        origin: "https://evil.example",
        cookie: sessionCookie("__Host-pb_auth", token("u1", 1), "u1"),
      }),
    );

    expect(response.status).toBe(403);
  });

  test("the same POST with csrf: false is passed on", async () => {
    const auth = setup({ csrf: false });

    const result = await sessionOf(
      auth,
      request("/account", {
        method: "POST",
        origin: "https://evil.example",
        cookie: sessionCookie("__Host-pb_auth", token("u1", 1), "u1"),
      }),
    );

    expect(tokenVersion(result.session.server.authStore.token)).toBe(2);
  });

  test("a GET from a foreign origin is never rejected", async () => {
    const auth = setup();

    const result = await sessionOf(
      auth,
      request("/account", {
        origin: "https://evil.example",
        cookie: sessionCookie("__Host-pb_auth", token("u1", 1), "u1"),
      }),
    );

    expect(tokenVersion(result.session.server.authStore.token)).toBe(2);
  });

  test("the renew route answers at its configured path only", async () => {
    const auth = setup({ routes: { renew: "/auth/renew" } });
    const cookie = sessionCookie("__Host-pb_auth", token("u1", 1), "u1");

    const answered = await responseOf(
      auth,
      request("/auth/renew", { method: "POST", origin: APP, cookie }),
    );
    const passed = await auth.session(
      request("/api/pb/renew", { method: "POST", origin: APP, cookie }),
    );

    expect(answered.status).toBe(200);
    expect(((await answered.json()) as { token: string }).token).toBe(token("u1", 2));
    expect("session" in passed).toBe(true);
  });

  test("renew: false leaves the default renew path to the app", async () => {
    const auth = setup({ routes: { renew: false } });

    const result = await sessionOf(
      auth,
      request("/api/pb/renew", {
        method: "POST",
        origin: APP,
        cookie: sessionCookie("__Host-pb_auth", token("u1", 1), "u1"),
      }),
    );

    expect(tokenVersion(result.session.server.authStore.token)).toBe(2);
  });

  test("the popup route answers at its configured path only", async () => {
    const auth = setup({ routes: { popup: "/auth/popup" } });
    const body = JSON.stringify({ token: token("u1", 1) });
    const headers = { "content-type": "application/json" };

    const answered = await responseOf(
      auth,
      request("/auth/popup", { method: "POST", origin: APP, body, headers }),
    );
    const passed = await auth.session(
      request("/api/pb/popup", { method: "POST", origin: APP, body, headers }),
    );

    expect(answered.status).toBe(200);
    expect(((await answered.json()) as { record: { id: string } }).record.id).toBe("u1");
    expect("session" in passed).toBe(true);
  });

  test("the OAuth2 start route redirects at its configured path only", async () => {
    const auth = setup({ routes: { oauth2Start: "/login" } });

    const answered = await responseOf(auth, request("/login/oidc"));
    const passed = await auth.session(request("/api/pb/oauth2/start/oidc"));

    expect(answered.status).toBe(302);
    expect(answered.headers.get("location")?.startsWith("https://idp.example.com/authorize")).toBe(
      true,
    );
    expect("session" in passed).toBe(true);
  });

  test("the OAuth2 callback route answers at its configured path only", async () => {
    const auth = setup({ routes: { oauth2Callback: "/login/callback" } });

    const answered = await responseOf(auth, request("/login/callback?code=x&state=y"));
    const passed = await auth.session(request("/api/pb/oauth2/callback?code=x&state=y"));

    expect(answered.status).toBe(302);
    expect(answered.headers.get("location")).toContain("oauth2_error=missing-cookie");
    expect("session" in passed).toBe(true);
  });

  test("two parallel requests for two users each see only their own session", async () => {
    const auth = setup();

    const [first, second] = await Promise.all([
      sessionOf(
        auth,
        request("/a", { cookie: sessionCookie("__Host-pb_auth", token("u1", 1), "u1") }),
      ),
      sessionOf(
        auth,
        request("/b", { cookie: sessionCookie("__Host-pb_auth", token("u2", 1), "u2") }),
      ),
    ]);

    expect(first.session.server.authStore.record?.["id"]).toBe("u1");
    expect(tokenVersion(first.session.server.authStore.token)).toBe(2);
    expect(second.session.server.authStore.record?.["id"]).toBe("u2");
    expect(tokenVersion(second.session.server.authStore.token)).toBe(2);
    expect(getTokenPayload(second.session.server.authStore.token)["id"]).toBe("u2");
  });
});
