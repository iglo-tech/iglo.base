// docs/design/13-ssr.md ("Browser client and realtime", "OAuth2": popup flow, "CSRF").
//
// The browser entry, `iglo.base/ssr/browser`. It is browser-safe: no server client, no
// superuser client, no Bun-only API. It returns a normal SDK Client, so `instanceof` checks
// and the realtime and collection services are the main entry's own.
import Client from "@sdk/Client";
import { ClientResponseError } from "@sdk/ClientResponseError";
import { BaseAuthStore, type AuthRecord } from "@sdk/stores/BaseAuthStore";
import { cookieParse } from "@sdk/tools/cookie";
import { getTokenPayload } from "@sdk/tools/jwt";
import type { Loose } from "@sdk/tools/loose";
import type { SendOptions } from "@sdk/tools/options";
import {
  DEFAULT_COOKIE_KEY,
  cookieWireName,
  parseSessionValue,
  recordForToken,
} from "@sdk/ssr/cookies";
import type { FetchFunction } from "@sdk/ssr/no-store-fetch";

/** The token is renewed when this fraction of its remaining lifetime is left... */
const RENEW_FRACTION = 0.5;
/** ...but never later than this before its expiry. */
const RENEW_BEFORE_EXPIRY_MS = 60_000;
/** Renewals closer together than this are not scheduled (guards a very short token). */
const MIN_RENEW_DELAY_MS = 1_000;
/** Retry backoff after a network error or a 5xx: doubles from the base, capped. */
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;

const RENEW_REQUEST: RequestInit = {
  method: "POST",
  cache: "no-store",
  credentials: "same-origin",
  headers: { Accept: "application/json" },
};

/** The timers the client uses. Injected by tests, which run without sleeping. */
export interface BrowserTimers {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export interface CreateBrowserClientOptions {
  url: string;
  /** The browser token from the page (`mintBrowserToken`). Without it, the readable cookie is read. */
  token?: string;
  /** The user record that goes with `token`. Dropped when its id is not the token's. */
  record?: AuthRecord;
  /** The adapter route that renews the token (`handleBrowserTokenRenew`). Without it, no renewal. */
  renewUrl?: string;
  /** The adapter route that completes a popup sign-in (`handlePopupHandOff`). */
  handOffUrl?: string;
  /** The session cookie's base name, for reading the readable cookie (default `pb_auth`). */
  cookieName?: string;
  clock?: () => number;
  timers?: BrowserTimers;
  fetch?: FetchFunction;
  lang?: string;
}

const defaultTimers: BrowserTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** A failed request that never got a response: a network error, status 0. */
function networkError(url: string, err: unknown): ClientResponseError {
  return new ClientResponseError({ url, status: 0, data: {}, originalError: err });
}

/** The error for an answer that is not a success. */
async function responseError(url: string, res: Response): Promise<ClientResponseError> {
  let data: unknown = {};
  try {
    data = await res.json();
  } catch {
    // not JSON: the status is the error
  }
  return new ClientResponseError({ url, status: res.status, data });
}

/**
 * The readable session cookie, read from `document.cookie` (fallback mode). Its name follows the
 * rule the server writes it under: `__Host-` on https, the plain name otherwise.
 */
function readSessionCookie(baseName: string): { token: string; record: AuthRecord } | undefined {
  const scope = globalThis as {
    document?: { cookie?: string };
    location?: { protocol?: string };
  };
  const raw = scope.document?.cookie;
  if (!raw) {
    return undefined;
  }
  const wireName = cookieWireName(baseName, scope.location?.protocol === "https:");
  const value = cookieParse(raw)[wireName];
  if (typeof value !== "string" || value === "") {
    return undefined;
  }
  const session = parseSessionValue(value);
  if (!session) {
    return undefined;
  }
  return { token: session.token, record: recordForToken(session.token, session.record) };
}

/**
 * The SDK client for a page. It holds a short browser token, renews it before it expires,
 * keeps its realtime subscriptions authorized across renewals, and hands a popup token off to
 * the server. Create it with `createBrowserClient`.
 */
export class BrowserClient extends Client {
  private readonly _options: CreateBrowserClientOptions;
  private readonly _clock: () => number;
  private readonly _timers: BrowserTimers;
  private _timer: unknown = undefined;
  private _retries: number = 0;
  private _renewing: Promise<void> | undefined = undefined;
  private _disposed: boolean = false;

  constructor(options: CreateBrowserClientOptions) {
    super(options.url, new BaseAuthStore(), options.lang ?? "en-US");
    this._options = options;
    this._clock = options.clock ?? Date.now;
    this._timers = options.timers ?? defaultTimers;

    const seeded = options.token
      ? {
          token: options.token,
          record: recordForToken(options.token, options.record ?? null),
        }
      : readSessionCookie(options.cookieName ?? DEFAULT_COOKIE_KEY);
    if (seeded) {
      this.authStore.save(seeded.token, seeded.record);
    }

    // every change of the token (renewal, sign-out, expiry) reschedules the renewal and
    // resubmits the realtime subscriptions with the new authorization
    this.authStore.onChange(() => this._authChanged());
    this._schedule();
  }

  /** Sends with the injected fetch (if any) unless the request names its own. */
  override async send<T = Loose>(path: string, options: SendOptions): Promise<T> {
    if (options && !options.fetch && this._options.fetch) {
      options.fetch = this._options.fetch;
    }
    return super.send<T>(path, options);
  }

  /**
   * Renews the browser token now, through the renew route. Parallel callers, and the timers,
   * share one request. A 401 clears the auth store. A network error or 5xx keeps the token and
   * retries with a bounded backoff until it expires.
   *
   * @throws {ClientResponseError} when the request fails (status 0 for a network error), or
   *   when no `renewUrl` is set
   */
  renew(): Promise<void> {
    if (!this._options.renewUrl) {
      return Promise.reject(new TypeError("renewUrl is not set"));
    }
    if (!this._renewing) {
      this._renewing = this._renewOnce().finally(() => {
        this._renewing = undefined;
      });
    }
    return this._renewing;
  }

  /**
   * After `authWithOAuth2()` in a popup: posts the popup's token to the hand-off route, which
   * writes the HttpOnly session cookie, then renews the token. The long-lived popup token is
   * replaced in page memory by the short minted one. If the renewal then fails, the store is
   * cleared rather than keeping the popup token.
   *
   * @throws {ClientResponseError} when the hand-off or the renewal is refused or fails
   */
  async handOff(): Promise<void> {
    const url = this._options.handOffUrl;
    if (!url || !this._options.renewUrl) {
      throw new TypeError("handOffUrl and renewUrl are both needed");
    }
    const token = this.authStore.token;
    if (!token) {
      throw new ClientResponseError({ status: 401, data: { message: "There is no sign-in." } });
    }

    let res: Response;
    try {
      res = await this._fetch(url, {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ token }),
      });
    } catch (err: unknown) {
      throw networkError(url, err);
    }
    if (res.status === 401) {
      // the popup's token was revoked: the sign-in is over
      if (this.authStore.token === token) {
        this.authStore.clear();
      }
      throw await responseError(url, res);
    }
    if (!res.ok) {
      throw await responseError(url, res);
    }

    try {
      await this.renew();
    } catch (err: unknown) {
      this.authStore.clear();
      throw err;
    }
  }

  /** Stops the renewal timers. The client keeps working; it just stops renewing. */
  dispose(): void {
    this._disposed = true;
    this._cancelTimer();
  }

  private _fetch(url: string, init: RequestInit): Promise<Response> {
    return (this._options.fetch ?? globalThis.fetch)(url, init);
  }

  private _expiresAt(): number | undefined {
    const exp = getTokenPayload(this.authStore.token).exp;
    return typeof exp === "number" && exp > 0 ? exp * 1000 : undefined;
  }

  private _authChanged(): void {
    this._retries = 0;
    this._schedule();
    this.realtime.resubmit().catch(() => {});
  }

  private _schedule(): void {
    this._cancelTimer();
    if (this._disposed || !this._options.renewUrl) {
      return;
    }
    const expiresAt = this._expiresAt();
    if (expiresAt === undefined) {
      return;
    }
    const remaining = expiresAt - this._clock();
    const delay = Math.max(
      MIN_RENEW_DELAY_MS,
      Math.min(remaining * RENEW_FRACTION, remaining - RENEW_BEFORE_EXPIRY_MS),
    );
    this._setTimer(delay, () => {
      this.renew().catch(() => {});
    });
  }

  /** After a network error or a 5xx: retries with backoff, or ends the token at its expiry. */
  private _retryLater(): void {
    const expiresAt = this._expiresAt();
    if (this._disposed || expiresAt === undefined) {
      return;
    }
    const attempt = ++this._retries;
    const backoff = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
    const now = this._clock();
    if (now + backoff >= expiresAt) {
      // no further attempt fits before the token ends
      this._setTimer(Math.max(0, expiresAt - now), () => {
        this.authStore.clear();
      });
      return;
    }
    this._setTimer(backoff, () => {
      this.renew().catch(() => {});
    });
  }

  private async _renewOnce(): Promise<void> {
    const url = this._options.renewUrl ?? "";
    const before = this.authStore.token;

    let res: Response;
    try {
      res = await this._fetch(url, RENEW_REQUEST);
    } catch (err: unknown) {
      this._retryLater();
      throw networkError(url, err);
    }

    if (res.status === 401) {
      // the session is over (revoked, expired or deleted): the client continues as a guest
      if (this.authStore.token === before) {
        this.authStore.clear();
      }
      throw await responseError(url, res);
    }
    if (res.status >= 500) {
      this._retryLater();
      throw await responseError(url, res);
    }
    if (!res.ok) {
      // a route that is not there or refuses this origin: keep the token, do not retry
      throw await responseError(url, res);
    }

    let body: { token?: unknown; record?: unknown };
    try {
      body = (await res.json()) as { token?: unknown; record?: unknown };
    } catch (err: unknown) {
      this._retryLater();
      throw networkError(url, err);
    }
    if (typeof body.token !== "string" || body.token === "") {
      throw new ClientResponseError({ url, status: res.status, data: body });
    }
    if (this.authStore.token !== before) {
      // the session changed while this renewal was in flight (a sign-out or a new sign-in)
      return;
    }
    const record = (body.record ?? null) as AuthRecord;
    this.authStore.save(body.token, recordForToken(body.token, record));
  }

  private _setTimer(ms: number, callback: () => void): void {
    this._cancelTimer();
    this._timer = this._timers.setTimeout(() => {
      this._timer = undefined;
      callback();
    }, ms);
  }

  private _cancelTimer(): void {
    if (this._timer !== undefined) {
      this._timers.clearTimeout(this._timer);
      this._timer = undefined;
    }
  }
}

/**
 * Creates the browser client for a page. Pass the token and record from `mintBrowserToken`,
 * which the page gets at render, and the renew route's URL. Without a token, the readable
 * session cookie (fallback mode) is read.
 */
export function createBrowserClient(options: CreateBrowserClientOptions): BrowserClient {
  return new BrowserClient(options);
}
