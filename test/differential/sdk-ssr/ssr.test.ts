// docs/design/13-ssr.md ("Clients", "Session cookie", "Session cache, check and refresh", "Browser client and realtime")
// Differential tests against both upstream PocketBase v0.41.0 and iglo.base.

import { describe, expect } from "bun:test";
import {
  createServerClient,
  createSuperuserClient,
  createSessionCache,
  DEFAULT_TTL_MS,
  type CookieToSet,
} from "iglo.base/ssr";
import { password, sdkTest, superuserToken } from "@test/differential/sdk/harness";
import { setMFA } from "@test/scenarios/record-auth-prepare";
import { ClientResponseError } from "@sdk/ClientResponseError";

const noMFA = ({ dataDir }: { dataDir: string }) => setMFA("users", false, "")({ dataDir });

describe("SSR differential", () => {
  sdkTest(
    "two users, 200 parallel requests each through createServerClient, warm cache 0 check requests",
    { prepare: noMFA },
    async (env) => {
      const admin = env.superuser();

      // Create two distinct users
      const userA = await env.step("create userA", () =>
        admin.collection("users").create({
          email: "user_a@example.com",
          password: password,
          passwordConfirm: password,
          name: "User A",
        }),
      );

      const userB = await env.step("create userB", () =>
        admin.collection("users").create({
          email: "user_b@example.com",
          password: password,
          passwordConfirm: password,
          name: "User B",
        }),
      );

      // Authenticate each user to obtain real tokens
      const clientA = env.client();
      const authA = await env.step("auth userA", () =>
        clientA.collection("users").authWithPassword("user_a@example.com", password),
      );

      const clientB = env.client();
      const authB = await env.step("auth userB", () =>
        clientB.collection("users").authWithPassword("user_b@example.com", password),
      );

      const cookieA = [
        {
          name: "pb_auth",
          value: JSON.stringify({ token: authA.token, record: authA.record }),
        },
      ];
      const cookieB = [
        {
          name: "pb_auth",
          value: JSON.stringify({ token: authB.token, record: authB.record }),
        },
      ];

      let mockClock = 1_000_000_000;
      const sessionCache = createSessionCache({ clock: () => mockClock });

      // Warm the cache for both users
      await createServerClient({
        url: env.url,
        cookies: { getAll: () => cookieA },
        sessionCache,
        clock: () => mockClock,
      });

      await createServerClient({
        url: env.url,
        cookies: { getAll: () => cookieB },
        sessionCache,
        clock: () => mockClock,
      });

      // Count requests reaching the server
      let sessionCheckRequests = 0;
      let dataRequests = 0;

      const countingFetch = async (
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        const urlStr = String(input instanceof Request ? input.url : input);
        if (urlStr.includes("/auth-refresh")) {
          sessionCheckRequests++;
        } else {
          dataRequests++;
        }
        return fetch(input, init);
      };

      // 200 parallel requests for user A and 200 for user B (400 total)
      const tasksA = Array.from({ length: 200 }, async () => {
        const pb = await createServerClient({
          url: env.url,
          cookies: { getAll: () => cookieA },
          sessionCache,
          clock: () => mockClock,
          fetch: countingFetch,
        });
        return pb.collection("users").getOne(userA.id);
      });

      const tasksB = Array.from({ length: 200 }, async () => {
        const pb = await createServerClient({
          url: env.url,
          cookies: { getAll: () => cookieB },
          sessionCache,
          clock: () => mockClock,
          fetch: countingFetch,
        });
        return pb.collection("users").getOne(userB.id);
      });

      const [resA, resB] = await Promise.all([Promise.all(tasksA), Promise.all(tasksB)]);

      // With warm cache: 0 session check requests reached the server
      expect(sessionCheckRequests).toBe(0);
      expect(dataRequests).toBe(400);

      // Verify data isolation: every response shows only its own user's data
      for (const record of resA) {
        expect(record.id).toBe(userA.id);
        expect(record.email).toBe("user_a@example.com");
      }
      for (const record of resB) {
        expect(record.id).toBe(userB.id);
        expect(record.email).toBe("user_b@example.com");
      }

      env.record("results.count", {
        countA: resA.length,
        countB: resB.length,
        sessionCheckRequests,
        dataRequests,
      });
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

      let mockClock = 1_000_000_000;
      const sessionCache = createSessionCache({ clock: () => mockClock });

      const cookieVal = [
        {
          name: "pb_auth",
          value: JSON.stringify({ token: auth.token, record: auth.record }),
        },
      ];

      // Warm the session cache
      await createServerClient({
        url: env.url,
        cookies: { getAll: () => cookieVal },
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
        const resErr = err as { constructor?: { name?: string }; status?: number } | null;
        if (
          err instanceof ClientResponseError ||
          resErr?.constructor?.name === "ClientResponseError" ||
          resErr?.status === 404
        ) {
          dataCallRejected = true;
        }
      }
      expect(dataCallRejected).toBe(true);

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

      const minted = await env.step("mint browser token", () =>
        superuser.mintBrowserToken("users", user.id, 900),
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
