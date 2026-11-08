// docs/design/13-ssr.md ("Browser client and realtime", "OAuth2": popup flow). The browser client
// with an injected clock and fake timers: nothing sleeps. Realtime runs against a fake
// EventSource, so a renewal's resubmission is visible as a request.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import Client from "@sdk/Client";
import { ClientResponseError } from "@sdk/ClientResponseError";
import { createBrowserClient, type CreateBrowserClientOptions } from "@sdk/ssr/browser-client";
import {
  API,
  APP,
  authToken,
  fakeTimers,
  json,
  record,
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
    expect(ft.delays()).toEqual([1_000]);
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

  test("realtime subscriptions are resubmitted with the new token after a renewal", async () => {
    setGlobal("EventSource", FakeEventSource);
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

/** A test-only EventSource: it announces a connection (client1) on the next microtask. */
class FakeEventSource {
  readonly #listeners = new Map<string, Set<(e: { data: string; lastEventId: string }) => void>>();
  onerror: unknown = null;
  constructor(readonly url: string) {
    queueMicrotask(() => {
      this.#emit("PB_CONNECT", { data: "{}", lastEventId: "client1" });
    });
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
  close() {}
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
