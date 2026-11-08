// docs/design/13-ssr.md ("OAuth2", "CSRF"). The SDK's SSR OAuth2 helpers and popup hand-off, run against
// upstream PocketBase v0.41.0 and iglo.base with the fake provider of test/differential/auth/.
// Every recorded value is the same on both servers; tokens, generated ids and the random state
// are checked for their shape and not recorded.

import { describe, expect } from "bun:test";
import {
  createRequestCookieAdapter,
  createServerClient,
  createSessionCache,
  handlePopupHandOff,
  OAuth2Error,
  type CompleteOAuth2Result,
} from "iglo.base/ssr";
import { password, sdkTest, type SdkEnv } from "@test/differential/sdk/harness";
import { Browser } from "@test/differential/sdk-ssr/browser";
import { useProvider, verifiedEmail } from "@test/scenarios/record-auth-oauth2";
import type { MockProvider } from "@test/support/oauth2-mock";

const APP = "http://localhost:3000";
const CALLBACK = `${APP}/callback`;
const EMAIL = "ssr-oauth@example.com";
const TIMEOUT = 120_000;

// each server's provider, by its data directory (the prepare step runs once per server)
const providers = new Map<string, MockProvider>();

function prepareProvider() {
  return ({ dataDir }: { dataDir: string }) => {
    useProvider(
      { user: { sub: "ssr-redirect", ...verifiedEmail(EMAIL) } },
      undefined,
      "users",
      (p) => providers.set(dataDir, p),
    )({ dataDir });
  };
}

function providerOf(env: SdkEnv): MockProvider {
  const provider = providers.get(env.dataDir);
  if (provider === undefined) {
    throw new Error("no provider for this server");
  }
  return provider;
}

// the set-cookie headers as shapes: the name and the attributes, not the value
function cookieShapes(response: Response): string[] {
  return response.headers
    .getSetCookie()
    .map((line) =>
      line
        .replace(/^([^=]+)=[^;]*/, "$1=<value>")
        .replace(/Max-Age=\d+/i, "Max-Age=<n>")
        // both servers derive Expires from the token's exp, issued a second apart
        .replace(/Expires=[^;]+/i, "Expires=<date>"),
    )
    .toSorted();
}

const post = (body: unknown, origin: string | null = APP): Request => {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (origin !== null) {
    headers["Origin"] = origin;
  }
  return new Request(`${APP}/api/popup-sign-in`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
};

function parseCookieJson(value: string | undefined): Record<string, unknown> {
  return JSON.parse(decodeURIComponent(value ?? "{}")) as Record<string, unknown>;
}

describe("SSR OAuth2 and CSRF differential", () => {
  sdkTest(
    "the redirect flow signs a user in, and the next request sees that user from the cookie",
    { prepare: prepareProvider(), timeout: TIMEOUT },
    async (env) => {
      const provider = providerOf(env);
      const browser = new Browser();
      const cache = createSessionCache();

      // start: the redirect to the provider and the temporary cookie
      const startRequest = browser.request(`${APP}/login`);
      const startCookies = createRequestCookieAdapter(startRequest);
      const startClient = await createServerClient({
        url: env.url,
        cookies: startCookies,
        request: startRequest,
        sessionCache: cache,
      });
      const location = await startClient.startOAuth2("oidc", {
        callbackUrl: CALLBACK,
        redirectTo: "/dashboard",
      });
      const redirect = new Response(null, { status: 302, headers: { Location: location } });
      startCookies.applyToResponse(redirect);
      browser.store(redirect);

      const authorize = new URL(location, "http://placeholder.invalid/");
      env.record("authorization request", {
        redirect_uri: authorize.searchParams.get("redirect_uri"),
        code_challenge_method: authorize.searchParams.get("code_challenge_method"),
        hasCodeChallenge: (authorize.searchParams.get("code_challenge") ?? "") !== "",
        hasState: (authorize.searchParams.get("state") ?? "") !== "",
        temporaryCookie: cookieShapes(redirect).filter(
          (c) => c.startsWith("pb_oauth2=") || c.startsWith("__Host-pb_oauth2="),
        ),
      });

      const state = authorize.searchParams.get("state") ?? "";
      const verifier = String(parseCookieJson(browser.jar.get("pb_oauth2")).codeVerifier ?? "");

      // the provider redirects back to the callback route with a code and the same state
      const callbackRequest = browser.request(`${CALLBACK}?code=123&state=${state}`);
      const callbackCookies = createRequestCookieAdapter(callbackRequest);
      const callbackClient = await createServerClient({
        url: env.url,
        cookies: callbackCookies,
        request: callbackRequest,
        sessionCache: cache,
      });
      const result: CompleteOAuth2Result = await callbackClient.completeOAuth2(callbackRequest.url);
      const done = new Response(null, { status: 302, headers: { Location: result.redirectTo } });
      callbackCookies.applyToResponse(done);
      browser.store(done);

      const tokenRequest = provider.requests.findLast((r) => r.path === "/token");
      const sent = new URLSearchParams(tokenRequest?.body ?? "");
      env.record("token exchange", {
        code_verifier_sent: verifier !== "" && sent.get("code_verifier") === verifier,
        redirect_uri_sent: sent.get("redirect_uri") === CALLBACK,
      });
      env.record("callback", {
        ok: result.ok,
        redirectTo: result.redirectTo,
        email: result.ok ? result.auth.record["email"] : undefined,
        cookies: cookieShapes(done),
      });
      expect(result.ok).toBe(true);

      // the next request resumes the user from the session cookie
      const next = browser.request(`${APP}/dashboard`);
      const nextCookies = createRequestCookieAdapter(next);
      const pb = await createServerClient({
        url: env.url,
        cookies: nextCookies,
        request: next,
        sessionCache: cache,
      });
      const recordId = pb.authStore.record?.id ?? "";
      const listed = await pb.collection("users").getOne(recordId);
      env.record("next request", {
        email: pb.authStore.record?.email,
        valid: pb.authStore.isValid,
        getOne: listed.email,
        temporaryCookieLeft: browser.jar.has("pb_oauth2"),
      });
    },
  );

  sdkTest(
    "a replayed callback fails with a missing cookie and leaves no session",
    { prepare: prepareProvider(), timeout: TIMEOUT },
    async (env) => {
      const provider = providerOf(env);
      const browser = new Browser();
      const startRequest = browser.request(`${APP}/login`);
      const startCookies = createRequestCookieAdapter(startRequest);
      const startClient = await createServerClient({
        url: env.url,
        cookies: startCookies,
        request: startRequest,
      });
      const location = await startClient.startOAuth2("oidc", { callbackUrl: CALLBACK });
      const redirect = new Response(null, { status: 302, headers: { Location: location } });
      startCookies.applyToResponse(redirect);
      browser.store(redirect);
      const state =
        new URL(location, "http://placeholder.invalid/").searchParams.get("state") ?? "";

      const first = browser.request(`${CALLBACK}?code=123&state=${state}`);
      const firstCookies = createRequestCookieAdapter(first);
      const firstClient = await createServerClient({
        url: env.url,
        cookies: firstCookies,
        request: first,
      });
      const firstResult = await firstClient.completeOAuth2(first.url);
      expect(firstResult.ok).toBe(true);
      const exchanges = provider.requests.filter((r) => r.path === "/token").length;

      // the same callback in a browser that has no temporary cookie any more
      const replay = new Browser().request(`${CALLBACK}?code=123&state=${state}`);
      const replayCookies = createRequestCookieAdapter(replay);
      const replayClient = await createServerClient({
        url: env.url,
        cookies: replayCookies,
        request: replay,
      });
      const replayResult = await replayClient.completeOAuth2(replay.url);
      const replayed = replayResult.ok ? undefined : (replayResult.error as OAuth2Error);
      expect(replayResult.ok).toBe(false);
      expect(replayed?.kind).toBe("missing-cookie");

      env.record("replay", {
        ok: replayResult.ok,
        kind: replayed?.kind,
        redirectTo: replayResult.redirectTo,
        sessionCookieWritten: replayCookies.queuedCookies.some((c) => c.name.endsWith("pb_auth")),
        tokenExchangesAfterReplay:
          provider.requests.filter((r) => r.path === "/token").length - exchanges,
      });
    },
  );

  sdkTest(
    "the popup hand-off accepts a token from a real sign-in and rejects it once a password change revokes it",
    { prepare: prepareProvider(), timeout: TIMEOUT },
    async (env) => {
      // a token from a real OAuth2 sign-in (the popup's authWithOAuth2 result)
      const signedIn = await env.derived(
        "oauth2 sign-in",
        () => env.client().collection("users").authWithOAuth2Code("oidc", "123", "", CALLBACK),
        (res) => ({ email: res.record["email"] }),
      );
      const token = signedIn.token;
      const recordId = signedIn.record.id;

      const accepted = await handlePopupHandOff(post({ token }), { url: env.url });
      const acceptedBody = (await accepted.json()) as { record?: { email?: string } };
      expect(accepted.status).toBe(200);
      env.record("hand-off with a fresh token", {
        status: accepted.status,
        email: acceptedBody.record?.email,
        cookies: cookieShapes(accepted),
      });

      const foreign = await handlePopupHandOff(post({ token }, "https://evil.example"), {
        url: env.url,
      });
      env.record("hand-off from a foreign origin", {
        status: foreign.status,
        cookies: cookieShapes(foreign),
      });

      // a password change revokes every token of the user
      await env.derived(
        "password change",
        () =>
          env
            .superuser()
            .collection("users")
            .update(recordId, {
              password: `${password}-changed`,
              passwordConfirm: `${password}-changed`,
            }),
        () => "changed",
      );

      const revoked = await handlePopupHandOff(post({ token }), { url: env.url });
      expect(revoked.status).toBe(401);
      env.record("hand-off with a revoked token", {
        status: revoked.status,
        cookies: cookieShapes(revoked),
      });
    },
  );
});
