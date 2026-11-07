// docs/design/13-ssr.md ("Clients", "Session cookie", "Session cache, check and refresh")
import { describe, expect, test, beforeAll, afterAll, afterEach } from "bun:test";
import { FetchMock, dummyJWT } from "@sdk-test/mocks";
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
    test("attributes on localhost", async () => {
      const now = 1_000_000;
      const exp = now + 3600;
      const token1 = dummyJWT({ exp, id: "u1", collectionId: "users" });
      const token2 = dummyJWT({ exp: exp + 3600, id: "u1", collectionId: "users" });

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
        url: "http://localhost:8090/api/collections/users/auth-refresh",
        replyCode: 200,
        replyBody: {
          token: token2,
          record: { id: "u1", collectionName: "users", email: "u1@example.com" },
        },
      });

      const client = await createServerClient({
        url: "http://localhost:8090",
        cookies,
        clock: () => now * 1000,
      });

      expect(client.authStore.token).toBe(token2);
      expect(setCookies.length).toBe(1);
      const cookie = setCookies[0]!;
      expect(cookie.name).toBe("pb_auth"); // No __Host- prefix on localhost
      expect(cookie.options?.secure).toBe(false);
      expect(cookie.options?.httpOnly).toBe(true);
      expect(cookie.options?.sameSite).toBe("lax");
      expect(cookie.options?.path).toBe("/");
      expect(cookie.options?.maxAge).toBe(7200);

      expect(setHeaders).toEqual(SSR_NO_CACHE_HEADERS);
    });

    test("attributes on https", async () => {
      const now = 1_000_000;
      const exp = now + 3600;
      const token1 = dummyJWT({ exp, id: "u2", collectionId: "users" });
      const token2 = dummyJWT({ exp: exp + 3600, id: "u2", collectionId: "users" });

      const setCookies: CookieToSet[] = [];
      let setHeaders: Record<string, string> | undefined;

      const cookies: CookieAdapter = {
        // Test reading prefixed name __Host-pb_auth
        getAll: () => [{ name: "__Host-pb_auth", value: JSON.stringify({ token: token1 }) }],
        setAll: (c, h) => {
          setCookies.push(...c);
          setHeaders = h;
        },
      };

      fetchMock.on({
        method: "POST",
        url: "https://example.com/api/collections/users/auth-refresh",
        replyCode: 200,
        replyBody: {
          token: token2,
          record: { id: "u2", collectionName: "users", email: "u2@example.com" },
        },
      });

      const client = await createServerClient({
        url: "https://example.com",
        cookies,
        clock: () => now * 1000,
      });

      expect(client.authStore.token).toBe(token2);
      expect(setCookies.length).toBe(1);
      const cookie = setCookies[0]!;
      expect(cookie.name).toBe("__Host-pb_auth"); // Prefixed on https
      expect(cookie.options?.secure).toBe(true);
      expect(cookie.options?.httpOnly).toBe(true);
      expect(cookie.options?.sameSite).toBe("lax");
      expect(cookie.options?.path).toBe("/");
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

  describe("Session Cache", () => {
    test("cache hit and miss", async () => {
      const cache = createSessionCache();
      let refreshCalls = 0;

      const now = 1_000_000;
      const token = dummyJWT({
        iat: now - 100,
        exp: now + 3000,
        id: "u1",
        collectionId: "users",
      });

      const cookies: CookieAdapter = {
        getAll: () => [{ name: "pb_auth", value: JSON.stringify({ token }) }],
      };

      fetchMock.on({
        method: "POST",
        url: "http://localhost:8090/api/collections/users/auth-refresh",
        replyCode: 200,
        replyBody: () => {
          refreshCalls++;
          return {
            token,
            record: { id: "u1", collectionName: "users", email: "u1@example.com" },
          };
        },
      });

      // First call -> Cache Miss -> calls auth-refresh once
      const client1 = await createServerClient({
        url: "http://localhost:8090",
        cookies,
        sessionCache: cache,
        clock: () => now * 1000,
      });
      expect(client1.authStore.record?.email).toBe("u1@example.com");
      expect(refreshCalls).toBe(1);

      // Second call -> Cache Hit -> 0 network calls!
      const client2 = await createServerClient({
        url: "http://localhost:8090",
        cookies,
        sessionCache: cache,
        clock: () => (now + 50) * 1000, // 50 seconds later, within TTL and half-life
      });
      expect(client2.authStore.record?.email).toBe("u1@example.com");
      expect(refreshCalls).toBe(1); // Still 1!
    });

    test("TTL expiration triggers refresh", async () => {
      let currentTime = 1_000_000_000; // ms
      const cache = createSessionCache({ clock: () => currentTime });
      let refreshCalls = 0;

      const nowSec = Math.floor(currentTime / 1000);
      const token = dummyJWT({
        iat: nowSec - 100,
        exp: nowSec + 100_000,
        id: "u1",
        collectionId: "users",
      });

      const cookies: CookieAdapter = {
        getAll: () => [{ name: "pb_auth", value: JSON.stringify({ token }) }],
      };

      fetchMock.on({
        method: "POST",
        url: "http://localhost:8090/api/collections/users/auth-refresh",
        replyCode: 200,
        replyBody: () => {
          refreshCalls++;
          return {
            token,
            record: { id: "u1", collectionName: "users" },
          };
        },
      });

      // Call 1: initial refresh
      await createServerClient({
        url: "http://localhost:8090",
        cookies,
        sessionCache: cache,
        clock: () => currentTime,
      });
      expect(refreshCalls).toBe(1);

      // Advance clock by 4 minutes (default TTL is 5 minutes)
      currentTime += 4 * 60 * 1000;
      await createServerClient({
        url: "http://localhost:8090",
        cookies,
        sessionCache: cache,
        clock: () => currentTime,
      });
      expect(refreshCalls).toBe(1); // Cached and fresh

      // Advance clock past 5 minutes (TTL expired)
      currentTime += 2 * 60 * 1000;
      await createServerClient({
        url: "http://localhost:8090",
        cookies,
        sessionCache: cache,
        clock: () => currentTime,
      });
      expect(refreshCalls).toBe(2); // Refreshed again!
    });

    test("LRU eviction drops least recently used entry", async () => {
      let clockTime = 1000;
      const cache = createSessionCache({
        maxEntries: 2,
        clock: () => clockTime,
      });

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

    test("half-life refresh", async () => {
      let currentTime = 1_000_000; // seconds
      const cache = createSessionCache({ clock: () => currentTime * 1000 });
      let refreshCalls = 0;

      // Lifetime = 1000s, iat = 999_500, exp = 1_000_500
      // At currentTime = 1_000_000, remaining is 500s which is exactly half.
      // At currentTime = 1_000_001, remaining is 499s which is < half (under half lifetime left).
      const token = dummyJWT({
        iat: 999_500,
        exp: 1_000_500,
        id: "u1",
        collectionId: "users",
      });

      const cookies: CookieAdapter = {
        getAll: () => [{ name: "pb_auth", value: JSON.stringify({ token }) }],
      };

      fetchMock.on({
        method: "POST",
        url: "http://localhost:8090/api/collections/users/auth-refresh",
        replyCode: 200,
        replyBody: () => {
          refreshCalls++;
          return {
            token,
            record: { id: "u1", collectionName: "users" },
          };
        },
      });

      // First check at currentTime = 999_700 (remaining = 800s > 500s half-life)
      currentTime = 999_700;
      await createServerClient({
        url: "http://localhost:8090",
        cookies,
        sessionCache: cache,
        clock: () => currentTime * 1000,
      });
      expect(refreshCalls).toBe(1);

      // Second check at currentTime = 999_800 (within TTL and remaining 700s > 500s)
      currentTime = 999_800;
      await createServerClient({
        url: "http://localhost:8090",
        cookies,
        sessionCache: cache,
        clock: () => currentTime * 1000,
      });
      expect(refreshCalls).toBe(1); // Cached

      // Third check at currentTime = 1_000_100 (remaining 400s < 500s half-life!)
      // Still within TTL (only 300s passed), but under half-life -> triggers refresh!
      currentTime = 1_000_100;
      await createServerClient({
        url: "http://localhost:8090",
        cookies,
        sessionCache: cache,
        clock: () => currentTime * 1000,
      });
      expect(refreshCalls).toBe(2);
    });

    test("single-flight (100 parallel calls -> one request)", async () => {
      const cache = createSessionCache();
      let refreshCalls = 0;

      const now = 1_000_000;
      const token = dummyJWT({
        iat: now - 100,
        exp: now + 5000,
        id: "u100",
        collectionId: "users",
      });

      const cookies: CookieAdapter = {
        getAll: () => [{ name: "pb_auth", value: JSON.stringify({ token }) }],
      };

      fetchMock.on({
        method: "POST",
        url: "http://localhost:8090/api/collections/users/auth-refresh",
        delay: 50, // simulated network latency
        replyCode: 200,
        replyBody: () => {
          refreshCalls++;
          return {
            token,
            record: { id: "u100", collectionName: "users", email: "user@example.com" },
          };
        },
      });

      // Fire 100 parallel createServerClient calls
      const promises: Promise<any>[] = [];
      for (let i = 0; i < 100; i++) {
        promises.push(
          createServerClient({
            url: "http://localhost:8090",
            cookies,
            sessionCache: cache,
            clock: () => now * 1000,
          }),
        );
      }

      const clients = await Promise.all(promises);

      // Exactly ONE request made to the server!
      expect(refreshCalls).toBe(1);
      for (const client of clients) {
        expect(client.authStore.record?.email).toBe("user@example.com");
      }
    });

    test("401 clears cookie, cache and auth store", async () => {
      const cache = createSessionCache();
      const clearedCookies: CookieToSet[] = [];

      const token = dummyJWT({
        iat: 100,
        exp: 2000,
        id: "u_revoked",
        collectionId: "users",
      });

      const cookies: CookieAdapter = {
        getAll: () => [{ name: "pb_auth", value: JSON.stringify({ token }) }],
        setAll: (c) => {
          clearedCookies.push(...c);
        },
      };

      fetchMock.on({
        method: "POST",
        url: "http://localhost:8090/api/collections/users/auth-refresh",
        replyCode: 401,
        replyBody: {
          code: 401,
          message: "The request requires valid record authorization token to be set.",
        },
      });

      const client = await createServerClient({
        url: "http://localhost:8090",
        cookies,
        sessionCache: cache,
        clock: () => 500 * 1000,
      });

      // authStore is cleared
      expect(client.authStore.token).toBe("");
      expect(client.authStore.record).toBeNull();

      // Cookie is cleared
      expect(clearedCookies.length).toBe(1);
      expect(clearedCookies[0]!.value).toBe("");
      expect(clearedCookies[0]!.options?.maxAge).toBe(0);

      // Cache is cleared
      expect(await cache.get(token)).toBeUndefined();
    });

    test("503 keeps session and does not touch cookie", async () => {
      const cache = createSessionCache();
      const setCookies: CookieToSet[] = [];

      const token = dummyJWT({
        iat: 100,
        exp: 2000,
        id: "u_transient",
        collectionId: "users",
      });

      const initialRecord = { id: "u_transient", collectionName: "users", email: "t@example.com" };

      const cookies: CookieAdapter = {
        getAll: () => [
          {
            name: "pb_auth",
            value: JSON.stringify({ token, record: initialRecord }),
          },
        ],
        setAll: (c) => {
          setCookies.push(...c);
        },
      };

      fetchMock.on({
        method: "POST",
        url: "http://localhost:8090/api/collections/users/auth-refresh",
        replyCode: 503,
        replyBody: {
          code: 503,
          message: "Service Unavailable",
        },
      });

      const client = await createServerClient({
        url: "http://localhost:8090",
        cookies,
        sessionCache: cache,
        clock: () => 500 * 1000,
      });

      // Session remains intact!
      expect(client.authStore.token).toBe(token);
      expect(client.authStore.record?.id).toBe("u_transient");

      // Cookie is NOT touched (no clear sent)
      expect(setCookies.length).toBe(0);
    });

    test("clock-skew correction", async () => {
      // Local machine time is 1,000,000s, but server time is 1,001,000s (1,000s ahead)
      let localTimeSec = 1_000_000;
      const serverDateStr = new Date(1_001_000 * 1000).toUTCString();

      const token = dummyJWT({
        iat: 900_000,
        exp: 1_000_030, // Expires at 1,000,030. According to server time (1,001,000), it's expired!
        id: "u_skew",
        collectionId: "users",
      });

      const cookies: CookieAdapter = {
        getAll: () => [{ name: "pb_auth", value: JSON.stringify({ token }) }],
      };

      const client = await createServerClient({
        url: "http://localhost:8090",
        cookies,
        clock: () => localTimeSec * 1000,
      });

      // Simulate a response with Date header from the server
      (client as any).afterSend(
        new Response(JSON.stringify({}), {
          headers: { Date: serverDateStr },
        }),
        {},
      );

      // Now verifyAuth will see the corrected clock skew and recognize the token is expired!
      let rejected = false;
      try {
        await client.auth.verify();
      } catch (err: any) {
        rejected = true;
        expect(err.status).toBe(401);
      }
      expect(rejected).toBe(true);
    });
  });

  describe("Superuser client", () => {
    test("re-auth and impersonate", async () => {
      let superuserAuthCalls = 0;
      let impersonateCalls = 0;
      const suToken = dummyJWT({
        exp: Math.floor(Date.now() / 1000) + 3600,
        id: "su1",
        collectionId: "_superusers",
        type: "auth",
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
        url: "http://localhost:8090/api/collections/users/impersonate/user123",
        replyCode: 200,
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

      // Mint browser token with default 15 min duration
      const minted = await superuser.mintBrowserToken("users", "user123");
      expect(impersonateCalls).toBe(1);
      expect(minted.token).toBe("impersonated_browser_token_abc");
      expect(minted.record.id).toBe("user123");

      // Also via mintUserToken with a record model
      const minted2 = await superuser.mintUserToken({
        id: "user123",
        collectionName: "users",
      } as any);
      expect(impersonateCalls).toBe(2);
      expect(minted2.token).toBe("impersonated_browser_token_abc");
    });
  });
});
