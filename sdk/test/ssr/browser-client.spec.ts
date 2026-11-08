// docs/design/13-ssr.md ("Browser client and realtime", "OAuth2": popup flow). The browser client
// with an injected clock and fake timers: nothing sleeps. Realtime runs against a fake
// EventSource, so a renewal's resubmission is visible as a request.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import Client from "@sdk/Client";
import { ClientResponseError } from "@sdk/ClientResponseError";
import { createBrowserClient, type CreateBrowserClientOptions } from "@sdk/ssr/browser-client";
import type { FetchFunction } from "@sdk/ssr/no-store-fetch";
import { BaseAuthStore } from "@sdk/stores/BaseAuthStore";
import type { Loose } from "@sdk/tools/loose";
import type { SendOptions } from "@sdk/tools/options";
import {
  API,
  APP,
  authToken,
  fakeTimers,
  json,
  record,
  settle,
  stubApi,
  testClock,
  type Call,
  type Handler,
  type TestClock,
} from "@sdk-test/ssr/browser-support";

const T0 = Math.floor(Date.now() / 1000);
const START = T0 * 1000;
const RENEW = "POST /api/session/renew";
const HAND_OFF = "POST /api/session/hand-off";
const RENEW_URL = `${APP}/api/session/renew`;
const HAND_OFF_URL = `${APP}/api/session/hand-off`;

/** The renew route's answer: a token that lives `lifetimeSec` from the clock's now. */
function renewed(clock: TestClock, lifetimeSec = 900): Handler {
  return () => {
    const exp = Math.floor(clock() / 1000) + lifetimeSec;
    return json(clock, 200, {
      token: authToken(exp, "u1"),
      record: record(),
      expiresAt: exp * 1000,
    });
  };
}

/**
 * The renew route on a server whose clock is `aheadMs` behind the device's: its answer carries
 * the server's time, and a token that lives `lifetimeSec` from it.
 */
function renewedFromServer(clock: TestClock, aheadMs: number, lifetimeSec = 900): Handler {
  return () => {
    const serverMs = clock() - aheadMs;
    const exp = Math.floor(serverMs / 1000) + lifetimeSec;
    return json(clock, 200, {
      token: authToken(exp, "u1"),
      record: record(),
      expiresAt: exp * 1000,
      serverTime: serverMs,
    });
  };
}

/** Upstream's largest setTimeout delay (2^31 - 1 ms). */
const MAX_TIMER_MS = 2 ** 31 - 1;

function failing(clock: TestClock, status: number): Handler {
  return () => json(clock, status, { status, message: "failed", data: {} });
}

interface Harness {
  clock: TestClock;
  ft: ReturnType<typeof fakeTimers>;
  api: ReturnType<typeof stubApi>;
  pb: ReturnType<typeof createBrowserClient>;
  token: string;
}

/**
 * A browser client on a stub iglo.base. `routes` may use the clock; `options` add to the
 * client's options. The token lives 900 seconds unless given.
 */
function harness(
  routes: (clock: TestClock) => Record<string, Handler> = (c) => ({ [RENEW]: renewed(c) }),
  options: Partial<CreateBrowserClientOptions> & { token?: string } = {},
): Harness {
  const clock = testClock(START);
  const ft = fakeTimers(clock);
  const api = stubApi(clock, routes(clock));
  const token = options.token ?? authToken(Math.floor(START / 1000) + 900, "u1");
  const pb = createBrowserClient({
    url: API,
    renewUrl: RENEW_URL,
    clock,
    timers: ft.timers,
    fetch: api.fetch,
    ...options,
    token,
    record: options.record ?? record(),
  });
  return { clock, ft, api, pb, token };
}

function callsTo(calls: Call[], method: string, path: string): Call[] {
  return calls.filter((c) => c.method === method && c.path === path);
}

describe("createBrowserClient", () => {
  let savedDocument: unknown;
  let savedLocation: unknown;
  let savedEventSource: unknown;
  beforeEach(() => {
    savedDocument = globalThis.document;
    savedLocation = globalThis.location;
    savedEventSource = globalThis.EventSource;
  });
  afterEach(() => {
    setGlobal("document", savedDocument);
    setGlobal("location", savedLocation);
    setGlobal("EventSource", savedEventSource);
  });

  test("returns a normal SDK Client, seeded from the handed-over token and record", () => {
    const { pb, token } = harness();
    expect(pb).toBeInstanceOf(Client);
    expect(pb.authStore.token).toBe(token);
    expect(pb.authStore.record?.id).toBe("u1");
  });

  test("renews at half the remaining lifetime, then again for the new token", async () => {
    const { clock, ft, api, pb, token } = harness();
    expect(ft.delays()).toEqual([450_000]);

    await ft.advance(449_999);
    expect(callsTo(api.calls, "POST", "/api/session/renew")).toHaveLength(0);

    await ft.advance(1);
    expect(callsTo(api.calls, "POST", "/api/session/renew")).toHaveLength(1);
    expect(pb.authStore.token).not.toBe(token);
    expect(clock()).toBe(START + 450_000);
    expect(ft.delays()).toEqual([450_000]);
  });

  test("a short token renews at least 60 seconds before it expires", () => {
    const { ft } = harness(undefined, { token: authToken(Math.floor(START / 1000) + 100, "u1") });
    expect(ft.delays()).toEqual([40_000]);
  });

  test("a token with less than a minute left renews at once", () => {
    const { ft } = harness(undefined, { token: authToken(Math.floor(START / 1000) + 30, "u1") });
    expect(ft.delays()).toEqual([0]);
  });

  test("a token lasting three years waits in steps no longer than setTimeout allows", async () => {
    // 94670856 s is upstream's largest auth token duration; its half-life is over 24.8 days
    const { ft, api, clock } = harness(undefined, {
      token: authToken(Math.floor(START / 1000) + 94_670_856, "u1"),
    });
    expect(ft.delays()).toEqual([MAX_TIMER_MS]);
    const halfLife = 94_670_856 * 500;

    await ft.advance(MAX_TIMER_MS);
    expect(callsTo(api.calls, "POST", "/api/session/renew")).toHaveLength(0);
    expect(ft.delays().every((d) => d <= MAX_TIMER_MS)).toBe(true);

    await ft.advance(halfLife - MAX_TIMER_MS - 1);
    expect(callsTo(api.calls, "POST", "/api/session/renew")).toHaveLength(0);
    await ft.advance(1);
    expect(callsTo(api.calls, "POST", "/api/session/renew")).toHaveLength(1);
    expect(clock()).toBe(START + halfLife);
  });

  test("a device clock 20 minutes fast does not make a new token look expired", async () => {
    const aheadMs = 20 * 60_000;
    const clock = testClock(START + aheadMs);
    const ft = fakeTimers(clock);
    const api = stubApi(clock, { [RENEW]: renewedFromServer(clock, aheadMs) });
    const pb = createBrowserClient({
      url: API,
      renewUrl: RENEW_URL,
      clock,
      timers: ft.timers,
      fetch: api.fetch,
      token: authToken(Math.floor(START / 1000) + 900, "u1"),
      record: record(),
      // the server's clock at minting: the device is 20 minutes ahead of it
      serverTime: START,
    });
    expect(ft.delays()).toEqual([450_000]);

    await ft.advance(449_999);
    expect(callsTo(api.calls, "POST", "/api/session/renew")).toHaveLength(0);
    await ft.advance(1);
    expect(callsTo(api.calls, "POST", "/api/session/renew")).toHaveLength(1);
    expect(pb.authStore.isValid).toBe(true);
    expect(ft.delays()).toEqual([450_000]);
    pb.dispose();
  });

  test("without serverTime, a fast clock renews once, then learns the server's time from the answer", async () => {
    const aheadMs = 20 * 60_000;
    const clock = testClock(START + aheadMs);
    const ft = fakeTimers(clock);
    const api = stubApi(clock, { [RENEW]: renewedFromServer(clock, aheadMs) });
    const pb = createBrowserClient({
      url: API,
      renewUrl: RENEW_URL,
      clock,
      timers: ft.timers,
      fetch: api.fetch,
      token: authToken(Math.floor(START / 1000) + 900, "u1"),
      record: record(),
    });
    // nothing is known yet: the token looks expired, so it renews at once
    expect(ft.delays()).toEqual([0]);
    await ft.advance(0);
    expect(callsTo(api.calls, "POST", "/api/session/renew")).toHaveLength(1);

    // the answer taught the offset: the next renewal is at half the real lifetime
    expect(ft.delays()).toEqual([450_000]);
    await ft.advance(449_999);
    expect(callsTo(api.calls, "POST", "/api/session/renew")).toHaveLength(1);
    pb.dispose();
  });

  test("successful renewals are at least 30 seconds apart, even for a token that lives under a minute", async () => {
    const renewedAt: number[] = [];
    const { ft, api, clock, pb } = harness(
      (c) => ({
        [RENEW]: (call) => {
          renewedAt.push(c());
          return renewed(c, 45)(call);
        },
      }),
      { token: authToken(Math.floor(START / 1000) + 45, "u1") },
    );

    await ft.advance(5 * 60_000);
    expect(callsTo(api.calls, "POST", "/api/session/renew").length).toBeGreaterThan(1);
    expect(callsTo(api.calls, "POST", "/api/session/renew").length).toBeLessThanOrEqual(11);
    for (let i = 1; i < renewedAt.length; i++) {
      expect(renewedAt[i]! - renewedAt[i - 1]!).toBeGreaterThanOrEqual(30_000);
    }
    expect(clock()).toBe(START + 5 * 60_000);
    pb.dispose();
  });

  test("retries are bounded: after ten, the store is cleared at expiry, not before", async () => {
    const { ft, api, pb, clock } = harness((c) => ({ [RENEW]: failing(c, 503) }));
    const expiresAt = START + 900_000;

    // the first renewal at half life, then the ten retries (1 s doubling to 30 s): 181 s
    await ft.advance(450_000 + 181_000);
    expect(callsTo(api.calls, "POST", "/api/session/renew")).toHaveLength(11);
    expect(pb.authStore.token).not.toBe("");

    await ft.advance(100_000);
    expect(callsTo(api.calls, "POST", "/api/session/renew")).toHaveLength(11);
    expect(pb.authStore.token).not.toBe("");

    await ft.advance(expiresAt - clock());
    expect(pb.authStore.token).toBe("");
    expect(callsTo(api.calls, "POST", "/api/session/renew")).toHaveLength(11);
  });

  test("parallel renew() calls share one request", async () => {
    const { api, pb } = harness();
    await Promise.all([pb.renew(), pb.renew(), pb.renew()]);
    expect(callsTo(api.calls, "POST", "/api/session/renew")).toHaveLength(1);
  });

  test("the renewal request is a POST that carries no Authorization header", async () => {
    const { api, pb } = harness();
    await pb.renew();
    const [call] = callsTo(api.calls, "POST", "/api/session/renew");
    expect(call?.headers.get("authorization")).toBeNull();
  });

  test("a 401 from the renew route clears the auth store and stops the timers", async () => {
    const { ft, pb, api } = harness((c) => ({ [RENEW]: failing(c, 401) }));
    const error = await pb.renew().then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(ClientResponseError);
    expect((error as ClientResponseError).status).toBe(401);
    expect(pb.authStore.token).toBe("");
    expect(ft.count).toBe(0);
    expect(callsTo(api.calls, "POST", "/api/session/renew")).toHaveLength(1);
  });

  test("a 5xx keeps the token and retries with backoff until it succeeds", async () => {
    let attempts = 0;
    const { ft, pb, token, api } = harness((c) => ({
      [RENEW]: (call) => {
        attempts++;
        return attempts === 1 ? failing(c, 503)(call) : renewed(c)(call);
      },
    }));

    await ft.advance(450_000);
    expect(pb.authStore.token).toBe(token);
    expect(ft.delays()).toEqual([1_000]);

    await ft.advance(1_000);
    expect(callsTo(api.calls, "POST", "/api/session/renew")).toHaveLength(2);
    expect(pb.authStore.token).not.toBe(token);
  });

  test("retries stop at expiry, when the token is cleared", async () => {
    const { ft, pb, token, clock } = harness((c) => ({ [RENEW]: failing(c, 503) }));
    const expiresAt = START + 900_000;

    await ft.advance(850_000);
    expect(clock()).toBe(START + 850_000);
    expect(pb.authStore.token).toBe(token);

    await ft.advance(50_000);
    expect(clock()).toBe(expiresAt);
    expect(pb.authStore.token).toBe("");
  });

  test("dispose() stops the timers: nothing renews afterwards", async () => {
    const { ft, pb, api } = harness();
    expect(ft.count).toBe(1);
    pb.dispose();
    expect(ft.count).toBe(0);
    await ft.advance(10 * 900_000);
    expect(callsTo(api.calls, "POST", "/api/session/renew")).toHaveLength(0);
  });

  test("no renewal is scheduled without renewUrl, and renew() rejects", async () => {
    const { ft, pb } = harness(undefined, { renewUrl: undefined });
    expect(ft.count).toBe(0);
    await expect(pb.renew()).rejects.toThrow(TypeError);
  });

  test("a record for another user is dropped", () => {
    const { pb } = harness(undefined, { record: record("someone-else") });
    expect(pb.authStore.record).toBeNull();
    expect(pb.authStore.token).not.toBe("");
  });

  test("a renewal whose session changed in between is discarded", async () => {
    const { pb, api } = harness();
    const pending = pb.renew();
    pb.authStore.clear();
    await pending;
    expect(callsTo(api.calls, "POST", "/api/session/renew")).toHaveLength(1);
    expect(pb.authStore.token).toBe("");
  });

  test("a failed renewal of a session that has since changed schedules nothing for the new one", async () => {
    let answer!: (res: Response) => void;
    const held = new Promise<Response>((resolve) => {
      answer = resolve;
    });
    const { pb, clock, ft } = harness(() => ({ [RENEW]: () => held }));
    const other = authToken(Math.floor(START / 1000) + 900, "u2");

    const pending = pb.renew().catch((err: unknown) => err);
    pb.authStore.save(other, record("u2")); // another user signs in while the renewal is out
    answer(json(clock, 503, { status: 503, message: "down", data: {} }));
    await pending;
    await settle();

    expect(pb.authStore.token).toBe(other);
    // only the new token's renewal is pending: at half its 900 s lifetime, not a retry at 1 s
    expect(ft.delays()).toEqual([450_000]);
  });

  test("a renewal for a new session does not share the old session's request", async () => {
    let answer!: (res: Response) => void;
    const held = new Promise<Response>((resolve) => {
      answer = resolve;
    });
    const { pb, api } = harness(() => ({ [RENEW]: () => held }));
    const other = authToken(Math.floor(START / 1000) + 900, "u2");

    const first = pb.renew().catch((err: unknown) => err);
    pb.authStore.save(other, record("u2"));
    const second = pb.renew().catch((err: unknown) => err);
    expect(callsTo(api.calls, "POST", "/api/session/renew")).toHaveLength(2);

    answer(new Response(null, { status: 401 }));
    await Promise.all([first, second]);
  });

  test("realtime subscriptions are resubmitted with the new token after a renewal", async () => {
    setGlobal("EventSource", FakeEventSource);
    resetFakeEventSources();
    const { ft, api, pb, token } = harness((c) => ({
      [RENEW]: renewed(c),
      "POST /api/realtime": () => new Response(null, { status: 204 }),
    }));

    await pb.collection("demo").subscribe("*", () => {});
    const before = callsTo(api.calls, "POST", "/api/realtime");
    expect(before).toHaveLength(1);
    expect(before[0]?.headers.get("authorization")).toBe(token);

    await ft.advance(450_000);
    const after = callsTo(api.calls, "POST", "/api/realtime");
    expect(after).toHaveLength(2);
    const resubmitted = after[1];
    expect(resubmitted?.headers.get("authorization")).toBe(pb.authStore.token);
    expect(resubmitted?.headers.get("authorization")).not.toBe(token);
    expect(resubmitted?.body).toEqual({ clientId: "client1", subscriptions: ["demo/*"] });
    // the same record keeps its connection: only the authorization is resubmitted
    expect(fakeSources).toHaveLength(1);

    await pb.realtime.unsubscribe();
  });

  test("handOff replaces the popup token with a minted short token", async () => {
    const popup = authToken(Math.floor(START / 1000) + 36_000, "u1");
    const { pb, api } = harness(
      (c) => ({
        [HAND_OFF]: (call) => {
          expect(call.body).toEqual({ token: popup });
          return json(c, 200, { record: record() });
        },
        [RENEW]: renewed(c),
      }),
      { token: popup, handOffUrl: HAND_OFF_URL },
    );

    await pb.handOff();

    expect(pb.authStore.token).not.toBe(popup);
    expect(pb.authStore.record?.id).toBe("u1");
    expect(callsTo(api.calls, "POST", "/api/session/renew")).toHaveLength(1);
  });

  test("handOff: a 401 clears the store", async () => {
    const popup = authToken(Math.floor(START / 1000) + 36_000, "u1");
    const { pb } = harness((c) => ({ [HAND_OFF]: failing(c, 401) }), {
      token: popup,
      handOffUrl: HAND_OFF_URL,
    });
    await expect(pb.handOff()).rejects.toMatchObject({ status: 401 });
    expect(pb.authStore.token).toBe("");
  });

  test("handOff: a network error clears the popup token and reports the error", async () => {
    const popup = authToken(Math.floor(START / 1000) + 36_000, "u1");
    const clock = testClock(START);
    const ft = fakeTimers(clock);
    const pb = createBrowserClient({
      url: API,
      renewUrl: RENEW_URL,
      handOffUrl: HAND_OFF_URL,
      clock,
      timers: ft.timers,
      fetch: () => Promise.reject(new TypeError("offline")),
      token: popup,
      record: record(),
    });
    const error = await pb.handOff().then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(ClientResponseError);
    expect((error as ClientResponseError).status).toBe(0);
    expect(pb.authStore.token).toBe("");
    pb.dispose();
  });

  test("handOff: any other refusal (a 403 or a 500) clears the popup token too", async () => {
    for (const status of [403, 500]) {
      const popup = authToken(Math.floor(START / 1000) + 36_000, "u1");
      const { pb } = harness((c) => ({ [HAND_OFF]: failing(c, status) }), {
        token: popup,
        handOffUrl: HAND_OFF_URL,
      });
      await expect(pb.handOff()).rejects.toMatchObject({ status });
      expect(pb.authStore.token).toBe("");
      pb.dispose();
    }
  });

  test("handOff: when the renewal then fails, the popup token is not kept", async () => {
    const popup = authToken(Math.floor(START / 1000) + 36_000, "u1");
    const { pb } = harness(
      (c) => ({
        [HAND_OFF]: () => json(c, 200, { record: record() }),
        [RENEW]: failing(c, 503),
      }),
      { token: popup, handOffUrl: HAND_OFF_URL },
    );
    await expect(pb.handOff()).rejects.toMatchObject({ status: 503 });
    expect(pb.authStore.token).toBe("");
  });

  test("fallback: without a token, the readable session cookie is read (plain name on http)", () => {
    const session = authToken(Math.floor(START / 1000) + 3600, "u1");
    setGlobal("document", { cookie: cookieFor(session, "pb_auth") });
    setGlobal("location", { protocol: "http:" });
    const pb = withoutToken();
    expect(pb.authStore.token).toBe(session);
    expect(pb.authStore.record?.id).toBe("u1");
  });

  test("fallback: on https only the __Host- name is read", () => {
    const session = authToken(Math.floor(START / 1000) + 3600, "u1");
    setGlobal("location", { protocol: "https:" });

    setGlobal("document", { cookie: cookieFor(session, "pb_auth") });
    expect(withoutToken().authStore.token).toBe("");

    setGlobal("document", { cookie: cookieFor(session, "__Host-pb_auth") });
    expect(withoutToken().authStore.token).toBe(session);
  });
});

/** A browser client subscribed as the given user, with a realtime route that accepts. */
async function subscribed(user = "u1") {
  const token = authToken(Math.floor(START / 1000) + 900, user);
  const h = harness(
    (c) => ({
      [RENEW]: renewed(c),
      "POST /api/realtime": () => new Response(null, { status: 204 }),
    }),
    { token, record: record(user) },
  );
  await h.pb.collection("demo").subscribe("*", () => {});
  return { ...h, user };
}

function realtimePosts(api: Harness["api"]): Call[] {
  return callsTo(api.calls, "POST", "/api/realtime");
}

function lastOf<T>(items: T[]): T | undefined {
  return items[items.length - 1];
}

/**
 * The realtime service's own timers: its backoff and its connect timeout use the global
 * `setTimeout`, so they run on a fake clock, `rt`, and the tests advance it. Returns the function
 * that restores the globals.
 */
let rt: ReturnType<typeof fakeTimers>;
function installRealtimeTimers(): () => void {
  const savedSetTimeout = globalThis.setTimeout;
  const savedClearTimeout = globalThis.clearTimeout;
  rt = fakeTimers(testClock(START));
  setGlobal("setTimeout", rt.timers.setTimeout);
  setGlobal("clearTimeout", rt.timers.clearTimeout);
  return () => {
    setGlobal("setTimeout", savedSetTimeout);
    setGlobal("clearTimeout", savedClearTimeout);
  };
}

describe("realtime follows the signed-in user", () => {
  let savedEventSource: unknown;
  let restoreTimers: (() => void) | undefined;
  beforeEach(() => {
    savedEventSource = globalThis.EventSource;
    setGlobal("EventSource", FakeEventSource);
    resetFakeEventSources();
    restoreTimers = installRealtimeTimers();
  });
  afterEach(() => {
    restoreTimers?.();
    setGlobal("EventSource", savedEventSource);
  });

  test("a sign-out (authStore.clear) opens a new connection, authorized as a guest", async () => {
    const { pb, api } = await subscribed();
    expect(fakeSources).toHaveLength(1);

    pb.authStore.clear();
    await settle();
    await rt.advance(200); // the reconnect's first attempt

    expect(fakeSources).toHaveLength(2);
    expect(fakeSources[0]?.closed).toBe(true);
    const posts = realtimePosts(api);
    const last = lastOf(posts);
    expect(last?.headers.get("authorization")).toBeNull();
    expect(last?.body).toEqual({ clientId: "client2", subscriptions: ["demo/*"] });

    // a later subscribe works as a guest, on the new connection
    await pb.collection("other").subscribe("*", () => {});
    expect(lastOf(realtimePosts(api))?.body).toEqual({
      clientId: "client2",
      subscriptions: ["demo/*", "other/*"],
    });
    expect(lastOf(realtimePosts(api))?.headers.get("authorization")).toBeNull();
    pb.dispose();
    await pb.realtime.unsubscribe();
  });

  test("a sign-in as another user (in this tab) opens a new connection for that user", async () => {
    const { pb, api } = await subscribed("u1");
    const other = authToken(Math.floor(START / 1000) + 900, "u2");

    pb.authStore.save(other, record("u2"));
    await settle();
    await rt.advance(200);

    expect(fakeSources).toHaveLength(2);
    expect(fakeSources[0]?.closed).toBe(true);
    const last = lastOf(realtimePosts(api));
    expect(last?.headers.get("authorization")).toBe(other);
    expect(last?.body).toEqual({ clientId: "client2", subscriptions: ["demo/*"] });
    pb.dispose();
    await pb.realtime.unsubscribe();
  });

  test("a renewal that answers another user (signed in in another tab) reconnects", async () => {
    const token = authToken(Math.floor(START / 1000) + 900, "u1");
    const other = authToken(Math.floor(START / 1000) + 900, "u2");
    const { pb, api } = harness(
      (c) => ({
        [RENEW]: () =>
          json(c, 200, { token: other, record: record("u2"), expiresAt: 0, serverTime: START }),
        "POST /api/realtime": () => new Response(null, { status: 204 }),
      }),
      { token, record: record("u1") },
    );
    await pb.collection("demo").subscribe("*", () => {});

    await pb.renew();
    await settle();
    await rt.advance(200);

    expect(fakeSources).toHaveLength(2);
    expect(lastOf(realtimePosts(api))?.headers.get("authorization")).toBe(other);
    pb.dispose();
    await pb.realtime.unsubscribe();
  });

  test("a renewal that the server refuses with 401 (cross-tab sign-out) reconnects as a guest", async () => {
    const token = authToken(Math.floor(START / 1000) + 900, "u1");
    const { pb, api } = harness(
      (c) => ({
        [RENEW]: failing(c, 401),
        "POST /api/realtime": () => new Response(null, { status: 204 }),
      }),
      { token, record: record("u1") },
    );
    await pb.collection("demo").subscribe("*", () => {});

    await pb.renew().catch(() => {});
    await settle();
    await rt.advance(200);

    expect(pb.authStore.token).toBe("");
    expect(fakeSources).toHaveLength(2);
    expect(lastOf(realtimePosts(api))?.headers.get("authorization")).toBeNull();
    pb.dispose();
    await pb.realtime.unsubscribe();
  });

  test("a sign-out with no subscriptions opens no connection", async () => {
    const token = authToken(Math.floor(START / 1000) + 900, "u1");
    const { pb } = harness(undefined, { token, record: record("u1") });
    pb.authStore.clear();
    await settle();
    expect(fakeSources).toHaveLength(0);
    pb.dispose();
  });

  test("a renewal of the same record keeps the connection", async () => {
    const { pb, api } = await subscribed();
    await pb.renew();
    await settle();
    expect(fakeSources).toHaveLength(1);
    expect(realtimePosts(api)).toHaveLength(2);
    pb.dispose();
    await pb.realtime.unsubscribe();
  });
});

/**
 * Realtime recovers from an outage. The realtime service's own backoff timers run on a fake clock
 * (its `setTimeout` is the global one), so the tests advance them without sleeping. While
 * `fakeOffline` is set, every new connection fails at once, as an unreachable iglo.base does.
 */
describe("realtime recovers from an outage", () => {
  let savedEventSource: unknown;
  let restoreTimers: (() => void) | undefined;
  beforeEach(() => {
    savedEventSource = globalThis.EventSource;
    setGlobal("EventSource", FakeEventSource);
    resetFakeEventSources();
    fakeOffline = false;
    restoreTimers = installRealtimeTimers();
  });
  afterEach(() => {
    fakeOffline = false;
    restoreTimers?.();
    setGlobal("EventSource", savedEventSource);
  });

  test("a sign-out during an outage: retried with the usual backoff, then restored as a guest", async () => {
    const { pb, api } = await subscribed("u1");
    const hooks: string[][] = [];
    pb.realtime.onDisconnect = (subs) => {
      hooks.push(subs);
    };

    fakeOffline = true;
    pb.authStore.clear();
    await settle();
    expect(pb.realtime.isConnected).toBe(false);
    expect(rt.delays()).toEqual([200]); // the first backoff step, as after a dropped connection

    await rt.advance(200); // the first attempt fails while offline
    expect(rt.delays()).toEqual([300]); // the next step

    fakeOffline = false;
    await rt.advance(300); // the network is back
    expect(pb.realtime.isConnected).toBe(true);
    expect(lastOf(realtimePosts(api))?.headers.get("authorization")).toBeNull();
    expect(lastOf(realtimePosts(api))?.body).toEqual({
      clientId: "client3",
      subscriptions: ["demo/*"],
    });
    expect(hooks).toEqual([]); // an intended reconnect is not a disconnect

    pb.dispose();
    await pb.realtime.unsubscribe();
  });

  test("a user switch during an outage: retried, then restored for the new user", async () => {
    const { pb, api } = await subscribed("u1");
    const other = authToken(Math.floor(START / 1000) + 900, "u2");

    fakeOffline = true;
    pb.authStore.save(other, record("u2"));
    await settle();
    expect(rt.delays()).toEqual([200]);

    await rt.advance(200);
    expect(rt.delays()).toEqual([300]);

    fakeOffline = false;
    await rt.advance(300);
    expect(pb.realtime.isConnected).toBe(true);
    expect(lastOf(realtimePosts(api))?.headers.get("authorization")).toBe(other);
    expect(lastOf(realtimePosts(api))?.body).toEqual({
      clientId: "client3",
      subscriptions: ["demo/*"],
    });

    pb.dispose();
    await pb.realtime.unsubscribe();
  });

  test("a dropped connection during an outage: retried with the usual backoff, with no auth change", async () => {
    const { pb, api, token } = await subscribed("u1");
    const hooks: string[][] = [];
    pb.realtime.onDisconnect = (subs) => {
      hooks.push(subs);
    };

    fakeOffline = true;
    fakeSources[0]?.fail(); // the live connection drops
    await settle();
    expect(hooks).toEqual([["demo/*"]]); // a real disconnect still calls the hook
    expect(rt.delays()).toEqual([200]);

    await rt.advance(200);
    expect(rt.delays()).toEqual([300]);

    fakeOffline = false;
    await rt.advance(300);
    expect(pb.realtime.isConnected).toBe(true);
    expect(lastOf(realtimePosts(api))?.headers.get("authorization")).toBe(token);
    expect(lastOf(realtimePosts(api))?.body).toEqual({
      clientId: "client3",
      subscriptions: ["demo/*"],
    });
    expect(hooks).toHaveLength(1);

    pb.dispose();
    await pb.realtime.unsubscribe();
  });

  test("a subscription POST that fails on the new connection is retried too", async () => {
    const token = authToken(Math.floor(START / 1000) + 900, "u1");
    let realtimeUp = true;
    const { pb, api } = harness(
      (c) => ({
        [RENEW]: renewed(c),
        "POST /api/realtime": () =>
          realtimeUp
            ? new Response(null, { status: 204 })
            : json(c, 503, { status: 503, message: "down", data: {} }),
      }),
      { token, record: record("u1") },
    );
    await pb.collection("demo").subscribe("*", () => {});

    realtimeUp = false;
    pb.authStore.clear();
    await settle();
    await rt.advance(200); // connects, but the subscriptions are refused with 503
    expect(pb.realtime.isConnected).toBe(false);
    expect(rt.delays()).toEqual([300]);

    realtimeUp = true;
    await rt.advance(300);
    expect(pb.realtime.isConnected).toBe(true);
    expect(lastOf(realtimePosts(api))?.body).toEqual({
      clientId: "client3",
      subscriptions: ["demo/*"],
    });

    pb.dispose();
    await pb.realtime.unsubscribe();
  });
});

/**
 * While set, a subscription POST hangs until its request is aborted: a connection whose first
 * subscription request is still in flight when the user changes.
 */
let fakeRealtimeHangs = false;

function realtimeAnswer(): Handler {
  return (call) => {
    if (!fakeRealtimeHangs) {
      return new Response(null, { status: 204 });
    }
    return new Promise<Response>((_resolve, reject) => {
      const aborted = () => reject(new DOMException("The operation was aborted.", "AbortError"));
      if (call.signal?.aborted) {
        aborted();
      } else {
        call.signal?.addEventListener("abort", aborted, { once: true });
      }
    });
  };
}

/** Subscribed as `u1`, then the live connection drops: the new connection's POST hangs. */
async function droppedWithPostInFlight() {
  const token = authToken(Math.floor(START / 1000) + 900, "u1");
  const h = harness((c) => ({ [RENEW]: renewed(c), "POST /api/realtime": realtimeAnswer() }), {
    token,
    record: record("u1"),
  });
  await h.pb.collection("demo").subscribe("*", () => {});

  fakeRealtimeHangs = true;
  fakeSources[0]?.fail();
  await settle();
  await rt.advance(200); // client2 connects, and its subscriptions are sent
  expect(fakeSources).toHaveLength(2);
  expect(lastOf(realtimePosts(h.api))?.body).toEqual({
    clientId: "client2",
    subscriptions: ["demo/*"],
  });
  return h;
}

/**
 * A user change while a new connection's subscription POST is in flight. The POST hangs until
 * the change aborts it, so the stale continuation of that connection runs after the change. The
 * realtime connection must still come back for the current authorization.
 */
describe("realtime survives a user change during a subscription POST", () => {
  let savedEventSource: unknown;
  let restoreTimers: (() => void) | undefined;
  beforeEach(() => {
    savedEventSource = globalThis.EventSource;
    setGlobal("EventSource", FakeEventSource);
    resetFakeEventSources();
    fakeOffline = false;
    fakeRealtimeHangs = false;
    restoreTimers = installRealtimeTimers();
  });
  afterEach(() => {
    fakeRealtimeHangs = false;
    restoreTimers?.();
    setGlobal("EventSource", savedEventSource);
  });

  test("(a) the user signs out during the subscription POST", async () => {
    const { pb, api } = await droppedWithPostInFlight();

    pb.authStore.clear();
    await settle();
    fakeRealtimeHangs = false;
    expect(rt.delays()).toEqual([300]); // the backoff goes on from the attempt in flight

    await rt.advance(300);
    expect(pb.realtime.isConnected).toBe(true);
    expect(pb.realtime.clientId).toBe("client3");
    expect(lastOf(realtimePosts(api))?.headers.get("authorization")).toBeNull();
    expect(lastOf(realtimePosts(api))?.body).toEqual({
      clientId: "client3",
      subscriptions: ["demo/*"],
    });

    pb.dispose();
    await pb.realtime.unsubscribe();
  });

  test("(b) the user signs out and another user signs in during the subscription POST", async () => {
    const { pb, api } = await droppedWithPostInFlight();
    const other = authToken(Math.floor(START / 1000) + 900, "u2");

    pb.authStore.clear();
    pb.authStore.save(other, record("u2"));
    await settle();
    fakeRealtimeHangs = false;

    await rt.advance(rt.delays()[0] ?? 0);
    expect(pb.realtime.isConnected).toBe(true);
    expect(pb.realtime.clientId).toBe("client3");
    expect(lastOf(realtimePosts(api))?.headers.get("authorization")).toBe(other);
    expect(lastOf(realtimePosts(api))?.body).toEqual({
      clientId: "client3",
      subscriptions: ["demo/*"],
    });

    pb.dispose();
    await pb.realtime.unsubscribe();
  });

  test("(c) the user signs out during the first subscribe() POST", async () => {
    const token = authToken(Math.floor(START / 1000) + 900, "u1");
    const { pb, api } = harness(
      (c) => ({ [RENEW]: renewed(c), "POST /api/realtime": realtimeAnswer() }),
      { token, record: record("u1") },
    );

    fakeRealtimeHangs = true;
    const subscribing = pb.collection("demo").subscribe("*", () => {});
    await settle();
    expect(fakeSources).toHaveLength(1);
    expect(realtimePosts(api)).toHaveLength(1); // the first subscribe's POST is in flight

    pb.authStore.clear();
    await settle();
    fakeRealtimeHangs = false;
    expect(rt.delays()).toEqual([200]);

    await rt.advance(200);
    await subscribing; // resolves once the new connection is up, not before
    expect(pb.realtime.isConnected).toBe(true);
    expect(pb.realtime.clientId).toBe("client2");
    expect(lastOf(realtimePosts(api))?.headers.get("authorization")).toBeNull();
    expect(lastOf(realtimePosts(api))?.body).toEqual({
      clientId: "client2",
      subscriptions: ["demo/*"],
    });

    pb.dispose();
    await pb.realtime.unsubscribe();
  });
});

/**
 * A plain SDK client (upstream's `Client`), with no browser client on top. Its requests go to the
 * stub, so its realtime retries are observable.
 */
class PlainClient extends Client {
  constructor(private readonly stub: FetchFunction) {
    super(API, new BaseAuthStore());
  }

  override async send<T = Loose>(path: string, options: SendOptions): Promise<T> {
    return super.send<T>(path, { ...options, fetch: this.stub });
  }
}

/**
 * A plain client's realtime without any auth change keeps the upstream retry: the same backoff
 * steps, and the subscriptions are restored on the new connection.
 */
describe("a plain client's realtime retries as upstream does", () => {
  let savedEventSource: unknown;
  let restoreTimers: (() => void) | undefined;
  beforeEach(() => {
    savedEventSource = globalThis.EventSource;
    setGlobal("EventSource", FakeEventSource);
    resetFakeEventSources();
    fakeOffline = false;
    fakeRealtimeHangs = false;
    restoreTimers = installRealtimeTimers();
  });
  afterEach(() => {
    fakeOffline = false;
    fakeRealtimeHangs = false;
    restoreTimers?.();
    setGlobal("EventSource", savedEventSource);
  });

  test("a dropped connection is retried on the backoff steps, then restored", async () => {
    const clock = testClock(START);
    const api = stubApi(clock, { "POST /api/realtime": realtimeAnswer() });
    const pb = new PlainClient(api.fetch);
    await pb.collection("demo").subscribe("*", () => {});

    fakeOffline = true;
    fakeSources[0]?.fail();
    await settle();
    expect(rt.delays()).toEqual([200]);
    await rt.advance(200); // the first attempt fails while offline
    expect(rt.delays()).toEqual([300]);

    fakeOffline = false;
    await rt.advance(300);
    expect(pb.realtime.isConnected).toBe(true);
    expect(lastOf(realtimePosts(api))?.body).toEqual({
      clientId: "client3",
      subscriptions: ["demo/*"],
    });

    await pb.realtime.unsubscribe();
  });

  test("a connection that drops while its first subscription POST is in flight is retried", async () => {
    const clock = testClock(START);
    const api = stubApi(clock, { "POST /api/realtime": realtimeAnswer() });
    const pb = new PlainClient(api.fetch);
    await pb.collection("demo").subscribe("*", () => {});

    fakeRealtimeHangs = true;
    fakeSources[0]?.fail();
    await settle();
    await rt.advance(200); // client2 connects; its POST hangs
    expect(fakeSources).toHaveLength(2);

    // the new connection drops with its POST in flight: the retry must still be scheduled
    fakeRealtimeHangs = false;
    fakeSources[1]?.fail();
    await settle();
    expect(rt.delays()).toEqual([300]);

    await rt.advance(300);
    expect(pb.realtime.isConnected).toBe(true);
    expect(lastOf(realtimePosts(api))?.body).toEqual({
      clientId: "client3",
      subscriptions: ["demo/*"],
    });

    await pb.realtime.unsubscribe();
  });
});

/** A browser client with no token handed over: fallback mode reads the readable cookie. */
function withoutToken() {
  const clock = testClock(START);
  return createBrowserClient({
    url: API,
    clock,
    timers: fakeTimers(clock).timers,
    fetch: stubApi(clock, {}).fetch,
  });
}

function cookieFor(token: string, name: string): string {
  return `${name}=${encodeURIComponent(JSON.stringify({ token, record: record() }))}`;
}

/** Every connection the tests opened, in order, and the client IDs they were given. */
const fakeSources: FakeEventSource[] = [];
let fakeClientSeq = 0;

function resetFakeEventSources(): void {
  fakeSources.length = 0;
  fakeClientSeq = 0;
}

/** While set, every new connection fails at once: iglo.base cannot be reached. */
let fakeOffline = false;

/**
 * A test-only EventSource: it announces a connection (client1, client2, ...) on the next
 * microtask, and records whether the client closed it. While offline it fails instead.
 */
class FakeEventSource {
  readonly #listeners = new Map<string, Set<(e: { data: string; lastEventId: string }) => void>>();
  onerror: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    fakeSources.push(this);
    const clientId = `client${++fakeClientSeq}`;
    queueMicrotask(() => {
      if (fakeOffline) {
        this.onerror?.();
        return;
      }
      this.#emit("PB_CONNECT", { data: "{}", lastEventId: clientId });
    });
  }
  /** The live connection fails, as when the network drops. */
  fail(): void {
    this.onerror?.();
  }
  addEventListener(type: string, listener: (e: { data: string; lastEventId: string }) => void) {
    let set = this.#listeners.get(type);
    if (!set) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    set.add(listener);
  }
  removeEventListener(type: string, listener: (e: { data: string; lastEventId: string }) => void) {
    this.#listeners.get(type)?.delete(listener);
  }
  close() {
    this.closed = true;
  }
  #emit(type: string, e: { data: string; lastEventId: string }) {
    for (const listener of this.#listeners.get(type) ?? []) {
      listener(e);
    }
  }
}

function setGlobal(name: string, value: unknown): void {
  const scope = globalThis as unknown as Record<string, unknown>;
  if (value === undefined) {
    delete scope[name];
  } else {
    scope[name] = value;
  }
}
