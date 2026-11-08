// docs/design/13-ssr.md ("Clients", "Session cookie", "Session cache, check and refresh")
import Client from "@sdk/Client";
import { ClientResponseError } from "@sdk/ClientResponseError";
import { BaseAuthStore, type AuthRecord } from "@sdk/stores/BaseAuthStore";
import { getTokenPayload } from "@sdk/tools/jwt";
import type { RecordModel } from "@sdk/tools/dtos";
import type { SendOptions } from "@sdk/tools/options";
import type { Loose, LooseObject } from "@sdk/tools/loose";
import type { RecordAuthResponse } from "@sdk/services/RecordService";
import type {
  Cookie,
  CookieAdapter,
  CookieToSet,
  CookieValueMap,
  CompleteOAuth2Result,
  CreateServerClientOptions,
  SessionCache,
  StartOAuth2Options,
} from "@sdk/ssr/types";
import {
  DEFAULT_COOKIE_KEY,
  OAUTH2_COOKIE_KEY,
  SSR_NO_CACHE_HEADERS,
  buildClearedOAuth2Cookies,
  buildClearedSessionCookies,
  buildOAuth2CookieToSet,
  buildSessionCookieToSet,
  findSessionCookie,
  type CookieSettings,
  isHttpLocalUrl,
  normalizeCookies,
  parseSessionValue,
} from "@sdk/ssr/cookies";
import { noStoreFetch } from "@sdk/ssr/no-store-fetch";
import {
  DEFAULT_OAUTH2_COLLECTION,
  OAUTH2_STATE_TTL_MS,
  OAuth2Error,
  constantTimeEqual,
  parseOAuth2Cookie,
  safeRedirectPath,
  validateCallbackUrl,
  withRedirectUri,
  type OAuth2Pending,
} from "@sdk/ssr/oauth2";

/** Tokens past their `exp` by up to this many seconds still count as valid (clock skew). */
const CLOCK_SKEW_SEC = 60;

/**
 * Only the responses that create or renew the caller's own session teach a collection's
 * token lifetime. Other endpoints can return tokens with other lifetimes (`files/token`
 * returns a 180-second file token; `impersonate` returns a non-refreshable one).
 */
const SESSION_RESPONSE_PATH = /\/auth-(?:with-password|with-otp|with-oauth2|refresh)$/;

/**
 * What one `auth-refresh` flight found. It is shared by every request that joined the
 * flight; each request applies it to its own client, auth store and cookies.
 */
type RefreshOutcome =
  | { kind: "ok"; token: string; record: AuthRecord }
  | { kind: "revoked"; error: ClientResponseError }
  | { kind: "transient"; error: unknown };

function unauthorized(message: string): ClientResponseError {
  return new ClientResponseError({ status: 401, data: { message } });
}

/** The key that ties a token to its collection's learned lifetime. */
function collectionKey(payload: LooseObject, record: AuthRecord | undefined | null): string {
  return payload.collectionId || record?.collectionId || record?.collectionName || "";
}

/** A record that belongs to another token is dropped; a cookie can be edited by its user. */
function matchRecord(token: string, record: AuthRecord): AuthRecord {
  const payload = getTokenPayload(token);
  if (record && payload.id && record.id !== payload.id) {
    return null;
  }
  return record;
}

function resolveSecure(options: CreateServerClientOptions): boolean {
  if (options.secure !== undefined) {
    return options.secure;
  }
  if (options.cookies.isSecure !== undefined) {
    return options.cookies.isSecure;
  }
  if (options.origin) {
    return !isHttpLocalUrl(options.origin);
  }
  if (options.request) {
    return !isHttpLocalUrl(options.request.url);
  }
  // Unknown app origin: secure by default. Apps on http://localhost pass `origin` or `request`.
  return true;
}

export class ServerClient extends Client {
  readonly cookies: CookieAdapter;
  private readonly _cookieName: string;
  private readonly _isSecure: boolean;
  private readonly _options: CreateServerClientOptions;
  private readonly _clock: () => number;
  private _clockOffsetMs: number = 0;
  private _initialized: boolean = false;
  // true while this client applies a change it made itself; the auth-store listener skips it
  private _applying: boolean = false;
  private _lastToken: string = "";

  readonly auth: {
    /** Checks the session with iglo.base now, bypassing the cache. Throws when it is not valid. */
    verify: () => Promise<AuthRecord>;
  };

  constructor(options: CreateServerClientOptions) {
    const authStore = new BaseAuthStore();
    super(options.url, authStore, options.lang ?? "en-US");

    this._options = options;
    this.cookies = options.cookies;
    this._cookieName = options.cookieName ?? DEFAULT_COOKIE_KEY;
    this._clock = options.clock ?? Date.now;
    this._clockOffsetMs = options.sessionCache?.clockOffsetMs ?? 0;
    this._isSecure = resolveSecure(options);

    this.autoCancellation(false);

    // Auth changes the app makes on this client (authWithPassword, authStore.clear(), ...)
    // write or clear the cookie and update the cache. Changes made by this client during a
    // check go through `_applying` and write the cookie once, in `_applyOutcome`.
    this.authStore.onChange((token, record) => {
      if (!this._initialized || this._applying) {
        return;
      }
      if (token) {
        this._saveSession(token, record, true);
      } else {
        this._dropSession(this._lastToken);
      }
    });

    this.auth = {
      verify: () => this._checkSession(true),
    };
  }

  /**
   * Every request goes through here: `cache: "no-store"` is applied at the fetch layer,
   * and the server's clock and the collection lifetime are read from each response.
   */
  override async send<T = Loose>(path: string, options: SendOptions): Promise<T> {
    const seen: { date?: string | null } = {};
    options.fetch = noStoreFetch(options.fetch ?? this._options.fetch, (response) => {
      seen.date = response.headers.get("date");
    });
    const data = await super.send<T>(path, options);
    this._observeResponse(path, seen.date, data);
    return data;
  }

  /** Reads the cookie, then checks or refreshes the session. */
  async init(): Promise<this> {
    await this._loadCookieAndCheck();
    this._initialized = true;
    return this;
  }

  /**
   * OAuth2 redirect flow, step 1 (docs/design/13-ssr.md, "OAuth2"). Reads the provider's
   * authorization URL, which carries the server's `state` and PKCE challenge, and stores the
   * state, the PKCE verifier, the provider and `redirectTo` in the temporary cookie (10 minutes).
   * Returns the URL with `callbackUrl` as its `redirect_uri`. The caller redirects to it and
   * applies the adapter's cookies to that response.
   *
   * @throws {OAuth2Error} `unknown-provider`, `invalid-callback` or `no-cookie-writer`
   * @throws {ClientResponseError} when iglo.base refuses the auth methods
   */
  async startOAuth2(provider: string, options: StartOAuth2Options): Promise<string> {
    const callbackUrl = validateCallbackUrl(options.callbackUrl);
    const collection = options.collection ?? DEFAULT_OAUTH2_COLLECTION;
    if (!this.cookies.setAll) {
      throw new OAuth2Error("no-cookie-writer", "The cookie adapter cannot write cookies.");
    }

    const methods = await this.collection(collection).listAuthMethods();
    const info = methods.oauth2?.enabled
      ? methods.oauth2.providers.find((p) => p.name === provider)
      : undefined;
    if (!info) {
      throw new OAuth2Error(
        "unknown-provider",
        `OAuth2 provider "${provider}" is not enabled for the ${collection} collection.`,
      );
    }

    const pending: OAuth2Pending = {
      state: info.state,
      codeVerifier: info.codeVerifier ?? "",
      provider,
      collection,
      redirectURL: callbackUrl,
      redirectTo: safeRedirectPath(options.redirectTo ?? "/"),
      exp: this._clock() + OAUTH2_STATE_TTL_MS,
    };
    await this.cookies.setAll(
      [buildOAuth2CookieToSet(JSON.stringify(pending), this._cookieSettings())],
      { ...SSR_NO_CACHE_HEADERS },
    );
    return withRedirectUri(info.authURL, callbackUrl);
  }

  /**
   * OAuth2 redirect flow, step 2: the callback route. Reads `code`, `state` and `error` from the
   * callback URL and checks `state` against the temporary cookie. On success it exchanges the
   * code, which writes the session cookie as any sign-in does. The temporary cookie is deleted
   * on every outcome. Failures are returned, not thrown, with `redirectTo` for the caller.
   *
   * @throws only for failures that are not about this sign-in (a network error, a bug)
   */
  async completeOAuth2(input: string | URL | { url: string }): Promise<CompleteOAuth2Result> {
    const callback = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    try {
      const pending = await this._readOAuth2Cookie();
      return await this._finishOAuth2(callback, pending);
    } finally {
      this._writeCookies(buildClearedOAuth2Cookies(this._cookieSettings()));
    }
  }

  private async _readOAuth2Cookie(): Promise<OAuth2Pending | undefined> {
    let rawCookies: unknown;
    try {
      rawCookies = await this.cookies.getAll();
    } catch {
      return undefined;
    }
    const matched = findSessionCookie(
      normalizeCookies(rawCookies as Cookie[] | CookieValueMap),
      OAUTH2_COOKIE_KEY,
    );
    return matched?.value ? parseOAuth2Cookie(matched.value) : undefined;
  }

  private async _finishOAuth2(
    callback: URL,
    pending: OAuth2Pending | undefined,
  ): Promise<CompleteOAuth2Result> {
    const redirectTo = pending ? safeRedirectPath(pending.redirectTo) : "/";
    const fail = (error: OAuth2Error | ClientResponseError): CompleteOAuth2Result => ({
      ok: false,
      redirectTo,
      error,
    });

    if (!pending) {
      return fail(new OAuth2Error("missing-cookie", "The OAuth2 sign-in was not started here."));
    }
    if (this._clock() > pending.exp) {
      return fail(new OAuth2Error("expired", "The OAuth2 sign-in took too long. Start it again."));
    }
    const state = callback.searchParams.get("state") ?? "";
    if (state === "" || !constantTimeEqual(state, pending.state)) {
      return fail(new OAuth2Error("state-mismatch", "The OAuth2 state does not match."));
    }
    const providerError = callback.searchParams.get("error");
    if (providerError !== null) {
      return fail(
        new OAuth2Error(
          "provider-error",
          `The OAuth2 provider returned an error: ${providerError}`,
          providerError,
        ),
      );
    }
    const code = callback.searchParams.get("code") ?? "";
    if (code === "") {
      return fail(new OAuth2Error("missing-code", "The OAuth2 callback has no code."));
    }

    try {
      const auth: RecordAuthResponse = await this.collection(pending.collection).authWithOAuth2Code(
        pending.provider,
        code,
        pending.codeVerifier,
        pending.redirectURL,
      );
      return { ok: true, redirectTo, auth };
    } catch (err: unknown) {
      if (err instanceof ClientResponseError) {
        return fail(err);
      }
      throw err;
    }
  }

  /** The cookie rules of this client's session cookie, for the cookies that follow it. */
  private _cookieSettings(): CookieSettings {
    return {
      secure: this._isSecure,
      cookieName: this._cookieName,
      cookieOptions: this._options.cookieOptions,
    };
  }

  private async _loadCookieAndCheck(): Promise<void> {
    let rawCookies: unknown;
    try {
      rawCookies = await this.cookies.getAll();
    } catch {
      return;
    }

    const matched = findSessionCookie(
      normalizeCookies(rawCookies as Cookie[] | CookieValueMap),
      this._cookieName,
    );
    const session = matched?.value ? parseSessionValue(matched.value) : undefined;
    if (!session) {
      this._setLocalSession("", null);
      return;
    }

    this._lastToken = session.token;
    this._setLocalSession(session.token, matchRecord(session.token, session.record));
    await this._checkSession(false);
  }

  private async _checkSession(force: boolean): Promise<AuthRecord> {
    const token = this.authStore.token;
    if (!token) {
      if (force) {
        throw unauthorized("The request requires valid authentication token.");
      }
      return null;
    }

    const payload = getTokenPayload(token);
    const nowMs = this._clock();
    const nowSec = Math.floor((nowMs + this._clockOffsetMs) / 1000);

    if (payload.exp && nowSec > payload.exp + CLOCK_SKEW_SEC) {
      this._dropSession(token);
      if (force) {
        throw unauthorized("The token is expired.");
      }
      return null;
    }

    const cache = this._options.sessionCache;
    if (cache && !force) {
      const cached = await cache.get(token);
      const lifetime = cache.getCollectionLifetime(collectionKey(payload, this.authStore.record));
      // Lifetime unknown (first check in this process): refresh once to learn it.
      if (cached && lifetime && nowMs - cached.checkedAt < cache.ttl) {
        const remaining = payload.exp ? payload.exp - nowSec : 0;
        if (remaining >= lifetime / 2) {
          this._setLocalSession(token, cached.record);
          return cached.record;
        }
      }
    }

    const outcome = cache
      ? await cache.runSingleFlight(token, () => this._requestRefresh(token))
      : await this._requestRefresh(token);
    return this._applyOutcome(token, outcome, force, cache, nowMs);
  }

  /** One `auth-refresh` for the token. Runs once per flight; see `RefreshOutcome`. */
  private async _requestRefresh(token: string): Promise<RefreshOutcome> {
    const payload = getTokenPayload(token);
    const collection =
      this.authStore.record?.collectionName ||
      this.authStore.record?.collectionId ||
      payload.collectionId ||
      (this.authStore.isSuperuser ? "_superusers" : "users");

    try {
      const res = await this.send<{ token: string; record: RecordModel }>(
        `/api/collections/${encodeURIComponent(collection)}/auth-refresh`,
        { method: "POST", headers: { Authorization: token } },
      );
      return {
        kind: "ok",
        token: res?.token || token,
        record: (res?.record as AuthRecord) ?? this.authStore.record,
      };
    } catch (err: unknown) {
      if (
        err instanceof ClientResponseError &&
        (err.status === 401 || err.status === 403 || err.status === 404)
      ) {
        return { kind: "revoked", error: err };
      }
      return { kind: "transient", error: err };
    }
  }

  private async _applyOutcome(
    token: string,
    outcome: RefreshOutcome,
    force: boolean,
    cache: SessionCache | undefined,
    checkedAtMs: number,
  ): Promise<AuthRecord> {
    switch (outcome.kind) {
      case "ok": {
        const record = matchRecord(outcome.token, outcome.record);
        const changed = outcome.token !== token;
        if (cache) {
          if (changed) {
            await cache.delete(token);
          }
          await cache.set(outcome.token, record, checkedAtMs);
        }
        this._setLocalSession(outcome.token, record, changed);
        return record;
      }

      case "revoked":
        // 401/403/404: the session is over for this request and its cookie is cleared
        this._dropSession(token);
        if (force) {
          throw outcome.error;
        }
        return null;

      case "transient":
        // Network error or 5xx: keep the session, do not touch the cookie or the cache
        if (force) {
          throw outcome.error;
        }
        return this.authStore.record;
    }
  }

  /** Sets the auth store without triggering the listener; optionally writes the cookie. */
  private _setLocalSession(token: string, record: AuthRecord, writeCookie: boolean = false): void {
    this._lastToken = token;
    this._applyLocally(() => {
      if (token) {
        this.authStore.save(token, record);
      } else {
        this.authStore.clear();
      }
    });
    if (token && writeCookie) {
      this._writeCookie(token, record);
    }
  }

  /** A change made by the app on this client: update the cache and the cookie. */
  private _saveSession(token: string, record: AuthRecord, writeCookie: boolean): void {
    const matched = matchRecord(token, record);
    this._setLocalSession(token, matched, writeCookie);
    this._options.sessionCache?.set(token, matched, this._clock()).catch(() => {});
  }

  /** Ends the session on this client: the auth store, the cache entry and the cookie. */
  private _dropSession(token: string): void {
    this._setLocalSession("", null);
    if (token) {
      this._options.sessionCache?.delete(token).catch(() => {});
    }
    this._writeCookies(
      buildClearedSessionCookies({
        cookieName: this._cookieName,
        secure: this._isSecure,
        cookieOptions: this._options.cookieOptions,
      }),
    );
  }

  private _applyLocally(fn: () => void): void {
    const was = this._applying;
    this._applying = true;
    try {
      fn();
    } finally {
      this._applying = was;
    }
  }

  private _writeCookie(token: string, record: AuthRecord): void {
    const payload = getTokenPayload(token);
    const nowSec = Math.floor((this._clock() + this._clockOffsetMs) / 1000);
    this._writeCookies([
      buildSessionCookieToSet(token, record, {
        cookieName: this._cookieName,
        secure: this._isSecure,
        nowSeconds: nowSec,
        exp: payload.exp,
        cookieOptions: this._options.cookieOptions,
      }),
    ]);
  }

  private _writeCookies(cookies: CookieToSet[]): void {
    if (!this.cookies.setAll) {
      return;
    }
    try {
      // Next.js Server Components throw here (cookies are read-only); the request still answers
      Promise.resolve(this.cookies.setAll(cookies, { ...SSR_NO_CACHE_HEADERS })).catch(() => {});
    } catch {
      // see above
    }
  }

  /**
   * Learns the server's clock from every response, and the collection's token lifetime from
   * a session response (see `SESSION_RESPONSE_PATH`).
   */
  private _observeResponse(path: string, dateHeader: string | null | undefined, data: Loose): void {
    const serverMs = dateHeader ? Date.parse(dateHeader) : NaN;
    if (Number.isNaN(serverMs)) {
      return;
    }
    this._clockOffsetMs = serverMs - this._clock();
    if (this._options.sessionCache) {
      this._options.sessionCache.clockOffsetMs = this._clockOffsetMs;
    }

    const body = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
    const token = typeof body["token"] === "string" ? body["token"] : "";
    if (!token || !SESSION_RESPONSE_PATH.test(path)) {
      return;
    }
    const payload = getTokenPayload(token);
    // Only a session token of an auth collection, for the record it names, describes the
    // collection's lifetime. Impersonate tokens are not refreshable (refreshable: false).
    if (payload.type !== "auth" || !payload.exp || payload.refreshable === false) {
      return;
    }
    const record = body["record"] as AuthRecord;
    if (!record || record.id !== payload.id) {
      return;
    }
    const lifetime = payload.exp - Math.floor(serverMs / 1000);
    const key = collectionKey(payload, record);
    if (lifetime > 0 && key) {
      this._options.sessionCache?.setCollectionLifetime(key, lifetime);
    }
  }
}

export async function createServerClient(
  options: CreateServerClientOptions,
): Promise<ServerClient> {
  const client = new ServerClient(options);
  await client.init();
  return client;
}
