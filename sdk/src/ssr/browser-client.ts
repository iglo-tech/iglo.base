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
/** Successful renewals are at least this far apart, whatever the token's lifetime or the clocks say. */
const MIN_RENEW_INTERVAL_MS = 30_000;
/** Retry backoff after a network error or a 5xx: doubles from the base, capped. */
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;
/** Retries in a row before the client stops trying; the store is then cleared at the token's expiry. */
const MAX_RETRIES = 10;
/** The longest delay `setTimeout` takes (2^31 - 1 ms, about 24.8 days). Longer waits are re-armed. */
const MAX_TIMER_MS = 2 ** 31 - 1;

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
  /**
   * The server's clock when `token` was minted (`BrowserToken.serverTime`, in milliseconds). The
   * client measures its own clock against it. Without it the offset is learned from the first
   * renewal, so pass it whenever the page has it.
   */
  serverTime?: number;
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
 * Who a token is for, as the realtime service's server sees it: `collectionId/id`, or `""` for
 * no token (a guest). Two tokens with the same identity are the same record.
 */
function identityOf(token: string): string {
  if (!token) {
    return "";
  }
  const payload = getTokenPayload(token);
  return `${payload.collectionId ?? ""}/${payload.id ?? ""}`;
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
 * keeps its realtime subscriptions authorized as the signed-in user changes, and hands a popup
 * token off to the server. Create it with `createBrowserClient`.
 */
export class BrowserClient extends Client {
  private readonly _options: CreateBrowserClientOptions;
  private readonly _clock: () => number;
  private readonly _timers: BrowserTimers;
  private _timer: unknown = undefined;
  private _retries: number = 0;
  // the renewal in flight, and the token it renews: a new session does not share an old one's request
  private _renewing: { token: string; promise: Promise<void> } | undefined = undefined;
  private _disposed: boolean = false;
  // iglo.base's clock minus this device's clock, learned from `serverTime`
  private _offsetMs: number = 0;
  // when the last successful renewal happened (this device's clock), for the renewal floor
  private _lastRenewedAt: number | undefined = undefined;
  // the identity the realtime connection's authorization was last submitted for
  private _realtimeIdentity: string;

  constructor(options: CreateBrowserClientOptions) {
    super(options.url, new BaseAuthStore(), options.lang ?? "en-US");
    this._options = options;
    this._clock = options.clock ?? Date.now;
    this._timers = options.timers ?? defaultTimers;
    if (options.serverTime !== undefined && Number.isFinite(options.serverTime)) {
      this._offsetMs = options.serverTime - this._clock();
    }

    const seeded = options.token
      ? {
          token: options.token,
          record: recordForToken(options.token, options.record ?? null),
        }
      : readSessionCookie(options.cookieName ?? DEFAULT_COOKIE_KEY);
    if (seeded) {
      this.authStore.save(seeded.token, seeded.record);
    }
    this._realtimeIdentity = identityOf(this.authStore.token);

    // every change of the token (renewal, sign-out, expiry, a new sign-in) reschedules the
    // renewal and brings the realtime connection in line with the new authorization
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
    if (!this._renewing || this._renewing.token !== this.authStore.token) {
      const token = this.authStore.token;
      const promise: Promise<void> = this._renewOnce().finally(() => {
        if (this._renewing?.promise === promise) {
          this._renewing = undefined;
        }
      });
      this._renewing = { token, promise };
    }
    return this._renewing.promise;
  }

  /**
   * After `authWithOAuth2()` in a popup: posts the popup's token to the hand-off route, which
   * writes the HttpOnly session cookie, then renews the token. The long-lived popup token is
   * replaced in page memory by the short minted one. On any failure the popup token is cleared
   * from the store rather than kept.
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

    try {
      await this._postHandOff(url, token);
      await this.renew();
    } catch (err: unknown) {
      // the popup token must not stay in page memory, whatever failed
      if (this.authStore.token === token) {
        this.authStore.clear();
      }
      throw err;
    }
  }

  /** Stops the renewal timers. The client keeps working; it just stops renewing. */
  dispose(): void {
    this._disposed = true;
    this._cancelTimer();
  }

  private async _postHandOff(url: string, token: string): Promise<void> {
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
    if (!res.ok) {
      throw await responseError(url, res);
    }
  }

  private _fetch(url: string, init: RequestInit): Promise<Response> {
    return (this._options.fetch ?? globalThis.fetch)(url, init);
  }

  /** The current token's expiry in the server's clock, in milliseconds. */
  private _expiresAt(): number | undefined {
    const exp = getTokenPayload(this.authStore.token).exp;
    return typeof exp === "number" && Number.isFinite(exp) && exp > 0 ? exp * 1000 : undefined;
  }

  /** This device's clock, moved onto iglo.base's clock. */
  private _serverNow(): number {
    return this._clock() + this._offsetMs;
  }

  private _authChanged(): void {
    this._retries = 0;
    this._schedule();

    const identity = identityOf(this.authStore.token);
    const sameRecord = identity === this._realtimeIdentity;
    this._realtimeIdentity = identity;
    // Upstream accepts a new token for the same record on a live connection, and refuses any
    // other change with 403 (apis/realtime.go). A different user, or a sign-out, gets a new
    // connection, so its client ID is authorized with the current token or as a guest.
    const update = sameRecord ? this.realtime.resubmit() : this.realtime.reconnect();
    update.catch(() => {});
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
    const remaining = expiresAt - this._serverNow();
    let delay = Math.max(
      0,
      Math.min(remaining * RENEW_FRACTION, remaining - RENEW_BEFORE_EXPIRY_MS),
    );
    if (this._lastRenewedAt !== undefined) {
      // a floor on how often successful renewals repeat (a short token, or a clock that is off)
      delay = Math.max(delay, this._lastRenewedAt + MIN_RENEW_INTERVAL_MS - this._clock());
    }
    this._setTimer(delay, () => {
      this.renew().catch(() => {});
    });
  }

  /**
   * After a network error or a 5xx: retries with a bounded backoff. Once the retries are used up,
   * or no further retry fits before the token ends, the store is cleared at the token's expiry.
   */
  private _retryLaterIfSame(before: string): void {
    if (this.authStore.token === before) {
      this._retryLater();
    }
  }

  private _retryLater(): void {
    const expiresAt = this._expiresAt();
    if (this._disposed || expiresAt === undefined) {
      return;
    }
    const attempt = this._retries + 1;
    const backoff = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
    const now = this._serverNow();
    if (attempt > MAX_RETRIES || now + backoff >= expiresAt) {
      this._setTimer(Math.max(0, expiresAt - now), () => {
        this.authStore.clear();
      });
      return;
    }
    this._retries = attempt;
    this._setTimer(backoff, () => {
      this.renew().catch(() => {});
    });
  }

  private async _renewOnce(): Promise<void> {
    const url = this._options.renewUrl ?? "";
    const before = this.authStore.token;

    // a failed renewal of a session that has since changed must not schedule the new session's
    // retries, or clear it at the expiry of the old one's token
    let res: Response;
    try {
      res = await this._fetch(url, RENEW_REQUEST);
    } catch (err: unknown) {
      this._retryLaterIfSame(before);
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
      this._retryLaterIfSame(before);
      throw await responseError(url, res);
    }
    if (!res.ok) {
      // a route that is not there or refuses this origin: keep the token, do not retry
      throw await responseError(url, res);
    }

    let body: { token?: unknown; record?: unknown; serverTime?: unknown };
    try {
      body = (await res.json()) as { token?: unknown; record?: unknown; serverTime?: unknown };
    } catch (err: unknown) {
      this._retryLaterIfSame(before);
      throw networkError(url, err);
    }
    if (typeof body.token !== "string" || body.token === "") {
      throw new ClientResponseError({ url, status: res.status, data: body });
    }
    if (this.authStore.token !== before) {
      // the session changed while this renewal was in flight (a sign-out or a new sign-in)
      return;
    }
    if (typeof body.serverTime === "number" && Number.isFinite(body.serverTime)) {
      this._offsetMs = body.serverTime - this._clock();
    }
    const record = (body.record ?? null) as AuthRecord;
    this._lastRenewedAt = this._clock();
    this._retries = 0;
    // saving the token reschedules the next renewal and resubmits the realtime subscriptions
    this.authStore.save(body.token, recordForToken(body.token, record));
  }

  /**
   * Sets a timer. A delay above `setTimeout`'s maximum is waited for in steps: the timer is
   * re-armed when it fires, so no delay is ever cut to 1 ms.
   */
  private _setTimer(ms: number, callback: () => void): void {
    this._cancelTimer();
    const wait = Math.min(Math.max(0, ms), MAX_TIMER_MS);
    this._timer = this._timers.setTimeout(() => {
      this._timer = undefined;
      if (ms > MAX_TIMER_MS) {
        this._setTimer(ms - MAX_TIMER_MS, callback);
      } else {
        callback();
      }
    }, wait);
  }

  private _cancelTimer(): void {
    if (this._timer !== undefined) {
      this._timers.clearTimeout(this._timer);
      this._timer = undefined;
    }
  }
}

/**
 * Creates the browser client for a page. Pass the token, its record and `serverTime` from
 * `mintBrowserToken`, which the page gets at render, and the renew route's URL. Without a token,
 * the readable session cookie (fallback mode) is read.
 */
export function createBrowserClient(options: CreateBrowserClientOptions): BrowserClient {
  return new BrowserClient(options);
}
