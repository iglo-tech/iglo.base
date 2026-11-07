// docs/design/13-ssr.md ("Clients", "Session cookie", "Session cache, check and refresh")
// Regression tests for the round-1 review of P.13b (PR #91), through the public SSR API.
import { describe, expect, test, beforeAll, afterAll, afterEach } from "bun:test";
import { FetchMock, dummyJWT } from "@sdk-test/mocks";
import { ClientResponseError } from "@sdk/ClientResponseError";
import {
  createServerClient,
  createSuperuserClient,
  createSessionCache,
  type CookieAdapter,
  type CookieToSet,
} from "@sdk/ssr/index";

const API = "http://localhost:8090";
// authStore.isValid checks expiry against the real clock, so token times are relative to now.
const NOW = Math.floor(Date.now() / 1000);
const CLOCK = NOW * 1000;
const APP = "http://localhost:3000";
const HTTPS_APP = "https://my-app.example.com";

/** A token shaped like the server's: `exp` and no `iat` claim. */
function serverToken(opts: { exp: number; id?: string; collectionId?: string }): string {
  return dummyJWT({
    exp: opts.exp,
    id: opts.id ?? "u1",
    collectionId: opts.collectionId ?? "users",
    type: "auth",
    refreshable: true,
  });
}

/** A cookie adapter that keeps what the SDK writes. */
function jar(initial: Array<{ name: string; value: string }>) {
  const written: CookieToSet[][] = [];
  let cookies = initial;
  const adapter: CookieAdapter = {
    getAll: () => cookies,
    setAll: (c) => {
      written.push(c);
      cookies = c.filter((x) => x.value !== "").map((x) => ({ name: x.name, value: x.value }));
    },
  };
  return { adapter, written };
}

/** A superuser token that expires at `exp` (seconds). */
function superuserToken(exp: number): string {
  return dummyJWT({
    exp,
    id: "su_tok",
    collectionId: "_superusers",
    type: "auth",
    refreshable: true,
  });
}

function sessionValue(token: string, record: Record<string, unknown> = {}): string {
  return JSON.stringify({ token, record });
}

describe("SSR server core: round-1 regressions", () => {
  const fetchMock = new FetchMock();

  beforeAll(() => {
    fetchMock.init();
  });

  afterAll(() => {
    fetchMock.restore();
  });

  afterEach(() => {
    fetchMock.clearMocks();
  });

  describe("half-life refresh with server-shaped tokens", () => {
    test("five page loads of a 5-day session cost one auth-refresh in total", async () => {
      const cache = createSessionCache();
      const base = NOW;
      const token = serverToken({ exp: base + 432_000, id: "u_5d", collectionId: "col_5d" });
      let refreshCalls = 0;

      fetchMock.on({
        method: "POST",
        url: `${API}/api/collections/col_5d/auth-refresh`,
        replyCode: 200,
        replyHeaders: { Date: new Date(base * 1000).toUTCString() },
        replyBody: () => {
          refreshCalls++;
          return { token, record: { id: "u_5d", collectionId: "col_5d", email: "a@x.y" } };
        },
      });

      const { adapter } = jar([{ name: "pb_auth", value: sessionValue(token) }]);
      for (let i = 0; i < 5; i++) {
        const pb = await createServerClient({
          url: API,
          origin: APP,
          cookies: adapter,
          sessionCache: cache,
          clock: () => (base + 5 * i) * 1000,
        });
        expect(pb.authStore.isValid).toBe(true);
      }
      expect(refreshCalls).toBe(1);
    });

    test("100 parallel page loads of one session share one auth-refresh", async () => {
      const cache = createSessionCache();
      const base = NOW;
      const token = serverToken({ exp: base + 3600, id: "u_par" });
      const newToken = serverToken({ exp: base + 3600, id: "u_par" });
      let refreshCalls = 0;

      fetchMock.on({
        method: "POST",
        url: `${API}/api/collections/users/auth-refresh`,
        delay: 50,
        replyCode: 200,
        replyHeaders: { Date: new Date(base * 1000).toUTCString() },
        replyBody: () => {
          refreshCalls++;
          return { token: newToken, record: { id: "u_par", collectionName: "users" } };
        },
      });

      const { adapter } = jar([{ name: "pb_auth", value: sessionValue(token) }]);
      const clients = await Promise.all(
        Array.from({ length: 100 }, () =>
          createServerClient({
            url: API,
            origin: APP,
            cookies: adapter,
            sessionCache: cache,
            clock: () => base * 1000,
          }),
        ),
      );

      expect(refreshCalls).toBe(1);
      for (const pb of clients) {
        expect(pb.authStore.token).toBe(newToken);
        expect(pb.authStore.isValid).toBe(true);
      }
    });

    test("a learned lifetime is kept when the app replaces pb.afterSend", async () => {
      const cache = createSessionCache();
      const base = NOW;
      const token = serverToken({ exp: base + 600, id: "u_as", collectionId: "col_as" });

      fetchMock.on({
        method: "POST",
        url: `${API}/api/collections/col_as/auth-with-password`,
        replyCode: 200,
        replyHeaders: { Date: new Date(base * 1000).toUTCString() },
        replyBody: { token, record: { id: "u_as", collectionId: "col_as" } },
      });

      const pb = await createServerClient({
        url: API,
        origin: APP,
        cookies: { getAll: () => [] },
        sessionCache: cache,
        clock: () => base * 1000,
      });
      // The app replaces the hook before the sign-in; the SDK must still learn from the response
      pb.afterSend = (_response, data) => data;
      await pb.collection("col_as").authWithPassword("a@x.y", "pass");

      expect(cache.getCollectionLifetime("col_as")).toBe(600);
    });
  });

  describe("cache TTL and shared outcome", () => {
    test("a 401 on the refresh clears every waiting client, not only the first", async () => {
      const cache = createSessionCache();
      const token = serverToken({ exp: NOW + 86_400, id: "u_gone" });
      fetchMock.on({
        method: "POST",
        url: `${API}/api/collections/users/auth-refresh`,
        delay: 30,
        replyCode: 401,
        replyBody: { code: 401, message: "The request requires valid record authorization token." },
      });

      const jars = Array.from({ length: 10 }, () =>
        jar([{ name: "pb_auth", value: sessionValue(token, { id: "u_gone" }) }]),
      );
      const clients = await Promise.all(
        jars.map((j) =>
          createServerClient({
            url: API,
            origin: APP,
            cookies: j.adapter,
            sessionCache: cache,
            clock: () => CLOCK,
          }),
        ),
      );

      for (const pb of clients) {
        expect(pb.authStore.isValid).toBe(false);
        expect(pb.authStore.record).toBeNull();
      }
      for (const j of jars) {
        expect(j.written.length).toBe(1);
        expect(j.written[0]![0]!.options?.maxAge).toBe(0);
      }
    });

    test("a non-forced client that joins a verify() flight keeps its session on 503", async () => {
      const cache = createSessionCache();
      const token = serverToken({ exp: NOW + 86_400, id: "u_503" });
      fetchMock.on({
        method: "POST",
        url: `${API}/api/collections/users/auth-refresh`,
        delay: 50,
        replyCode: 503,
        replyBody: { code: 503, message: "Service Unavailable" },
      });

      const seed = jar([{ name: "pb_auth", value: sessionValue(token, { id: "u_503" }) }]);
      const verifyClient = await createServerClient({
        url: API,
        origin: APP,
        cookies: seed.adapter,
        sessionCache: cache,
        clock: () => CLOCK,
      }).catch(() => undefined);
      expect(verifyClient).toBeDefined();

      const verifying = verifyClient!.auth.verify();
      const joining = createServerClient({
        url: API,
        origin: APP,
        cookies: seed.adapter,
        sessionCache: cache,
        clock: () => CLOCK,
      });

      const joined = await joining;
      expect(joined.authStore.isValid).toBe(true);
      await expect(verifying).rejects.toBeInstanceOf(ClientResponseError);
      expect(seed.written.length).toBe(0);
    });

    test("ttl is honored: a check after the TTL goes to the server", async () => {
      let now = CLOCK;
      const cache = createSessionCache({ ttl: 1000, clock: () => now });
      const token = serverToken({ exp: NOW + 86_400, id: "u_ttl" });
      let refreshCalls = 0;
      fetchMock.on({
        method: "POST",
        url: `${API}/api/collections/users/auth-refresh`,
        replyCode: 200,
        replyHeaders: () => ({ Date: new Date(now).toUTCString() }),
        replyBody: () => {
          refreshCalls++;
          return { token, record: { id: "u_ttl", collectionName: "users" } };
        },
      });
      const { adapter } = jar([{ name: "pb_auth", value: sessionValue(token) }]);
      const load = () =>
        createServerClient({
          url: API,
          origin: APP,
          cookies: adapter,
          sessionCache: cache,
          clock: () => now,
        });

      await load();
      expect(refreshCalls).toBe(1);
      now += 500;
      await load();
      expect(refreshCalls).toBe(1);
      now += 60_000;
      await load();
      expect(refreshCalls).toBe(2);
    });
  });

  describe("cookie security follows the app, not iglo.base", () => {
    test("an https app talking to an http backend gets __Host- and Secure", async () => {
      const { adapter, written } = jar([]);
      fetchMock.on({
        method: "POST",
        url: `${API}/api/collections/users/auth-with-password`,
        replyCode: 200,
        replyHeaders: { Date: new Date(CLOCK).toUTCString() },
        replyBody: {
          token: serverToken({ exp: NOW + 86_400, id: "u_s" }),
          record: { id: "u_s", collectionName: "users" },
        },
      });
      const pb = await createServerClient({
        url: API,
        origin: HTTPS_APP,
        cookies: adapter,
        clock: () => CLOCK,
      });
      await pb.collection("users").authWithPassword("a@b.c", "pass");
      const cookie = written[written.length - 1]![0]!;
      expect(cookie.name).toBe("__Host-pb_auth");
      expect(cookie.options?.secure).toBe(true);
      expect(cookie.options?.path).toBe("/");
      expect(cookie.options?.domain).toBeUndefined();
    });

    test("a local http app talking to an https backend gets a plain, non-Secure cookie", async () => {
      const { adapter, written } = jar([]);
      fetchMock.on({
        method: "POST",
        url: "https://api.example.com/api/collections/users/auth-with-password",
        replyCode: 200,
        replyHeaders: { Date: new Date(CLOCK).toUTCString() },
        replyBody: {
          token: serverToken({ exp: NOW + 86_400, id: "u_l" }),
          record: { id: "u_l", collectionName: "users" },
        },
      });
      const pb = await createServerClient({
        url: "https://api.example.com",
        origin: APP,
        cookies: adapter,
        clock: () => CLOCK,
      });
      await pb.collection("users").authWithPassword("a@b.c", "pass");
      const cookie = written[written.length - 1]![0]!;
      expect(cookie.name).toBe("pb_auth");
      expect(cookie.options?.secure).toBe(false);
    });

    test("cookieOptions cannot produce a __Host- cookie that browsers reject", async () => {
      const { adapter, written } = jar([]);
      fetchMock.on({
        method: "POST",
        url: `${API}/api/collections/users/auth-with-password`,
        replyCode: 200,
        replyHeaders: { Date: new Date(CLOCK).toUTCString() },
        replyBody: {
          token: serverToken({ exp: NOW + 86_400, id: "u_o" }),
          record: { id: "u_o", collectionName: "users" },
        },
      });
      const pb = await createServerClient({
        url: API,
        origin: HTTPS_APP,
        cookies: adapter,
        cookieOptions: { domain: "example.com" },
        clock: () => CLOCK,
      });
      await pb.collection("users").authWithPassword("a@b.c", "pass");
      const cookie = written[written.length - 1]![0]!;
      expect(cookie.name).toBe("__Host-pb_auth");
      expect(cookie.options?.domain).toBeUndefined();
      expect(cookie.options?.secure).toBe(true);
    });

    test("a revoked session on https clears the prefixed and the plain cookie", async () => {
      const token = serverToken({ exp: NOW + 86_400, id: "u_clr" });
      fetchMock.on({
        method: "POST",
        url: `${API}/api/collections/users/auth-refresh`,
        replyCode: 401,
        replyBody: { code: 401, message: "unauthorized" },
      });
      const { adapter, written } = jar([
        { name: "__Host-pb_auth", value: sessionValue(token, { id: "u_clr" }) },
      ]);
      await createServerClient({
        url: API,
        origin: HTTPS_APP,
        cookies: adapter,
        clock: () => CLOCK,
      });
      const names = written[written.length - 1]!.map((c: CookieToSet) => c.name);
      expect(names).toEqual(["__Host-pb_auth", "pb_auth"]);
    });

    test("a session cookie under the plain name (before the prefix) is still read", async () => {
      const token = serverToken({ exp: NOW + 86_400, id: "u_plain" });
      fetchMock.on({
        method: "POST",
        url: `${API}/api/collections/users/auth-refresh`,
        replyCode: 200,
        replyHeaders: { Date: new Date(CLOCK).toUTCString() },
        replyBody: { token, record: { id: "u_plain", collectionName: "users" } },
      });
      const { adapter } = jar([{ name: "pb_auth", value: sessionValue(token, { id: "u_plain" }) }]);
      const pb = await createServerClient({
        url: API,
        origin: HTTPS_APP,
        cookies: adapter,
        clock: () => CLOCK,
      });
      expect(pb.authStore.record?.id).toBe("u_plain");
    });
  });

  describe("cookie value handling", () => {
    test("a record value containing %41 is read back unchanged, raw or decoded", async () => {
      const token = serverToken({ exp: NOW + 86_400, id: "u_pct" });
      const record = { id: "u_pct", collectionName: "users", name: "a%41b" };
      const decoded = sessionValue(token, record);

      for (const value of [decoded, encodeURIComponent(decoded)]) {
        const pb = await createServerClient({
          url: API,
          origin: APP,
          cookies: { getAll: () => [{ name: "pb_auth", value }] },
          clock: () => CLOCK,
        });
        expect(pb.authStore.record?.name).toBe("a%41b");
      }
    });

    test("a cookie whose record belongs to another user is not trusted", async () => {
      const token = serverToken({ exp: NOW + 86_400, id: "u_real" });
      const pb = await createServerClient({
        url: API,
        origin: APP,
        cookies: {
          getAll: () => [{ name: "pb_auth", value: sessionValue(token, { id: "u_someone_else" }) }],
        },
        clock: () => CLOCK,
      });
      expect(pb.authStore.record).toBeNull();
    });

    test("a throwing setAll does not reject the request on the revoke path", async () => {
      const token = serverToken({ exp: NOW + 86_400, id: "u_throw" });
      fetchMock.on({
        method: "POST",
        url: `${API}/api/collections/users/auth-refresh`,
        replyCode: 401,
        replyBody: { code: 401, message: "unauthorized" },
      });
      const pb = await createServerClient({
        url: API,
        origin: APP,
        cookies: {
          getAll: () => [{ name: "pb_auth", value: sessionValue(token, { id: "u_throw" }) }],
          setAll: () => {
            throw new Error("cookies are read-only in this context");
          },
        },
        clock: () => CLOCK,
      });
      expect(pb.authStore.isValid).toBe(false);
    });
  });

  describe("request handling", () => {
    test("cache: no-store and the custom fetch survive an app's beforeSend", async () => {
      const token = serverToken({ exp: NOW + 86_400, id: "u_bs" });
      const seen: Array<RequestInit | undefined> = [];
      fetchMock.on({
        method: "GET",
        url: `${API}/api/collections/users/records/u_bs`,
        additionalMatcher: (_url, config) => {
          seen.push(config as RequestInit);
          return true;
        },
        replyCode: 200,
        replyBody: { id: "u_bs", collectionName: "users" },
      });

      let customFetchCalls = 0;
      const pb = await createServerClient({
        url: API,
        origin: APP,
        cookies: {
          getAll: () => [{ name: "pb_auth", value: sessionValue(token, { id: "u_bs" }) }],
        },
        fetch: (url, cfg) => {
          customFetchCalls++;
          return globalThis.fetch(url, cfg);
        },
        clock: () => CLOCK,
      });
      customFetchCalls = 0; // the init refresh went through the custom fetch too
      pb.beforeSend = (url, options) => ({ url, options: { ...options, cache: "default" } });

      await pb.collection("users").getOne("u_bs");
      expect(customFetchCalls).toBe(1);
      expect(seen[seen.length - 1]?.cache).toBe("no-store");
    });

    test("a 401 from a data call with a valid user token keeps the session", async () => {
      const token = serverToken({ exp: NOW + 86_400, id: "u_nope" });
      fetchMock.on({
        method: "POST",
        url: `${API}/api/collections/users/auth-refresh`,
        replyCode: 200,
        replyHeaders: { Date: new Date(CLOCK).toUTCString() },
        replyBody: { token, record: { id: "u_nope", collectionName: "users" } },
      });
      fetchMock.on({
        method: "GET",
        url: `${API}/api/collections/_superusers/records`,
        replyCode: 401,
        replyBody: { code: 401, message: "Only superusers can access this action." },
      });
      const pb = await createServerClient({
        url: API,
        origin: APP,
        cookies: {
          getAll: () => [{ name: "pb_auth", value: sessionValue(token, { id: "u_nope" }) }],
        },
        clock: () => CLOCK,
      });
      await expect(pb.collection("_superusers").getList(1, 1)).rejects.toBeInstanceOf(
        ClientResponseError,
      );
      expect(pb.authStore.isValid).toBe(true);
    });
  });

  describe("clock skew", () => {
    test("an app clock ahead of the server does not drop a session the server still accepts", async () => {
      const serverNow = NOW;
      const cache = createSessionCache();
      const warm = serverToken({ exp: serverNow + 86_400, id: "u_skew" });
      let refreshCalls = 0;
      fetchMock.on({
        method: "POST",
        url: `${API}/api/collections/users/auth-refresh`,
        replyCode: 200,
        replyHeaders: () => ({ Date: new Date(serverNow * 1000).toUTCString() }),
        replyBody: () => {
          refreshCalls++;
          return { token: warm, record: { id: "u_skew", collectionName: "users" } };
        },
      });
      // Learn the offset: the app clock is 200 s ahead of the server's Date header.
      const appAhead = (serverNow + 200) * 1000;
      await createServerClient({
        url: API,
        origin: APP,
        cookies: { getAll: () => [{ name: "pb_auth", value: sessionValue(warm) }] },
        sessionCache: cache,
        clock: () => appAhead,
      });
      expect(refreshCalls).toBe(1);

      // Server time is serverNow. A token 30 s past its exp is inside the 60 s allowance:
      // it is kept and checked with the server (uncorrected, the app would drop it at +200 s).
      const justExpired = serverToken({ exp: serverNow - 30, id: "u_skew" });
      const pb = await createServerClient({
        url: API,
        origin: APP,
        cookies: { getAll: () => [{ name: "pb_auth", value: sessionValue(justExpired) }] },
        sessionCache: cache,
        clock: () => appAhead,
      });
      expect(refreshCalls).toBe(2);
      expect(pb.authStore.isValid).toBe(true);
    });

    test("an app clock behind the server drops a token the server considers expired", async () => {
      const serverNow = NOW;
      const cache = createSessionCache();
      const warm = serverToken({ exp: serverNow + 86_400, id: "u_late" });
      let refreshCalls = 0;
      fetchMock.on({
        method: "POST",
        url: `${API}/api/collections/users/auth-refresh`,
        replyCode: 200,
        replyHeaders: () => ({ Date: new Date(serverNow * 1000).toUTCString() }),
        replyBody: () => {
          refreshCalls++;
          return { token: warm, record: { id: "u_late", collectionName: "users" } };
        },
      });
      await createServerClient({
        url: API,
        origin: APP,
        cookies: { getAll: () => [{ name: "pb_auth", value: sessionValue(warm) }] },
        sessionCache: cache,
        clock: () => (serverNow - 200) * 1000,
      });
      expect(refreshCalls).toBe(1);

      // Server time is serverNow; this token expired 100 s before that (beyond the 60 s allowance).
      const expired = serverToken({ exp: serverNow - 100, id: "u_late" });
      const pb = await createServerClient({
        url: API,
        origin: APP,
        cookies: { getAll: () => [{ name: "pb_auth", value: sessionValue(expired) }] },
        sessionCache: cache,
        clock: () => (serverNow - 200) * 1000,
      });
      expect(refreshCalls).toBe(1);
      expect(pb.authStore.isValid).toBe(false);
    });
  });

  describe("sign-in and sign-out through the adapter", () => {
    test("a sign-in and a sign-out each write one cookie, not duplicates", async () => {
      const { adapter, written } = jar([]);
      fetchMock.on({
        method: "POST",
        url: `${API}/api/collections/users/auth-with-password`,
        replyCode: 200,
        replyHeaders: { Date: new Date(CLOCK).toUTCString() },
        replyBody: {
          token: serverToken({ exp: NOW + 86_400, id: "u_si" }),
          record: { id: "u_si", collectionName: "users" },
        },
      });
      const pb = await createServerClient({
        url: API,
        origin: HTTPS_APP,
        cookies: adapter,
        clock: () => CLOCK,
      });
      await pb.collection("users").authWithPassword("a@b.c", "pass");
      expect(written.length).toBe(1);
      pb.authStore.clear();
      expect(written.length).toBe(2);
      expect(written[1]!.map((c) => c.options?.maxAge)).toEqual([0, 0]);
    });
  });

  describe("superuser client", () => {
    test("re-authenticates with the password when the refresh is rejected", async () => {
      let authCalls = 0;
      let refreshCalls = 0;
      const soonToken = dummyJWT({
        exp: Math.floor(Date.now() / 1000) + 200,
        id: "su_re",
        collectionId: "_superusers",
        type: "auth",
        refreshable: true,
      });
      const freshToken = dummyJWT({
        exp: Math.floor(Date.now() / 1000) + 3600,
        id: "su_re",
        collectionId: "_superusers",
        type: "auth",
        refreshable: true,
      });

      fetchMock.on({
        method: "POST",
        url: `${API}/api/collections/_superusers/auth-with-password`,
        replyCode: 200,
        replyBody: () => {
          authCalls++;
          return {
            token: authCalls === 1 ? soonToken : freshToken,
            record: { id: "su_re", collectionName: "_superusers", email: "admin@example.com" },
          };
        },
      });
      fetchMock.on({
        method: "POST",
        url: `${API}/api/collections/_superusers/auth-refresh`,
        replyCode: 401,
        replyBody: { code: 401, message: "The request requires valid record authorization token." },
      });
      fetchMock.on({
        method: "GET",
        url: `${API}/api/collections/users/records`,
        replyCode: 200,
        replyBody: () => {
          refreshCalls++;
          return { page: 1, perPage: 1, totalItems: 0, totalPages: 0, items: [] };
        },
      });

      const superuser = await createSuperuserClient({
        url: API,
        email: "admin@example.com",
        password: "secretpassword",
        autoRefreshThreshold: 300,
      });
      expect(authCalls).toBe(1);

      await superuser.collection("users").getList(1, 1);
      expect(authCalls).toBe(2);
      expect(superuser.authStore.token).toBe(freshToken);
      expect(refreshCalls).toBe(1);
    });
  });

  describe("superuser token mode", () => {
    test("auto refresh stays active after a successful refresh", async () => {
      let refreshCalls = 0;
      const nowSec = Math.floor(Date.now() / 1000);
      fetchMock.on({
        method: "POST",
        url: `${API}/api/collections/_superusers/auth-refresh`,
        replyCode: 200,
        replyBody: () => {
          refreshCalls++;
          return {
            token: superuserToken(nowSec + 200 + refreshCalls),
            record: { id: "su_tok", collectionId: "_superusers", collectionName: "_superusers" },
          };
        },
      });
      fetchMock.on({
        method: "GET",
        url: `${API}/api/collections/users/records`,
        replyCode: 200,
        replyBody: { page: 1, perPage: 1, totalItems: 0, totalPages: 0, items: [] },
      });

      // expires within the threshold, so every request refreshes first
      const superuser = await createSuperuserClient({
        url: API,
        token: superuserToken(nowSec + 200),
        autoRefreshThreshold: 300,
      });
      await superuser.collection("users").getList(1, 1);
      expect(refreshCalls).toBe(1);
      await superuser.collection("users").getList(1, 1);
      expect(refreshCalls).toBe(2);
    });
  });
});
