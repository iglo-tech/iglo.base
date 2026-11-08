// docs/design/13-ssr.md (the framework adapters, the session, OAuth2, CSRF, the browser client).
// End to end: each example app (examples/nextjs, examples/sveltekit) runs in production mode
// against iglo.base and against upstream PocketBase v0.41.0, on fresh copies of the fixture, and
// is driven over HTTP with a cookie jar. Once per app, a real browser (agent-browser) checks that
// a realtime event reaches the live page. Run by `bun run test:examples`, never in parallel.

import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { Browser } from "@test/browser/support";
import { copyDataDir, fixtureDir } from "@test/scenarios/fixture";
import { useProvider, verifiedEmail } from "@test/scenarios/record-auth-oauth2";
import { startServer, tempDir } from "@test/support/executable";
import { startUpstream } from "@test/support/upstream";

import {
  CookieJar,
  EXAMPLE_APPS,
  exchange,
  formBody,
  installAndBuild,
  sameOrigin,
  setCookieLine,
  startApp,
  type ExampleApp,
  type RunningApp,
} from "@test/examples/support";

const SUPERUSER = { email: "test@example.com", password: "1234567890" };
const USER = { email: "test@example.com", password: "1234567890" };
const CHANGED_PASSWORD = "1234567890-changed";
const OAUTH_USER_EMAIL = "ssr-oauth@example.com";
const OAUTH_PROVIDER = "oidc";
const LIVE_COLLECTION = "ssr_live";
const TIMEOUT = 600_000;
// a page that redirects (Next.js answers 307 from a server component, the apps' own 303 elsewhere)
const REDIRECTS = [302, 303, 307, 308];

const MODES = [
  { name: "session cookie HttpOnly", readable: false },
  { name: "readable cookie fallback", readable: true },
] as const;

const SERVERS = ["upstream", "iglo"] as const;
type ServerKind = (typeof SERVERS)[number];

interface PocketBase {
  kind: ServerKind;
  url: string;
  stop(): Promise<void>;
}

/** A fresh copy of the fixture, with the OAuth2 provider the scenario signs in with. */
async function freshDataDir(kind: ServerKind): Promise<string> {
  const dataDir = join(tempDir(), kind, "pb_data");
  copyDataDir(fixtureDir, dataDir);
  // the provider's authorization URL is absolute, as a real provider's is (the fixture has none)
  await useProvider(
    { user: { sub: "ssr-example", ...verifiedEmail(OAUTH_USER_EMAIL) } },
    (collection, provider) => {
      for (const config of collection.oauth2.providers ?? []) {
        config.authURL = provider.authURL;
      }
    },
    "users",
  )({ dataDir });
  return dataDir;
}

async function startPocketBase(kind: ServerKind, dataDir: string): Promise<PocketBase> {
  if (kind === "upstream") {
    const up = await startUpstream({ dataDir });
    return { kind, url: up.url, stop: () => up.stop() };
  }
  const ig = await startServer([], dataDir);
  return {
    kind,
    url: ig.url,
    stop: async () => {
      await ig.stop();
    },
  };
}

/** A superuser's token, for the setup requests the scenario makes. */
async function superuserToken(url: string): Promise<string> {
  const res = await fetch(`${url}/api/collections/_superusers/auth-with-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identity: SUPERUSER.email, password: SUPERUSER.password }),
  });
  if (!res.ok) {
    throw new Error(`superuser sign-in on ${url} failed: ${res.status}`);
  }
  return ((await res.json()) as { token: string }).token;
}

async function api(
  url: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${method} ${path} on ${url} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

/** The live collection the browser subscribes to: public, so guests may see its events. */
async function createLiveCollection(pb: PocketBase): Promise<void> {
  const token = await superuserToken(pb.url);
  await api(pb.url, token, "POST", "/api/collections", {
    name: LIVE_COLLECTION,
    type: "base",
    fields: [{ name: "title", type: "text" }],
    listRule: "",
    viewRule: "",
    createRule: "",
    updateRule: "",
    deleteRule: "",
  });
}

/** Changes the user's password through the superuser API: the user's sessions end. */
async function changePassword(pb: PocketBase, password: string): Promise<void> {
  const token = await superuserToken(pb.url);
  const filter = new URLSearchParams({ filter: `email="${USER.email}"` });
  const list = (await api(
    pb.url,
    token,
    "GET",
    `/api/collections/users/records?${filter.toString()}`,
  )) as { items: Array<{ id: string }> };
  const id = list.items[0]?.id;
  if (!id) {
    throw new Error("the fixture user is missing");
  }
  await api(pb.url, token, "PATCH", `/api/collections/users/records/${id}`, {
    password,
    passwordConfirm: password,
  });
}

/** The sign-in form posts to the app's session route (`POST /session/login`). */
function loginForm(app: RunningApp, jar: CookieJar, password: string) {
  return exchange(`${app.url}/session/login`, {
    method: "POST",
    jar,
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...sameOrigin(app.url) },
    body: formBody({ email: USER.email, password }),
  });
}

/** The session token inside the session cookie, the way the app's cookie holds it. */
function sessionTokenOf(jar: CookieJar): string {
  const raw = jar.cookies.get("pb_auth") ?? "";
  const json = JSON.parse(decodeURIComponent(raw)) as { token: string };
  return json.token;
}

/**
 * The scenario: sign-in, the protected page, revalidation after a password change, the renew
 * route, the CSRF rejection, sign-out, and the OAuth2 redirect flow.
 */
async function drive(app: RunningApp, pb: PocketBase, readable: boolean): Promise<void> {
  // signed out
  const jar = new CookieJar();
  const home = await exchange(`${app.url}/`, { jar });
  expect(home.status).toBe(200);
  expect(home.body).toContain("signed out");
  expect((await exchange(`${app.url}/api/me`, { jar })).status).toBe(401);

  // a wrong password signs nobody in
  const wrong = new CookieJar();
  const badLogin = await loginForm(app, wrong, "not-the-password");
  expect(badLogin.status).toBe(303);
  expect(badLogin.location).toBe("/login?error=1");
  expect(setCookieLine(badLogin.setCookies, "pb_auth")).toBeUndefined();

  // sign in: the session cookie, HttpOnly unless this is the readable fallback
  const login = await loginForm(app, jar, USER.password);
  expect(login.status).toBe(303);
  expect(login.location).toBe("/");
  const sessionCookie = setCookieLine(login.setCookies, "pb_auth");
  expect(sessionCookie).toBeDefined();
  expect(/httponly/i.test(sessionCookie ?? "")).toBe(!readable);
  expect(login.headers.get("cache-control")).toContain("no-store");

  const signedIn = await exchange(`${app.url}/`, { jar });
  expect(signedIn.body).toContain(USER.email);
  const me = await exchange(`${app.url}/api/me`, { jar });
  expect(me.status).toBe(200);
  expect((JSON.parse(me.body) as { email: string }).email).toBe(USER.email);

  // the protected page checks the session with iglo.base
  const protectedPage = await exchange(`${app.url}/protected`, { jar });
  expect(protectedPage.status).toBe(200);
  expect(protectedPage.body).toContain(`protected: ${USER.email}`);

  // the live page: in the default mode the long-lived session token never reaches the page
  const live = await exchange(`${app.url}/live`, { jar });
  expect(live.status).toBe(200);
  if (!readable) {
    expect(live.body).not.toContain(sessionTokenOf(jar));
  }

  // pages and APIs that carry the session or the browser token are never stored by a cache
  for (const path of ["/live", "/protected", "/api/me"]) {
    const res = await exchange(`${app.url}${path}`, { jar });
    expect(res.headers.get("cache-control")).toContain("no-store");
  }

  // the renew route: GET is refused, a foreign origin is refused, the same origin renews
  const getRenew = await exchange(`${app.url}/api/pb/renew`, { jar });
  expect(getRenew.status).toBe(405);
  expect(getRenew.headers.get("allow")).toBe("POST");
  const foreignRenew = await exchange(`${app.url}/api/pb/renew`, {
    method: "POST",
    jar,
    headers: sameOrigin("http://evil.example"),
  });
  expect(foreignRenew.status).toBe(403);
  const renew = await exchange(`${app.url}/api/pb/renew`, {
    method: "POST",
    jar,
    headers: sameOrigin(app.url),
  });
  expect(renew.status).toBe(200);
  expect(renew.headers.get("cache-control")).toContain("no-store");
  const renewed = JSON.parse(renew.body) as {
    token: unknown;
    record: { email?: string };
    expiresAt: unknown;
    serverTime: unknown;
  };
  expect(typeof renewed.token).toBe("string");
  expect(renewed.record.email).toBe(USER.email);
  expect(typeof renewed.expiresAt).toBe("number");
  expect(typeof renewed.serverTime).toBe("number");

  // CSRF: a cross-origin POST with the session cookie is refused, and the session survives it
  const crossSite = await exchange(`${app.url}/logout`, {
    method: "POST",
    jar,
    headers: sameOrigin("http://evil.example"),
  });
  expect(crossSite.status).toBe(403);
  expect((await exchange(`${app.url}/protected`, { jar })).status).toBe(200);

  // revalidation: the password changes on the server. The protected page checks with iglo.base,
  // and the revoked session ends. (Whether the home page answers from the session cache before
  // that check depends on token timing, so the test does not assert it: the unit tests cover the
  // cache with an injected clock.)
  await changePassword(pb, CHANGED_PASSWORD);
  const revoked = await exchange(`${app.url}/protected`, { jar });
  expect(REDIRECTS).toContain(revoked.status);
  expect(revoked.location).toStartWith("/login");
  // the next read of the home page is signed out
  const afterCheck = await exchange(`${app.url}/`, { jar });
  expect(afterCheck.body).toContain("signed out");
  // the API route answers for the revoked session too (a page cannot always clear its cookie:
  // a Next.js server component is read-only)
  expect((await exchange(`${app.url}/api/me`, { jar })).status).toBe(401);

  // the new password signs in again
  const again = await loginForm(app, jar, CHANGED_PASSWORD);
  expect(again.status).toBe(303);
  expect((await exchange(`${app.url}/protected`, { jar })).status).toBe(200);

  // sign-out with the app's own origin clears the session
  const logout = await exchange(`${app.url}/logout`, {
    method: "POST",
    jar,
    headers: sameOrigin(app.url),
  });
  expect(logout.status).toBe(303);
  expect(logout.location).toBe("/");
  expect(jar.cookies.has("pb_auth")).toBe(false);
  expect(REDIRECTS).toContain((await exchange(`${app.url}/protected`, { jar })).status);

  // OAuth2 redirect flow against the fake provider, started from the app's login page: the page
  // offers the provider, its link starts the flow, and the callback with the provider's code ends it
  const oauthJar = new CookieJar();
  const loginPage = await exchange(`${app.url}/login`, { jar: oauthJar });
  expect(loginPage.status).toBe(200);
  const startPath = new RegExp(`href="(/api/pb/oauth2/start/${OAUTH_PROVIDER})"`).exec(
    loginPage.body,
  )?.[1];
  if (startPath === undefined) {
    throw new Error(`the login page offers no ${OAUTH_PROVIDER} link: ${loginPage.body}`);
  }
  expect(loginPage.body).toContain("Sign in with");
  const start = await exchange(`${app.url}${startPath}`, { jar: oauthJar });
  if (start.status !== 302) {
    throw new Error(`OAuth2 start answered ${start.status}: ${start.body}`);
  }
  // the fake provider's authURL is absolute (freshDataDir); the start route sends the browser there
  // with the app's callback as redirect_uri
  const authorize = new URL(start.location ?? "");
  expect(authorize.searchParams.get("redirect_uri")).toBe(`${app.url}/api/pb/oauth2/callback`);
  expect(setCookieLine(start.setCookies, "pb_oauth2")).toBeDefined();
  const state = authorize.searchParams.get("state") ?? "";
  expect(state).not.toBe("");

  const callback = await exchange(
    `${app.url}/api/pb/oauth2/callback?code=123&state=${encodeURIComponent(state)}`,
    { jar: oauthJar },
  );
  expect(callback.status).toBe(302);
  expect(new URL(callback.location ?? "", app.url).pathname).toBe("/");
  expect(setCookieLine(callback.setCookies, "pb_auth")).toBeDefined();
  const oauthHome = await exchange(`${app.url}/`, { jar: oauthJar });
  expect(oauthHome.body).toContain(`signed in as ${OAUTH_USER_EMAIL}`);
  const oauthMe = await exchange(`${app.url}/api/me`, { jar: oauthJar });
  expect((JSON.parse(oauthMe.body) as { email: string }).email).toBe(OAUTH_USER_EMAIL);

  // a callback with a state the browser never started is refused, and the flow ends there
  const forged = await exchange(`${app.url}/api/pb/oauth2/callback?code=123&state=forged`, {
    jar: new CookieJar(),
  });
  expect(forged.status).toBe(302);
  expect(forged.location).toContain("oauth2_error=");
}

/** The realtime check in a real browser: a record created on the server reaches the live page. */
async function realtimeInBrowser(app: RunningApp, pb: PocketBase): Promise<void> {
  const browser = new Browser();
  try {
    await browser.open(`${app.url}/login`);
    await browser.run(
      "eval",
      `(() => {
        document.querySelector('input[name="email"]').value = ${JSON.stringify(USER.email)};
        document.querySelector('input[name="password"]').value = ${JSON.stringify(USER.password)};
        document.querySelector("form").requestSubmit();
        return "submitted";
      })()`,
    );
    await browser.waitForText("signed in as");
    await browser.open(`${app.url}/live`);
    await browser.waitForText("subscribed");

    const token = await superuserToken(pb.url);
    const created = (await api(
      pb.url,
      token,
      "POST",
      `/api/collections/${LIVE_COLLECTION}/records`,
      {
        id: "ssrlive00000001",
        title: "hello from the server",
      },
    )) as { id: string };
    await browser.waitForText(created.id);
  } finally {
    await browser.close();
  }
}

for (const app of EXAMPLE_APPS as readonly ExampleApp[]) {
  describe(`example ${app.name}`, () => {
    beforeAll(() => installAndBuild(app), TIMEOUT);

    for (const mode of MODES) {
      for (const server of SERVERS) {
        test(
          `${mode.name} against ${server}`,
          async () => {
            const dataDir = await freshDataDir(server);
            const pb = await startPocketBase(server, dataDir);
            try {
              await createLiveCollection(pb);
              const env: Record<string, string> = { PB_URL: pb.url, PB_PUBLIC_URL: pb.url };
              if (mode.readable) {
                env["PB_READABLE_COOKIE"] = "1";
              } else {
                env["PB_SUPERUSER_EMAIL"] = SUPERUSER.email;
                env["PB_SUPERUSER_PASSWORD"] = SUPERUSER.password;
              }
              const running = await startApp(app, env);
              try {
                await drive(running, pb, mode.readable).catch((err: unknown) => {
                  throw new Error(
                    `${err instanceof Error ? err.message : String(err)}\n--- ${app.name} output:\n${running.output()}`,
                    { cause: err },
                  );
                });
              } finally {
                await running.stop();
              }
            } finally {
              await pb.stop();
            }
          },
          TIMEOUT,
        );
      }
    }

    test(
      "a realtime event reaches the live page in a browser (iglo.base)",
      async () => {
        const dataDir = await freshDataDir("iglo");
        const pb = await startPocketBase("iglo", dataDir);
        try {
          await createLiveCollection(pb);
          const running = await startApp(app, {
            PB_URL: pb.url,
            PB_PUBLIC_URL: pb.url,
            PB_SUPERUSER_EMAIL: SUPERUSER.email,
            PB_SUPERUSER_PASSWORD: SUPERUSER.password,
          });
          try {
            await realtimeInBrowser(running, pb).catch((err: unknown) => {
              throw new Error(
                `${err instanceof Error ? err.message : String(err)}\n--- ${app.name} output:\n${running.output()}`,
                { cause: err },
              );
            });
          } finally {
            await running.stop();
          }
        } finally {
          await pb.stop();
        }
      },
      TIMEOUT,
    );
  });
}
