// docs/design/13-ssr.md ("Clients", "Session cookie", "Session cache, check and refresh", "Browser client and realtime")
// Differential tests against both upstream PocketBase v0.41.0 and iglo.base.

import { describe, expect } from "bun:test";
import { join } from "node:path";
import {
  createServerClient,
  createSuperuserClient,
  createSessionCache,
  DEFAULT_TTL_MS,
  type Cookie,
  type CookieAdapter,
  type CookieToSet,
} from "iglo.base/ssr";
import { password, sdkTest, superuserToken } from "@test/differential/sdk/harness";
import { setMFA } from "@test/scenarios/record-auth-prepare";
import { ClientResponseError } from "iglo.base";

const noMFA = ({ dataDir }: { dataDir: string }) => setMFA("users", false, "")({ dataDir });

const countingProxyPath = join(import.meta.dir, "counting-proxy.ts");

/** Starts counting-proxy.ts in its own process in front of `targetUrl`. */
async function startCountingProxy(targetUrl: string) {
  const child = Bun.spawn([process.execPath, countingProxyPath, targetUrl], {
    stdout: "pipe",
    stderr: "inherit",
  });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (!output.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) {
      throw new Error("counting proxy exited before it started");
    }
    output += decoder.decode(value);
  }
  const { port } = JSON.parse(output.split("\n")[0] ?? "") as { port: number };
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    reset: async (): Promise<void> => {
      await fetch(`${url}/__reset`);
    },
    counts: async (): Promise<{ sessionChecks: number; dataRequests: number }> => {
      const body = (await (await fetch(`${url}/__counts`)).json()) as {
        sessionChecks: number;
        dataRequests: number;
      };
      return body;
    },
    stop: (): void => {
      child.kill();
    },
  };
}

describe("SSR differential", () => {
  sdkTest(
    "two users, 200 parallel requests each through createServerClient, warm cache 0 check requests",
    { prepare: noMFA },
    async (env) => {
      // Authenticate two distinct fixture users
      const authA = await env.derived(
        "auth userA",
        () => env.client().collection("users").authWithPassword("test@example.com", password),
        (res) => ({ email: res.record.email }),
      );

      const authB = await env.derived(
        "auth userB",
        () => env.client().collection("users").authWithPassword("test2@example.com", password),
        (res) => ({ email: res.record.email }),
      );

      let cookieJarA: Cookie[] = [
        {
          name: "pb_auth",
          value: JSON.stringify({ token: authA.token, record: authA.record }),
        },
      ];
      let cookieJarB: Cookie[] = [
        {
          name: "pb_auth",
          value: JSON.stringify({ token: authB.token, record: authB.record }),
        },
      ];

      const cookiesA: CookieAdapter = {
        getAll: () => cookieJarA,
        setAll: (c: CookieToSet[]) => {
          cookieJarA = c.map((item: CookieToSet) => ({ name: item.name, value: item.value }));
        },
      };
      const cookiesB: CookieAdapter = {
        getAll: () => cookieJarB,
        setAll: (c: CookieToSet[]) => {
          cookieJarB = c.map((item: CookieToSet) => ({ name: item.name, value: item.value }));
        },
      };

      // Near real-time clock (not 1970) so half-life calculations match real server token exp
      let mockClock = Date.now();
      const sessionCache = createSessionCache({ clock: () => mockClock });

      // Requests are counted at the server boundary by a proxy in its own process
      const proxy = await startCountingProxy(env.url);
      const proxyBaseUrl = proxy.url;

      try {
        // Initial request learns the collection lifetime from server response
        await createServerClient({
          url: proxyBaseUrl,
          origin: "http://localhost:3000",
          cookies: cookiesA,
          sessionCache,
          clock: () => mockClock,
        });

        await createServerClient({
          url: proxyBaseUrl,
          origin: "http://localhost:3000",
          cookies: cookiesB,
          sessionCache,
          clock: () => mockClock,
        });

        // Reset server-side request counters before testing warm cache
        await proxy.reset();

        // 200 parallel requests for user A and 200 for user B (400 total)
        // Requests use plain createServerClient without any custom fetch
        const tasksA = Array.from({ length: 200 }, async () => {
          const pb = await createServerClient({
            url: proxyBaseUrl,
            origin: "http://localhost:3000",
            cookies: cookiesA,
            sessionCache,
            clock: () => mockClock,
          });
          return pb.collection("users").getOne(authA.record.id);
        });

        const tasksB = Array.from({ length: 200 }, async () => {
          const pb = await createServerClient({
            url: proxyBaseUrl,
            origin: "http://localhost:3000",
            cookies: cookiesB,
            sessionCache,
            clock: () => mockClock,
          });
          return pb.collection("users").getOne(authB.record.id);
        });

        const [resA, resB] = await Promise.all([Promise.all(tasksA), Promise.all(tasksB)]);

        // With warm cache: 0 session check requests reached the server, counted by proxy in front of server
        const { sessionChecks: sessionCheckRequests, dataRequests } = await proxy.counts();
        expect(sessionCheckRequests).toBe(0);
        expect(dataRequests).toBe(400);

        // Verify data isolation: every response shows only its own user's data
        for (const record of resA) {
          expect(record.id).toBe(authA.record.id);
          expect(record.email).toBe("test@example.com");
        }
        for (const record of resB) {
          expect(record.id).toBe(authB.record.id);
          expect(record.email).toBe("test2@example.com");
        }

        env.record("results.count", {
          countA: resA.length,
          countB: resB.length,
          sessionCheckRequests,
          dataRequests,
        });
      } finally {
        proxy.stop();
      }
    },
  );

  sdkTest(
    "token revoked by password change is rejected on next data call and cleared after cache TTL",
    { prepare: noMFA },
    async (env) => {
      const admin = env.superuser();

      const user = await env.step("create user", () =>
        admin.collection("users").create({
          email: "revoke_test@example.com",
          password: password,
          passwordConfirm: password,
        }),
      );

      const client = env.client();
      const auth = await env.step("auth user", () =>
        client.collection("users").authWithPassword("revoke_test@example.com", password),
      );

      let mockClock = Date.now();
      const sessionCache = createSessionCache({ clock: () => mockClock });

      // The browser's cookie jar. The warm-up refresh issues a new token and its cookie write
      // must reach the next request, as it would in a browser; the next client reads the jar.
      let cookieVal: Cookie[] = [
        {
          name: "pb_auth",
          value: JSON.stringify({ token: auth.token, record: auth.record }),
        },
      ];

      // Warm the session cache
      await createServerClient({
        url: env.url,
        origin: "http://localhost:3000",
        cookies: {
          getAll: () => cookieVal,
          setAll: (c: CookieToSet[]) => {
            cookieVal = c.map((item: CookieToSet) => ({ name: item.name, value: item.value }));
          },
        },
        sessionCache,
        clock: () => mockClock,
      });

      // Revoke the token by changing password on the server
      await env.step("revoke token via password update", () =>
        admin.collection("users").update(user.id, {
          password: "newpassword12345",
          passwordConfirm: "newpassword12345",
        }),
      );

      // 1. Next data call: session is cached, but server rejects token on data call
      const clearedCookiesDataCall: CookieToSet[] = [];
      const pbData = await createServerClient({
        url: env.url,
        origin: "http://localhost:3000",
        cookies: {
          getAll: () => cookieVal,
          setAll: (c) => {
            clearedCookiesDataCall.push(...c);
          },
        },
        sessionCache,
        clock: () => mockClock,
      });

      let dataCallRejected = false;
      try {
        await pbData.collection("users").getOne(user.id);
      } catch (err: unknown) {
        if (err instanceof ClientResponseError && (err.status === 404 || err.status === 401)) {
          dataCallRejected = true;
        }
      }
      expect(dataCallRejected).toBe(true);

      // An ordinary data call 401/404 does not clear the session or cookie
      expect(clearedCookiesDataCall.length).toBe(0);
      expect(pbData.authStore.isValid).toBe(true);

      // 2. Fresh login, then revoke and check after cache TTL
      const freshAuth = await env.step("auth fresh", () =>
        client.collection("users").authWithPassword("revoke_test@example.com", "newpassword12345"),
      );

      const freshCookie = [
        {
          name: "pb_auth",
          value: JSON.stringify({ token: freshAuth.token, record: freshAuth.record }),
        },
      ];

      await sessionCache.set(freshAuth.token, freshAuth.record, mockClock);

      // Revoke fresh token via another password change
      await env.step("revoke fresh token", () =>
        admin.collection("users").update(user.id, {
          password: "anotherpassword999",
          passwordConfirm: "anotherpassword999",
        }),
      );

      // Advance injected clock past cache TTL (default TTL is 5 minutes = 300_000 ms)
      mockClock += DEFAULT_TTL_MS + 10_000;

      const clearedCookiesTTL: CookieToSet[] = [];
      const pbTTL = await createServerClient({
        url: env.url,
        origin: "http://localhost:3000",
        cookies: {
          getAll: () => freshCookie,
          setAll: (c) => {
            clearedCookiesTTL.push(...c);
          },
        },
        sessionCache,
        clock: () => mockClock,
      });

      // Cache TTL expired -> session check called server -> server returned 401 -> cleared!
      expect(pbTTL.authStore.isValid).toBe(false);
      expect(pbTTL.authStore.token).toBe("");
      expect(clearedCookiesTTL.length).toBeGreaterThan(0);
      expect(clearedCookiesTTL[0]!.value).toBe("");
      expect(clearedCookiesTTL[0]!.options?.maxAge).toBe(0);
      expect(await sessionCache.get(freshAuth.token)).toBeUndefined();

      env.record("revocation.verified", {
        dataCallRejected,
        ttlCleared: clearedCookiesTTL.length > 0,
      });
    },
  );

  sdkTest(
    "impersonate tokens from superuser client work for realtime subscribe",
    {},
    async (env) => {
      const admin = env.superuser();

      const user = await env.step("create user for impersonate", () =>
        admin.collection("users").create({
          email: "impersonate_realtime@example.com",
          password: password,
          passwordConfirm: password,
        }),
      );

      const superuser = await createSuperuserClient({
        url: env.url,
        token: superuserToken,
      });

      const minted = await env.step("impersonate browser token", () =>
        superuser.impersonate("users", user.id, 900),
      );

      expect(minted.token).toBeDefined();
      expect(minted.record.id).toBe(user.id);

      // Connect realtime subscriber using the minted browser token
      const realtimeClient = env.client();
      realtimeClient.authStore.save(minted.token, minted.record);

      const events: unknown[] = [];
      const unsub = await env.step("subscribe demo2 with impersonated token", () =>
        realtimeClient.collection("demo2").subscribe("*", (e) => events.push(e)),
      );

      env.record("realtime.isConnected", realtimeClient.realtime.isConnected);

      await env.step("create demo2 record", () =>
        admin.collection("demo2").create({
          id: "ssrimpers000001",
          title: "impersonate realtime test",
        }),
      );

      await env.until(() => events.length >= 1, "realtime event received");
      expect(events.length).toBe(1);

      await env.step("unsubscribe", () => unsub());

      env.record("realtime.eventsCount", events.length);
    },
  );
});
