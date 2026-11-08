// docs/design/13-ssr.md ("Browser client and realtime", "Session cookie"). The browser client
// against upstream PocketBase v0.41.0 and iglo.base, both in process with the SSR adapters:
// the page token is minted at render, the browser client subscribes in realtime, renews on its
// own clock and keeps its subscription, and a password change signs it out. A second test runs
// the fallback without superuser credentials, where the browser client reads the cookie.
// Every recorded value is compared across the two servers; tokens are recorded by shape only.

import { describe, expect } from "bun:test";
import {
  createServerClient,
  createSessionCache,
  createSuperuserClient,
  handleBrowserTokenRenew,
  mintBrowserToken,
  type CookieAdapter,
  type CookieToSet,
  type ServerClient,
} from "iglo.base/ssr";
import { createBrowserClient, type BrowserClient } from "iglo.base/ssr/browser";
import { ClientResponseError, getTokenPayload } from "iglo.base";
import { password, sdkTest, superuserToken, type SdkEnv } from "@test/differential/sdk/harness";
import { Browser } from "@test/differential/sdk-ssr/browser";
import { setMFA } from "@test/scenarios/record-auth-prepare";

const noMFA = ({ dataDir }: { dataDir: string }) => setMFA("users", false, "")({ dataDir });

const APP = "http://localhost:3000";
const RENEW_URL = `${APP}/api/session/renew`;
const TIMEOUT = 120_000;
const CHANGED_PASSWORD = "1234567890-changed";
const PAGE_TOKEN_SEC = 600;
const USER_EMAIL = "test@example.com";
const OTHER_EMAIL = "test2@example.com";

/** The app's cookie adapter over the browser's cookie jar (the session cookie). */
function appCookies(browser: Browser): CookieAdapter {
  return {
    getAll: () => [...browser.jar].map(([name, value]) => ({ name, value })),
    setAll: (list: CookieToSet[]) => {
      for (const c of list) {
        if (c.options?.maxAge === 0) {
          browser.jar.delete(c.name);
        } else {
          browser.jar.set(c.name, c.value);
        }
      }
    },
  };
}

/** A timer the test runs by hand, on the browser client's own clock. */
function manualClock(startMs: number) {
  let now = startMs;
  let seq = 0;
  const pending = new Map<number, { due: number; fn: () => void }>();
  return {
    now: () => now,
    timers: {
      setTimeout: (fn: () => void, ms: number): unknown => {
        seq++;
        pending.set(seq, { due: now + ms, fn });
        return seq;
      },
      clearTimeout: (handle: unknown): void => {
        pending.delete(handle as number);
      },
    },
    /** Moves the clock and runs the timers that come due (their renewals finish on the server). */
    advance(ms: number): void {
      now += ms;
      for (;;) {
        let next: [number, { due: number; fn: () => void }] | undefined;
        for (const entry of pending) {
          if (entry[1].due <= now && (!next || entry[1].due < next[1].due)) {
            next = entry;
          }
        }
        if (!next) {
          return;
        }
        pending.delete(next[0]);
        next[1].fn();
      }
    },
    get count(): number {
      return pending.size;
    },
  };
}

/** A token's comparable shape: who it is for and what kind it is, never the token itself. */
function tokenShape(token: string) {
  const payload = getTokenPayload(token);
  return {
    type: payload.type,
    collectionId: payload.collectionId,
    refreshable: payload.refreshable,
  };
}

async function createEventsCollection(env: SdkEnv, name: string): Promise<void> {
  await env.step(`create collection ${name}`, () =>
    env.superuser().collections.create({
      name,
      type: "base",
      listRule: "@request.auth.id != ''",
      viewRule: "@request.auth.id != ''",
      createRule: "",
      fields: [{ name: "title", type: "text" }],
    }),
  );
}

/** A collection whose records only their `who` (the signed-in email) may read. */
async function createWhoCollection(env: SdkEnv, name: string): Promise<void> {
  await env.step(`create collection ${name}`, () =>
    env.superuser().collections.create({
      name,
      type: "base",
      listRule: "who = @request.auth.email",
      viewRule: "who = @request.auth.email",
      createRule: "",
      fields: [
        { name: "title", type: "text" },
        { name: "who", type: "text" },
      ],
    }),
  );
}

/** A collection anyone may read: its events mark the point up to which the page has heard. */
async function createPublicCollection(env: SdkEnv, name: string): Promise<void> {
  await env.step(`create collection ${name}`, () =>
    env.superuser().collections.create({
      name,
      type: "base",
      listRule: "",
      viewRule: "",
      createRule: "",
      fields: [{ name: "title", type: "text" }],
    }),
  );
}

/** The app's server client for a user, signed in through the browser's cookie jar. */
async function signInAs(backend: string, browser: Browser, email: string): Promise<ServerClient> {
  const app = await createServerClient({
    url: backend,
    origin: APP,
    cookies: appCookies(browser),
  });
  await app.collection("users").authWithPassword(email, password);
  return app;
}

interface PageStatuses {
  renew: number[];
  realtime: number[];
}

/**
 * A page as the app serves it: a browser token minted from the app's server client, and a browser
 * client on it. The renew route runs in process with the browser's cookies and origin; realtime
 * requests go straight to iglo.base, as they do from a real page.
 */
async function openPage(
  env: SdkEnv,
  browser: Browser,
  app: ServerClient,
  statuses: PageStatuses,
): Promise<BrowserClient> {
  const superuser = await createSuperuserClient({ url: env.url, token: superuserToken });
  const page = await mintBrowserToken(app, superuser, { duration: PAGE_TOKEN_SEC });
  if (!page) {
    throw new Error("no page token");
  }
  const sessionCache = createSessionCache();
  const pageFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === RENEW_URL) {
      const response = await handleBrowserTokenRenew(
        browser.request(url, { method: init?.method ?? "GET", headers: { origin: APP } }),
        { url: env.url, superuser, sessionCache },
      );
      browser.store(response);
      statuses.renew.push(response.status);
      return response;
    }
    const response = await fetch(input, init);
    if (url.includes("/api/realtime")) {
      statuses.realtime.push(response.status);
    }
    return response;
  };
  return createBrowserClient({
    url: env.url,
    token: page.token,
    record: page.record,
    serverTime: page.serverTime,
    renewUrl: RENEW_URL,
    fetch: pageFetch,
  });
}

/** Creates a marker in the public collection and waits until the page has received it. */
async function sentinel(env: SdkEnv, open: string, id: string, received: string[]): Promise<void> {
  await env.step(`create sentinel ${id}`, () =>
    env.superuser().collection(open).create({ id, title: "sentinel" }),
  );
  await env.until(() => received.includes(id), `the sentinel ${id}`);
}

interface SeenEvent {
  action: string;
  record: { id: string; title: string };
}

describe("browser client", () => {
  sdkTest(
    "minted at render, realtime across a renewal, signed out after a password change",
    { prepare: noMFA, timeout: TIMEOUT },
    async (env) => {
      const admin = env.superuser();
      const collection = "ssr_browser_rt";
      await createEventsCollection(env, collection);

      // the app's own server client, with the user's session cookie in the browser's jar
      const browser = new Browser();
      const app = await createServerClient({
        url: env.url,
        origin: APP,
        cookies: appCookies(browser),
      });
      await env.derived(
        "sign in",
        () => app.collection("users").authWithPassword(USER_EMAIL, password),
        (res) => ({ email: res.record.email }),
      );
      const sessionToken = app.authStore.token;

      // the page: a token minted at render, from the superuser client. Ten minutes, not the
      // default 15: a renewal in the same second as the mint would be the identical token
      const superuser = await createSuperuserClient({ url: env.url, token: superuserToken });
      const page = await env.derived(
        "mint at render",
        () => mintBrowserToken(app, superuser, { duration: PAGE_TOKEN_SEC }),
        (minted) => ({
          email: minted?.record?.email,
          minutesLeft: minted && Math.round((minted.expiresAt - Date.now()) / 60_000),
          differsFromSession: minted?.token !== sessionToken,
          shape: minted && tokenShape(minted.token),
        }),
      );
      const pageRecord = page?.record;
      if (!page || !pageRecord) {
        throw new Error("no page token");
      }
      expect(pageRecord.email).toBe(USER_EMAIL);
      expect(page.token).not.toBe(sessionToken);
      expect(getTokenPayload(page.token).refreshable).toBe(false);

      // the renew route, in process, with the browser's cookies and origin
      const sessionCache = createSessionCache();
      const renewStatuses: number[] = [];
      const realtimeStatuses: number[] = [];
      const clock = manualClock(Date.now());
      const pageFetch = async (
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        const url = String(input instanceof Request ? input.url : input);
        if (url === RENEW_URL) {
          const response = await handleBrowserTokenRenew(
            browser.request(url, { method: init?.method ?? "GET", headers: { origin: APP } }),
            { url: env.url, superuser, sessionCache },
          );
          browser.store(response);
          renewStatuses.push(response.status);
          return response;
        }
        const response = await fetch(input, init);
        if (url.includes("/api/realtime")) {
          realtimeStatuses.push(response.status);
        }
        return response;
      };

      const pb = createBrowserClient({
        url: env.url,
        token: page.token,
        record: pageRecord,
        renewUrl: RENEW_URL,
        clock: clock.now,
        timers: clock.timers,
        fetch: pageFetch,
      });
      expect(pb.authStore.isValid).toBe(true);
      expect(clock.count).toBe(1);

      const seen: SeenEvent[] = [];
      await pb.collection(collection).subscribe("*", (e) => {
        seen.push(e as unknown as SeenEvent);
      });
      await env.step("create (before renewal)", () =>
        admin.collection(collection).create({ id: "ssrbrowsert0001", title: "one" }),
      );
      await env.until(() => seen.length >= 1, "the first event");
      env.record("events before renewal", seen.slice());

      // the client clock reaches half the token's life: the browser client renews itself
      const tokenBefore = pb.authStore.token;
      clock.advance((PAGE_TOKEN_SEC * 1000) / 2);
      await env.until(() => pb.authStore.token !== tokenBefore, "the renewed token");
      const renewedPayload = getTokenPayload(pb.authStore.token);
      expect(renewedPayload.id).toBe(pageRecord.id);
      expect(pb.authStore.record?.id).toBe(pageRecord.id);
      expect(pb.authStore.isValid).toBe(true);
      env.record("renewal", {
        sameUser: pb.authStore.record?.id === pageRecord.id,
        differentToken: pb.authStore.token !== tokenBefore,
        shape: tokenShape(pb.authStore.token),
        renewStatuses: renewStatuses.slice(),
      });

      // the same subscription still receives events, on the renewed token
      await env.step("create (after renewal)", () =>
        admin.collection(collection).create({ id: "ssrbrowsert0002", title: "two" }),
      );
      await env.until(() => seen.length >= 2, "the event after renewal");
      expect(seen[1]?.record.id).toBe("ssrbrowsert0002");
      env.record("events after renewal", seen.slice());

      // the password changes: the session is revoked, the renewal answers 401, the page signs out
      await env.step("change the password (superuser)", () =>
        admin.collection("users").update(pageRecord.id, {
          password: CHANGED_PASSWORD,
          passwordConfirm: CHANGED_PASSWORD,
        }),
      );
      let failure: unknown;
      try {
        await pb.renew();
      } catch (err) {
        failure = err;
      }
      expect(failure).toBeInstanceOf(ClientResponseError);
      expect((failure as ClientResponseError).status).toBe(401);
      expect(pb.authStore.token).toBe("");
      expect(pb.authStore.isValid).toBe(false);
      env.record("renew after password change", {
        status: (failure as ClientResponseError).status,
        signedOut: pb.authStore.token === "",
        sessionCookieCleared: !browser.jar.has("pb_auth"),
      });

      // the sign-out opens a new connection with the subscriptions, as a guest: the server accepts them
      await env.until(() => pb.realtime.isConnected, "the guest connection");
      // isConnected turns true when PB_CONNECT arrives, before the subscriptions' answer is recorded:
      // wait for the answers (subscribe, the renewal's resubmit, the guest connection's subscribe)
      await env.until(() => realtimeStatuses.length >= 3, "the guest connection's subscriptions");
      expect(realtimeStatuses.every((s) => s === 204)).toBe(true);
      expect(pb.realtime.isConnected).toBe(true);
      env.record("realtime requests", realtimeStatuses.slice());
      await pb.realtime.unsubscribe();
      pb.dispose();
    },
  );

  sdkTest(
    "fallback without superuser credentials: the browser client reads the cookie and receives events",
    { prepare: noMFA, timeout: TIMEOUT },
    async (env) => {
      const admin = env.superuser();
      const collection = "ssr_browser_fb";
      await createEventsCollection(env, collection);

      // the app's server client writes a cookie the page can read (readableCookie)
      const flags: Array<{ name: string; httpOnly: boolean }> = [];
      const jar = new Map<string, string>();
      const app = await createServerClient({
        url: env.url,
        origin: APP,
        readableCookie: true,
        cookies: {
          getAll: () => [...jar].map(([name, value]) => ({ name, value })),
          setAll: (list: CookieToSet[]) => {
            for (const c of list) {
              flags.push({ name: c.name, httpOnly: c.options?.httpOnly !== false });
              if (c.options?.maxAge === 0) {
                jar.delete(c.name);
              } else {
                jar.set(c.name, c.value);
              }
            }
          },
        },
      });
      await env.derived(
        "sign in (readable cookie)",
        () => app.collection("users").authWithPassword(USER_EMAIL, password),
        (res) => ({ email: res.record.email }),
      );
      env.record("session cookie writes", flags);
      expect(flags.length).toBeGreaterThan(0);
      expect(flags.every((f) => !f.httpOnly)).toBe(true);

      // the page has no token: the browser client reads document.cookie
      const scope = globalThis as unknown as Record<string, unknown>;
      const savedDocument = scope["document"];
      const savedLocation = scope["location"];
      const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
      scope["document"] = { cookie };
      scope["location"] = { protocol: "http:" };
      // the renewal timer is real here: dispose() stops it, even when an assertion fails
      const pb = createBrowserClient({ url: env.url, renewUrl: RENEW_URL });
      try {
        expect(pb.authStore.isValid).toBe(true);
        expect(pb.authStore.record?.email).toBe(USER_EMAIL);

        const seen: SeenEvent[] = [];
        await pb.collection(collection).subscribe("*", (e) => {
          seen.push(e as unknown as SeenEvent);
        });
        await env.step("create (fallback)", () =>
          admin.collection(collection).create({ id: "ssrfallback0001", title: "fb" }),
        );
        await env.until(() => seen.length >= 1, "the fallback event");
        expect(seen[0]?.record.id).toBe("ssrfallback0001");
        env.record("fallback events", seen.slice());
        await pb.realtime.unsubscribe();
      } finally {
        pb.dispose();
        restoreGlobal(scope, "document", savedDocument);
        restoreGlobal(scope, "location", savedLocation);
      }
    },
  );

  sdkTest(
    "sign-out in another tab: realtime stops delivering the old user's records, and a guest can subscribe",
    { prepare: noMFA, timeout: TIMEOUT },
    async (env) => {
      const admin = env.superuser();
      const guarded = "ssr_browser_guard";
      const guardedAgain = "ssr_browser_guard2";
      const open = "ssr_browser_open";
      await createWhoCollection(env, guarded);
      await createWhoCollection(env, guardedAgain);
      await createPublicCollection(env, open);

      const browser = new Browser();
      const app = await signInAs(env.url, browser, USER_EMAIL);
      const statuses: PageStatuses = { renew: [], realtime: [] };
      const pb = await openPage(env, browser, app, statuses);

      const seen: string[] = [];
      const received: string[] = [];
      await pb.collection(guarded).subscribe("*", (e) => {
        seen.push((e as unknown as SeenEvent).record.id);
      });
      await pb.collection(open).subscribe("*", (e) => {
        received.push((e as unknown as SeenEvent).record.id);
      });

      await env.step("create (signed in)", () =>
        admin.collection(guarded).create({ id: "ssrguard0000001", title: "one", who: USER_EMAIL }),
      );
      await env.until(() => seen.length >= 1, "the event while signed in");
      env.record("events while signed in", seen.slice());

      // the session ends in another tab: its cookie is cleared, and the page's renewal is refused
      app.authStore.clear();
      const before = statuses.realtime.length;
      await pb.renew().catch(() => undefined);
      await env.until(() => statuses.realtime.length > before, "the subscriptions as a guest");
      expect(pb.authStore.token).toBe("");
      env.record("renewal after sign-out", statuses.renew.slice());

      // the old user's rule still holds for the record, and the page does not get it
      await env.step("create (signed out, same record rule)", () =>
        admin.collection(guarded).create({ id: "ssrguard0000002", title: "two", who: USER_EMAIL }),
      );
      await sentinel(env, open, "ssrsentinel0001", received);
      expect(seen).toEqual(["ssrguard0000001"]);
      env.record("events after sign-out", seen.slice());

      // a guest can still subscribe, and gets no record it may not read
      await pb.collection(guardedAgain).subscribe("*", () => {});
      env.record("realtime requests", statuses.realtime.slice());
      expect(statuses.realtime.every((s) => s === 204)).toBe(true);
      expect(pb.realtime.isConnected).toBe(true);

      pb.dispose();
      await pb.realtime.unsubscribe();
    },
  );

  sdkTest(
    "another user signs in in the same browser: realtime follows the new user's rules",
    { prepare: noMFA, timeout: TIMEOUT },
    async (env) => {
      const admin = env.superuser();
      const collection = "ssr_browser_switch";
      const open = "ssr_browser_open_switch";
      await createWhoCollection(env, collection);
      await createPublicCollection(env, open);

      const browser = new Browser();
      const app = await signInAs(env.url, browser, USER_EMAIL);
      const statuses: PageStatuses = { renew: [], realtime: [] };
      const pb = await openPage(env, browser, app, statuses);

      const seen: string[] = [];
      const received: string[] = [];
      await pb.collection(collection).subscribe("*", (e) => {
        seen.push((e as unknown as SeenEvent).record.id);
      });
      await pb.collection(open).subscribe("*", (e) => {
        received.push((e as unknown as SeenEvent).record.id);
      });

      // as the first user: their record arrives, the other user's does not
      await env.step("create for the first user", () =>
        admin.collection(collection).create({ id: "ssrswitch000001", title: "a", who: USER_EMAIL }),
      );
      await env.until(() => seen.length >= 1, "the first user's event");
      await env.step("create for the other user (before the switch)", () =>
        admin
          .collection(collection)
          .create({ id: "ssrswitch000002", title: "b", who: OTHER_EMAIL }),
      );
      await sentinel(env, open, "ssrsentinel0001", received);
      expect(seen).toEqual(["ssrswitch000001"]);

      // the other user signs in in another tab: the same cookie jar, then the page renews
      await signInAs(env.url, browser, OTHER_EMAIL);
      const before = statuses.realtime.length;
      await pb.renew();
      await env.until(
        () => statuses.realtime.length > before,
        "the subscriptions for the new user",
      );
      env.record("after the switch", {
        email: pb.authStore.record?.email,
        renew: statuses.renew.slice(),
        realtime: statuses.realtime.slice(),
      });
      expect(pb.authStore.record?.email).toBe(OTHER_EMAIL);

      // the new user's record arrives; the first user's does not
      await env.step("create for the other user (after the switch)", () =>
        admin
          .collection(collection)
          .create({ id: "ssrswitch000003", title: "c", who: OTHER_EMAIL }),
      );
      await env.until(() => seen.length >= 2, "the other user's event");
      await env.step("create for the first user (after the switch)", () =>
        admin.collection(collection).create({ id: "ssrswitch000004", title: "d", who: USER_EMAIL }),
      );
      await sentinel(env, open, "ssrsentinel0002", received);
      expect(seen).toEqual(["ssrswitch000001", "ssrswitch000003"]);
      env.record("events after the switch", seen.slice());

      pb.dispose();
      await pb.realtime.unsubscribe();
    },
  );

  sdkTest(
    "a refused superuser credential answers 503 and keeps the user's session, on both servers",
    { prepare: noMFA, timeout: TIMEOUT },
    async (env) => {
      const admin = env.superuser();
      const browser = new Browser();
      await signInAs(env.url, browser, USER_EMAIL);

      // a second superuser, and an impersonate token for it (an API key). Deleting the superuser
      // refuses the token, as an expired or rotated superuser credential is refused
      // a fixed id, so the two servers' records match; the steps return nothing comparable from it
      const second = "ssrrefusedsu001";
      await env.step("create a second superuser", async () => {
        await admin.collection("_superusers").create({
          id: second,
          email: "ssr-refused@example.com",
          password,
          passwordConfirm: password,
        });
        return "created";
      });
      let impersonatedToken = "";
      await env.step("impersonate the second superuser", async () => {
        const impersonated = await admin.collection("_superusers").impersonate(second, 3600);
        impersonatedToken = impersonated.authStore.token;
        return "impersonated";
      });
      const refused = await createSuperuserClient({
        url: env.url,
        token: impersonatedToken,
      });
      const working = await createSuperuserClient({ url: env.url, token: superuserToken });

      const statuses: number[] = [];
      const cookieClears: number[] = [];
      const renew = async (superuser: Awaited<ReturnType<typeof createSuperuserClient>>) => {
        const res = await handleBrowserTokenRenew(
          browser.request(RENEW_URL, { method: "POST", headers: { origin: APP } }),
          { url: env.url, superuser },
        );
        browser.store(res);
        statuses.push(res.status);
        cookieClears.push(res.headers.getSetCookie().filter((c) => /Max-Age=0/i.test(c)).length);
        return res;
      };

      // the superuser credential works: the page renews
      expect((await renew(refused)).status).toBe(200);

      // the credential is refused: 503, and the user's session cookie is kept
      await env.step("delete the second superuser", () =>
        admin.collection("_superusers").delete(second),
      );
      expect((await renew(refused)).status).toBe(503);
      expect(browser.jar.has("pb_auth")).toBe(true);

      // the credential works again: the same session renews
      expect((await renew(working)).status).toBe(200);
      env.record("renew with a refused superuser credential", {
        statuses: statuses.slice(),
        clearedCookies: cookieClears.slice(),
        sessionKept: browser.jar.has("pb_auth"),
      });
    },
  );
});

function restoreGlobal(scope: Record<string, unknown>, name: string, value: unknown): void {
  if (value === undefined) {
    delete scope[name];
  } else {
    scope[name] = value;
  }
}
