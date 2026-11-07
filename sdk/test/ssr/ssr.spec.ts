// docs/design/13-ssr.md ("Clients", "Session cookie", "Session cache, check and refresh")
import { describe, expect, test, beforeAll, afterAll, afterEach } from "bun:test";
import { FetchMock, dummyJWT } from "@sdk-test/mocks";
import { ClientResponseError } from "@sdk/ClientResponseError";
import {
  createServerClient,
  createSuperuserClient,
  createSessionCache,
  createRequestCookieAdapter,
  SSR_NO_CACHE_HEADERS,
  type CookieToSet,
  type CookieAdapter,
} from "@sdk/ssr/index";

describe("SSR Core", () => {
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

  describe("Cookie parsing and writing", () => {
    test("attributes on plain localhost dev (http localhost app talking to https backend)", async () => {
      const nowSec = 1_000_000;
      const exp = nowSec + 3600;
      // Server-shaped token has exp, id, collectionId, type, refreshable — but NO iat
      const token1 = dummyJWT({
        exp,
        id: "u1",
        collectionId: "users",
        type: "auth",
        refreshable: true,
      });
      const token2 = dummyJWT({
        exp: exp + 3600,
        id: "u1",
        collectionId: "users",
        type: "auth",
        refreshable: true,
      });

      const setCookies: CookieToSet[] = [];
      let setHeaders: Record<string, string> | undefined;

      const cookies: CookieAdapter = {
        getAll: () => [{ name: "pb_auth", value: JSON.stringify({ token: token1 }) }],
        setAll: (c, h) => {
          setCookies.push(...c);
          setHeaders = h;
        },
      };

      fetchMock.on({
        method: "POST",
        url: "https://remote.example.com/api/collections/users/auth-refresh",
        replyCode: 200,
        replyHeaders: { Date: new Date(nowSec * 1000).toUTCString() },
        replyBody: {
          token: token2,
          record: { id: "u1", collectionName: "users", email: "u1@example.com" },
        },
      });

      // App is http://localhost:3000 talking to remote https backend
      const client = await createServerClient({
        url: "https://remote.example.com",
        origin: "http://localhost:3000",
        cookies,
        clock: () => nowSec * 1000,
      });

      expect(client.authStore.token).toBe(token2);
      expect(setCookies.length).toBe(1);
      const cookie = setCookies[0]!;
      expect(cookie.name).toBe("pb_auth"); // No __Host- prefix on plain localhost dev
      expect(cookie.options?.secure).toBe(false);
      expect(cookie.options?.httpOnly).toBe(true);
      expect(cookie.options?.sameSite).toBe("lax");
      expect(cookie.options?.path).toBe("/");
      expect(cookie.options?.maxAge).toBe(7200);

      expect(setHeaders).toEqual(SSR_NO_CACHE_HEADERS);
    });

    test("attributes on README setup (https app talking to http://127.0.0.1:8090 backend)", async () => {
      const nowSec = 1_000_000;
      const exp = nowSec + 3600;
      const token1 = dummyJWT({
        exp,
        id: "u2",
        collectionId: "users",
        type: "auth",
        refreshable: true,
      });
      const token2 = dummyJWT({
        exp: exp + 3600,
        id: "u2",
        collectionId: "users",
        type: "auth",
        refreshable: true,
      });

      const setCookies: CookieToSet[] = [];
      let setHeaders: Record<string, string> | undefined;

      const cookies: CookieAdapter = {
        getAll: () => [{ name: "__Host-pb_auth", value: JSON.stringify({ token: token1 }) }],
        setAll: (c, h) => {
          setCookies.push(...c);
          setHeaders = h;
        },
      };

      fetchMock.on({
        method: "POST",
        url: "http://127.0.0.1:8090/api/collections/users/auth-refresh",
        replyCode: 200,
        replyHeaders: { Date: new Date(nowSec * 1000).toUTCString() },
        replyBody: {
          token: token2,
          record: { id: "u2", collectionName: "users", email: "u2@example.com" },
        },
      });

      // https app request talking to http://127.0.0.1:8090 backend
      const client = await createServerClient({
        url: "http://127.0.0.1:8090",
        origin: "https://my-app.example.com",
        cookies,
        clock: () => nowSec * 1000,
      });

      expect(client.authStore.token).toBe(token2);
      expect(setCookies.length).toBe(1);
      const cookie = setCookies[0]!;
      expect(cookie.name).toBe("__Host-pb_auth"); // Prefixed on https app
      expect(cookie.options?.secure).toBe(true);
      expect(cookie.options?.httpOnly).toBe(true);
      expect(cookie.options?.sameSite).toBe("lax");
      expect(cookie.options?.path).toBe("/");
      expect(cookie.options?.domain).toBeUndefined(); // __Host- must not have domain
      expect(cookie.options?.maxAge).toBe(7200);

      expect(setHeaders).toEqual(SSR_NO_CACHE_HEADERS);
    });

    test("createRequestCookieAdapter applies cookies and headers to Response", () => {
      const req = new Request("https://example.com/test", {
        headers: {
          cookie: "foo=bar; __Host-pb_auth=%7B%22token%22%3A%22xyz%22%7D",
        },
      });
      const adapter = createRequestCookieAdapter(req);

      const all = adapter.getAll();
      expect(all.length).toBe(2);
      expect(all.find((c) => c.name === "__Host-pb_auth")?.value).toBe('{"token":"xyz"}');

      adapter.setAll(
        [
          {
            name: "__Host-pb_auth",
            value: "updated",
            options: { path: "/", secure: true, httpOnly: true, sameSite: "lax" },
          },
        ],
        SSR_NO_CACHE_HEADERS,
      );

      const res = new Response("ok");
      adapter.applyToResponse(res);

      expect(res.headers.get("Cache-Control")).toBe(
        "private, no-cache, no-store, must-revalidate, max-age=0",
      );
      expect(res.headers.get("Expires")).toBe("0");
      expect(res.headers.get("Pragma")).toBe("no-cache");
      expect(res.headers.get("Set-Cookie")).toContain("__Host-pb_auth=updated;");
      expect(res.headers.get("Set-Cookie")).toContain("HttpOnly");
      expect(res.headers.get("Set-Cookie")).toContain("Secure");
    });
  });

  describe("Session Cache and Lifetime Learning", () => {
    test("learns collection token lifetime from auth response without iat claim", async () => {
      const cache = createSessionCache();
      let refreshCalls = 0;

      const nowSec = 1_000_000;
      // 5-day lifetime (432,000s), server-shaped token (no iat!)
      const token = dummyJWT({
        exp: nowSec + 432_000,
        id: "u1",
        collectionId: "col_default5d",
        type: "auth",
        refreshable: true,
      });

      const cookies: CookieAdapter = {
        getAll: () => [{ name: "pb_auth", value: JSON.stringify({ token }) }],
      };

      fetchMock.on({
        method: "POST",
        url: "http://localhost:8090/api/collections/col_default5d/auth-refresh",
        replyCode: 200,
        replyHeaders: { Date: new Date(nowSec * 1000).toUTCString() },
        replyBody: () => {
          refreshCalls++;
          return {
            token,
            record: {
              id: "u1",
              collectionId: "col_default5d",
              collectionName: "users",
              email: "u1@example.com",
            },
          };
        },
      });

      // Call 1: lifetime unknown -> must refresh once to learn it
      const client1 = await createServerClient({
        url: "http://localhost:8090",
        origin: "http://localhost:3000",
        cookies,
        sessionCache: cache,
        clock: () => nowSec * 1000,
      });
      expect(client1.authStore.record?.email).toBe("u1@example.com");
      expect(refreshCalls).toBe(1);

      // Lifetime was learned as 432,000s!
      expect(cache.getCollectionLifetime("col_default5d")).toBe(432_000);

      // Call 2: 50s later -> warm cache, fresh and well above half-life (remaining ~431,950s > 216,000s)
      const client2 = await createServerClient({
        url: "http://localhost:8090",
        origin: "http://localhost:3000",
        cookies,
        sessionCache: cache,
        clock: () => (nowSec + 50) * 1000,
      });
      expect(client2.authStore.record?.email).toBe("u1@example.com");
      expect(refreshCalls).toBe(1); // 0 extra calls!
    });

    test("collection with short duration refreshes when less than half lifetime remains", async () => {
      const cache = createSessionCache();
      let refreshCalls = 0;

      let currentTimeSec = 1_000_000;
      // Short duration collection: 600s lifetime
      const initialToken = dummyJWT({
        exp: currentTimeSec + 600,
        id: "u_short",
        collectionId: "col_short",
        type: "auth",
        refreshable: true,
      });

      const cookies: CookieAdapter = {
        getAll: () => [{ name: "pb_auth", value: JSON.stringify({ token: initialToken }) }],
      };

      fetchMock.on({
        method: "POST",
        url: "http://localhost:8090/api/collections/col_short/auth-refresh",
        replyCode: 200,
        replyHeaders: () => ({ Date: new Date(currentTimeSec * 1000).toUTCString() }),
        replyBody: () => {
          refreshCalls++;
          return {
            token: dummyJWT({
              exp: currentTimeSec + 600,
              id: "u_short",
              collectionId: "col_short",
              type: "auth",
              refreshable: true,
            }),
            record: { id: "u_short", collectionId: "col_short", collectionName: "temp_access" },
          };
        },
      });

      // Call 1: initial check learns 600s lifetime
      await createServerClient({
        url: "http://localhost:8090",
        origin: "http://localhost:3000",
        cookies,
        sessionCache: cache,
        clock: () => currentTimeSec * 1000,
      });
      expect(refreshCalls).toBe(1);
      expect(cache.getCollectionLifetime("col_short")).toBe(600);

      // Call 2: 100s later (remaining = 500s > 300s half-life) -> Cache hit
      currentTimeSec += 100;
      await createServerClient({
        url: "http://localhost:8090",
        origin: "http://localhost:3000",
        cookies,
        sessionCache: cache,
        clock: () => currentTimeSec * 1000,
      });
      expect(refreshCalls).toBe(1);

      // Call 3: 450s total passed (remaining = 150s < 300s half-life) -> Under half-life triggers refresh!
      currentTimeSec += 350;
      await createServerClient({
        url: "http://localhost:8090",
        origin: "http://localhost:3000",
        cookies,
        sessionCache: cache,
        clock: () => currentTimeSec * 1000,
      });
      expect(refreshCalls).toBe(2);
    });

    test("ttl option is honored by createSessionCache", async () => {
      let currentTime = 1_000_000_000; // ms
      // Custom TTL = 1000 ms (1 second)
      const cache = createSessionCache({ ttl: 1000, clock: () => currentTime });
      expect(cache.ttl).toBe(1000);
      let refreshCalls = 0;

      const nowSec = Math.floor(currentTime / 1000);
      const token = dummyJWT({
        exp: nowSec + 100_000,
        id: "u1",
        collectionId: "users",
        type: "auth",
        refreshable: true,
      });

      const cookies: CookieAdapter = {
        getAll: () => [{ name: "pb_auth", value: JSON.stringify({ token }) }],
      };

      fetchMock.on({
        method: "POST",
        url: "http://localhost:8090/api/collections/users/auth-refresh",
        replyCode: 200,
        replyHeaders: () => ({ Date: new Date(currentTime).toUTCString() }),
        replyBody: () => {
          refreshCalls++;
          return {
            token,
            record: { id: "u1", collectionName: "users" },
          };
        },
      });

      // Call 1: initial check at t=0
      await createServerClient({
        url: "http://localhost:8090",
        origin: "http://localhost:3000",
        cookies,
        sessionCache: cache,
        clock: () => currentTime,
      });
      expect(refreshCalls).toBe(1);

      // Call 2: at t=500ms (within ttl: 1000ms) -> Cache hit
      currentTime += 500;
      await createServerClient({
        url: "http://localhost:8090",
        origin: "http://localhost:3000",
        cookies,
        sessionCache: cache,
        clock: () => currentTime,
      });
      expect(refreshCalls).toBe(1);

      // Call 3: at t=1500ms (ttl expired) -> Refreshes!
      currentTime += 1000;
      await createServerClient({
        url: "http://localhost:8090",
        origin: "http://localhost:3000",
        cookies,
        sessionCache: cache,
        clock: () => currentTime,
      });
      expect(refreshCalls).toBe(2);
    });

    test("LRU eviction drops least recently used entry when maxEntries is exceeded", async () => {
      let clockTime = 1000;
      const cache = createSessionCache({
        maxEntries: 2,
        clock: () => clockTime,
      });
      expect(cache.maxEntries).toBe(2);

      const t1 = "token_one";
      const t2 = "token_two";
      const t3 = "token_three";

      const r1 = { id: "1" } as any;
      const r2 = { id: "2" } as any;
      const r3 = { id: "3" } as any;

      await cache.set(t1, r1);
      await cache.set(t2, r2);
      expect(cache.size).toBe(2);

      // Access t1 to make it most recently used
      const got1 = await cache.get(t1);
      expect(got1?.record?.id).toBe("1");

      // Adding t3 should evict t2 (since t1 was recently used)
      await cache.set(t3, r3);
      expect(cache.size).toBe(2);

      expect(await cache.get(t1)).toBeDefined();
      expect(await cache.get(t3)).toBeDefined();
      expect(await cache.get(t2)).toBeUndefined(); // t2 was evicted!
    });
  });

  describe("Single-flight Outcome Sharing", () => {
    test("10 parallel requests on revoked token all end signed out with cookie clears", async () => {
      const cache = createSessionCache();
      const token = dummyJWT({
        exp: 2_000_000,
        id: "u_revoked",
        collectionId: "users",
        type: "auth",
        refreshable: true,
      });

      fetchMock.on({
        method: "POST",
        url: "http://localhost:8090/api/collections/users/auth-refresh",
        delay: 50,
        replyCode: 401,
        replyBody: {
          code: 401,
          message: "The request requires valid record authorization token to be set.",
        },
      });

      const setCookiesCalls: CookieToSet[][] = [];
      const createTestClient = async () => {
        const clearedCookies: CookieToSet[] = [];
        setCookiesCalls.push(clearedCookies);
        const cookies: CookieAdapter = {
          getAll: () => [{ name: "pb_auth", value: JSON.stringify({ token }) }],
          setAll: (c) => {
            clearedCookies.push(...c);
          },
        };
        return createServerClient({
          url: "http://localhost:8090",
          origin: "http://localhost:3000",
          cookies,
          sessionCache: cache,
          clock: () => 1_000_000 * 1000,
        });
      };

      // Launch 10 parallel requests
      const clients = await Promise.all(Array.from({ length: 10 }, () => createTestClient()));

      // All 10 clients must be signed out
      for (const client of clients) {
        expect(client.authStore.isValid).toBe(false);
        expect(client.authStore.token).toBe("");
        expect(client.authStore.record).toBeNull();
      }

      // All 10 requests must have cleared the cookie
      for (const setCookies of setCookiesCalls) {
        expect(setCookies.length).toBeGreaterThan(0);
        expect(setCookies[0]!.value).toBe("");
        expect(setCookies[0]!.options?.maxAge).toBe(0);
      }
    });

    test("parallel normal load and verify() during 503: normal load keeps session, verify throws", async () => {
      const cache = createSessionCache();
      const token = dummyJWT({
        exp: 2_000_000,
        id: "u_transient",
        collectionId: "users",
        type: "auth",
        refreshable: true,
      });
      const initialRecord = { id: "u_transient", collectionName: "users", email: "t@example.com" };

      fetchMock.on({
        method: "POST",
        url: "http://localhost:8090/api/collections/users/auth-refresh",
        delay: 50,
        replyCode: 503,
        replyBody: { code: 503, message: "Service Unavailable" },
      });

      const cookiesNormal: CookieAdapter = {
        getAll: () => [
          { name: "pb_auth", value: JSON.stringify({ token, record: initialRecord }) },
        ],
      };
      const cookiesVerify: CookieAdapter = {
        getAll: () => [
          { name: "pb_auth", value: JSON.stringify({ token, record: initialRecord }) },
        ],
      };

      const normalClientPromise = createServerClient({
        url: "http://localhost:8090",
        origin: "http://localhost:3000",
        cookies: cookiesNormal,
        sessionCache: cache,
        clock: () => 1_000_000 * 1000,
      });

      const verifyClientPromise = (async () => {
        const client = await createServerClient({
          url: "http://localhost:8090",
          origin: "http://localhost:3000",
          cookies: cookiesVerify,
          sessionCache: cache,
          clock: () => 1_000_000 * 1000,
        });
        return client.auth.verify();
      })();

      const [normalClient, verifyResult] = await Promise.allSettled([
        normalClientPromise,
        verifyClientPromise,
      ]);

      // Normal client must succeed and keep session
      expect(normalClient.status).toBe("fulfilled");
      if (normalClient.status === "fulfilled") {
        expect(normalClient.value.authStore.token).toBe(token);
        expect(normalClient.value.authStore.record?.id).toBe("u_transient");
      }

      // verify() caller must reject with 503 error
      expect(verifyResult.status).toBe("rejected");
      if (verifyResult.status === "rejected") {
        const err = verifyResult.reason as ClientResponseError;
        expect(err instanceof ClientResponseError).toBe(true);
        expect(err.status).toBe(503);
      }
    });
  });

  describe("Server Sign-in and Sign-out", () => {
    test("authWithPassword writes cookie and updates session cache", async () => {
      const cache = createSessionCache();
      const setCookies: CookieToSet[] = [];
      let setHeaders: Record<string, string> | undefined;

      const cookies: CookieAdapter = {
        getAll: () => [],
        setAll: (c, h) => {
          setCookies.push(...c);
          setHeaders = h;
        },
      };

      const serverToken = dummyJWT({
        exp: 1_500_000,
        id: "signed_in_user",
        collectionId: "users",
        type: "auth",
        refreshable: true,
      });

      fetchMock.on({
        method: "POST",
        url: "http://localhost:8090/api/collections/users/auth-with-password",
        replyCode: 200,
        replyHeaders: { Date: new Date(1_000_000 * 1000).toUTCString() },
        replyBody: {
          token: serverToken,
          record: { id: "signed_in_user", collectionName: "users", email: "login@example.com" },
        },
      });

      const client = await createServerClient({
        url: "http://localhost:8090",
        origin: "https://my-app.example.com",
        cookies,
        sessionCache: cache,
        clock: () => 1_000_000 * 1000,
      });

      expect(setCookies.length).toBe(0); // Initially empty

      // Sign in on server
      await client.collection("users").authWithPassword("login@example.com", "pass123");

      // Cookie written through adapter
      expect(setCookies.length).toBeGreaterThan(0);
      const cookie = setCookies[setCookies.length - 1]!;
      expect(cookie.name).toBe("__Host-pb_auth");
      expect(cookie.options?.secure).toBe(true);
      expect(cookie.options?.httpOnly).toBe(true);
      expect(setHeaders).toEqual(SSR_NO_CACHE_HEADERS);

      // Session cache was updated
      const cached = await cache.get(serverToken);
      expect(cached?.record?.id).toBe("signed_in_user");
    });

    test("authStore.clear() clears cookie and evicts session cache", async () => {
      const cache = createSessionCache();
      const setCookies: CookieToSet[] = [];
      const token = dummyJWT({
        exp: 1_500_000,
        id: "user_to_logout",
        collectionId: "users",
        type: "auth",
        refreshable: true,
      });

      const cookies: CookieAdapter = {
        getAll: () => [
          {
            name: "__Host-pb_auth",
            value: JSON.stringify({ token, record: { id: "user_to_logout" } }),
          },
        ],
        setAll: (c) => {
          setCookies.push(...c);
        },
      };

      fetchMock.on({
        method: "POST",
        url: "http://localhost:8090/api/collections/users/auth-refresh",
        replyCode: 200,
        replyHeaders: { Date: new Date(1_000_000 * 1000).toUTCString() },
        replyBody: {
          token,
          record: { id: "user_to_logout", collectionName: "users" },
        },
      });

      const client = await createServerClient({
        url: "http://localhost:8090",
        origin: "https://my-app.example.com",
        cookies,
        sessionCache: cache,
        clock: () => 1_000_000 * 1000,
      });

      setCookies.length = 0; // Reset setCookies

      // Logout / clear
      client.authStore.clear();

      // Cookie cleared
      expect(setCookies.length).toBeGreaterThan(0);
      const cleared = setCookies[setCookies.length - 1]!;
      expect(cleared.value).toBe("");
      expect(cleared.options?.maxAge).toBe(0);

      // Evicted from session cache
      expect(await cache.get(token)).toBeUndefined();
    });

    test("401 from an ordinary data call does not log the user out", async () => {
      const cache = createSessionCache();
      const nowSec = Math.floor(Date.now() / 1000);
      const token = dummyJWT({
        exp: nowSec + 3600,
        id: "regular_user",
        collectionId: "users",
        type: "auth",
        refreshable: true,
      });

      const cookies: CookieAdapter = {
        getAll: () => [
          { name: "pb_auth", value: JSON.stringify({ token, record: { id: "regular_user" } }) },
        ],
      };

      fetchMock.on({
        method: "POST",
        url: "http://localhost:8090/api/collections/users/auth-refresh",
        replyCode: 200,
        replyHeaders: { Date: new Date(nowSec * 1000).toUTCString() },
        replyBody: {
          token,
          record: { id: "regular_user", collectionName: "users" },
        },
      });

      // Data call to superuser-only endpoint returns 401
      fetchMock.on({
        method: "GET",
        url: "http://localhost:8090/api/collections/_superusers/records",
        replyCode: 401,
        replyBody: { code: 401, message: "Only superusers can access this action." },
      });

      const client = await createServerClient({
        url: "http://localhost:8090",
        origin: "http://localhost:3000",
        cookies,
        sessionCache: cache,
        clock: () => nowSec * 1000,
      });

      expect(client.authStore.isValid).toBe(true);

      // Make data call that fails with 401
      let threw401 = false;
      try {
        await client.collection("_superusers").getFullList();
      } catch (err: any) {
        threw401 = true;
        expect(err.status).toBe(401);
      }
      expect(threw401).toBe(true);

      // User must still be signed in!
      expect(client.authStore.isValid).toBe(true);
      expect(client.authStore.token).toBe(token);
      expect(client.authStore.record?.id).toBe("regular_user");
    });
  });

  describe("Superuser client", () => {
    test("re-auth and impersonate", async () => {
      let superuserAuthCalls = 0;
      let superuserRefreshCalls = 0;
      let impersonateCalls = 0;
      let lastImpersonateBody: any = null;

      const suToken = dummyJWT({
        exp: Math.floor(Date.now() / 1000) + 200, // Expires in 200s (< 300s threshold)
        id: "su1",
        collectionId: "_superusers",
        type: "auth",
        refreshable: true,
      });

      fetchMock.on({
        method: "POST",
        url: "http://localhost:8090/api/collections/_superusers/auth-with-password",
        replyCode: 200,
        replyBody: () => {
          superuserAuthCalls++;
          return {
            token: suToken,
            record: { id: "su1", collectionName: "_superusers", email: "admin@example.com" },
          };
        },
      });

      fetchMock.on({
        method: "POST",
        url: "http://localhost:8090/api/collections/_superusers/auth-refresh",
        replyCode: 200,
        replyBody: () => {
          superuserRefreshCalls++;
          return {
            token: dummyJWT({
              exp: Math.floor(Date.now() / 1000) + 3600,
              id: "su1",
              collectionId: "_superusers",
              type: "auth",
              refreshable: true,
            }),
            record: { id: "su1", collectionName: "_superusers", email: "admin@example.com" },
          };
        },
      });

      fetchMock.on({
        method: "POST",
        url: "http://localhost:8090/api/collections/users/impersonate/user123",
        replyCode: 200,
        additionalMatcher: (_url, config) => {
          if (config?.body) {
            lastImpersonateBody =
              typeof config.body === "string" ? JSON.parse(config.body) : config.body;
          }
          return true;
        },
        replyBody: () => {
          impersonateCalls++;
          return {
            token: "impersonated_browser_token_abc",
            record: { id: "user123", collectionName: "users", email: "user@example.com" },
          };
        },
      });

      const superuser = await createSuperuserClient({
        url: "http://localhost:8090",
        email: "admin@example.com",
        password: "secretpassword",
        autoRefreshThreshold: 300,
      });

      expect(superuserAuthCalls).toBe(1);
      expect(superuser.authStore.token).toBe(suToken);

      // Default impersonation: duration should be 900 (15 min)
      const minted = await superuser.impersonate("users", "user123");
      expect(impersonateCalls).toBe(1);
      expect(lastImpersonateBody?.duration).toBe(900);
      expect(minted.token).toBe("impersonated_browser_token_abc");
      expect(minted.record.id).toBe("user123");

      // Custom duration impersonation: 600s
      await superuser.impersonate("users", "user123", 600);
      expect(impersonateCalls).toBe(2);
      expect(lastImpersonateBody?.duration).toBe(600);

      // Since suToken was within 300s of expiry, the impersonate call triggered auto-refresh!
      expect(superuserRefreshCalls).toBeGreaterThanOrEqual(1);
    });
  });
});
