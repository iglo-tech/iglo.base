// docs/design/13-ssr.md ("Clients", "Session cookie", "Session cache, check and refresh")
import Client from "@sdk/Client";
import { ClientResponseError } from "@sdk/ClientResponseError";
import { BaseAuthStore, type AuthRecord } from "@sdk/stores/BaseAuthStore";
import { getTokenPayload } from "@sdk/tools/jwt";
import type { RecordModel } from "@sdk/tools/dtos";
import type { SendOptions } from "@sdk/tools/options";
import type { Loose } from "@sdk/tools/loose";
import type { Cookie, CookieAdapter, CreateServerClientOptions } from "@sdk/ssr/types";
import {
  DEFAULT_COOKIE_KEY,
  SSR_NO_CACHE_HEADERS,
  buildClearedSessionCookies,
  buildSessionCookieToSet,
  findSessionCookie,
  isHttpLocalUrl,
  normalizeCookies,
} from "@sdk/ssr/cookies";

type RefreshOutcome =
  | { kind: "ok"; token: string; record: AuthRecord; serverDateHeader?: string }
  | { kind: "revoked"; status: number; error: ClientResponseError }
  | { kind: "transient"; status?: number; error: unknown };

export class ServerClient extends Client {
  readonly cookies: CookieAdapter;
  private readonly _cookieName: string;
  private readonly _isSecure: boolean;
  private readonly _options: CreateServerClientOptions;
  private readonly _clock: () => number;
  private _clockOffsetMs: number = 0;
  private _lastServerDateHeader?: string;
  private _initialized: boolean = false;
  private _lastKnownToken: string = "";

  readonly auth: {
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

    // Secure & __Host- follow the app's own request / origin, never the iglo.base URL
    if (options.secure !== undefined) {
      this._isSecure = options.secure;
    } else if ((options.cookies as { isSecure?: boolean }).isSecure !== undefined) {
      this._isSecure = (options.cookies as { isSecure?: boolean }).isSecure!;
    } else if (options.origin) {
      this._isSecure = !isHttpLocalUrl(options.origin);
    } else if (options.request) {
      this._isSecure = !isHttpLocalUrl(options.request.url);
    } else {
      this._isSecure = true;
    }

    this.autoCancellation(false);

    const originalAfterSend = this.afterSend;
    this.afterSend = async (
      response: Response,
      data: Loose,
      sendOptions?: SendOptions,
    ): Promise<Loose> => {
      const dateHeader = response.headers?.get?.("date") || response.headers?.get?.("Date");
      if (dateHeader) {
        this._lastServerDateHeader = dateHeader;
        const serverTimeMs = Date.parse(dateHeader);
        if (!Number.isNaN(serverTimeMs)) {
          this._clockOffsetMs = serverTimeMs - this._clock();
          if (this._options.sessionCache) {
            this._options.sessionCache.clockOffsetMs = this._clockOffsetMs;
          }
        }
      }

      // Learn collection lifetime from auth responses seen by SDK
      if (response.ok && data && typeof data === "object") {
        const respObj = data as Record<string, unknown>;
        const token = typeof respObj["token"] === "string" ? respObj["token"] : "";
        if (token && dateHeader) {
          const payload = getTokenPayload(token);
          // Impersonate tokens have refreshable === false; exclude them
          if (payload.exp && payload.refreshable !== false) {
            const serverTimeMs = Date.parse(dateHeader);
            if (!Number.isNaN(serverTimeMs)) {
              const serverTimeSec = Math.floor(serverTimeMs / 1000);
              const lifetime = payload.exp - serverTimeSec;
              const rec = respObj["record"] as Record<string, unknown> | undefined;
              const collectionId =
                payload.collectionId ||
                (typeof rec?.["collectionId"] === "string" ? rec["collectionId"] : "") ||
                (typeof rec?.["collectionName"] === "string" ? rec["collectionName"] : "");
              if (lifetime > 0 && collectionId && this._options.sessionCache) {
                this._options.sessionCache.setCollectionLifetime(collectionId, lifetime);
              }
            }
          }
        }
      }

      if (originalAfterSend) {
        return sendOptions
          ? originalAfterSend(response, data, sendOptions)
          : originalAfterSend(response, data);
      }
      return data;
    };

    // Listen to auth changes on the server client (sign-in, sign-out, clear)
    let isHandlingAuthStoreChange = false;
    this.authStore.onChange((newToken, record) => {
      if (!this._initialized || isHandlingAuthStoreChange) {
        return;
      }
      isHandlingAuthStoreChange = true;
      try {
        if (newToken) {
          this._lastKnownToken = newToken;
          const payload = getTokenPayload(newToken);
          if (record && payload.id && record.id !== payload.id) {
            record = null;
          }
          if (this._options.sessionCache) {
            this._options.sessionCache.set(newToken, record, this._clock()).catch(() => {});
          }
          this._writeSessionCookie(newToken, record);
        } else {
          this._handleRevoked(this._lastKnownToken);
        }
      } finally {
        isHandlingAuthStoreChange = false;
      }
    });

    this.auth = {
      verify: () => this.verifyAuth(),
    };
  }

  /**
   * Overriding send ensures cache: 'no-store' and custom fetch stick
   * even if application code assigns pb.beforeSend.
   */
  override async send<T = Loose>(path: string, options: SendOptions): Promise<T> {
    options.cache = "no-store";
    if (this._options.fetch && !options.fetch) {
      options.fetch = this._options.fetch;
    }
    return super.send<T>(path, options);
  }

  async verifyAuth(): Promise<AuthRecord> {
    return this._performSessionCheck(true);
  }

  /**
   * Internal initialization: reads cookies from adapter and runs check/refresh.
   */
  async init(): Promise<this> {
    await this._loadCookieAndCheck();
    this._initialized = true;
    return this;
  }

  private async _loadCookieAndCheck(): Promise<void> {
    let rawCookies: unknown;
    try {
      rawCookies = await this.cookies.getAll();
    } catch {
      return;
    }

    const cookies = normalizeCookies(rawCookies as Cookie[] | Record<string, string>);
    const matched = findSessionCookie(cookies, this._cookieName);

    if (!matched || !matched.value) {
      this.authStore.clear();
      return;
    }

    // Load token & record from cookie
    let token = "";
    let record: AuthRecord = null;
    try {
      let rawJson = matched.value;
      if (rawJson.startsWith(`${matched.name}=`)) {
        rawJson =
          rawJson
            .slice(matched.name.length + 1)
            .split(";")[0]
            ?.trim() ?? "";
      }
      const parsed = JSON.parse(rawJson);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        token = typeof parsed["token"] === "string" ? parsed["token"] : "";
        record = (parsed["record"] || parsed["model"] || null) as AuthRecord;
      }
    } catch {}

    if (token) {
      this._lastKnownToken = token;
      const payload = getTokenPayload(token);
      if (record && payload.id && record.id !== payload.id) {
        record = null;
      }
      this.authStore.save(token, record);
    } else {
      // Fallback to loadFromCookie
      const cookiePayload = matched.value.startsWith(`${matched.name}=`)
        ? matched.value
        : `${matched.name}=${matched.value}`;
      this.authStore.loadFromCookie(cookiePayload, matched.name);
      if (this.authStore.token) {
        this._lastKnownToken = this.authStore.token;
        const payload = getTokenPayload(this.authStore.token);
        if (this.authStore.record && payload.id && this.authStore.record.id !== payload.id) {
          this.authStore.save(this.authStore.token, null);
        }
      }
    }

    if (!this.authStore.token) {
      return;
    }

    await this._performSessionCheck(false);
  }

  private async _performSessionCheck(force: boolean): Promise<AuthRecord> {
    const token = this.authStore.token;
    if (!token) {
      if (force) {
        throw new ClientResponseError({
          status: 401,
          data: { message: "The request requires valid authentication token." },
        });
      }
      return null;
    }

    const payload = getTokenPayload(token);
    const nowMs = this._clock();
    const effectiveNowMs = nowMs + this._clockOffsetMs;
    const effectiveNowSec = Math.floor(effectiveNowMs / 1000);

    // 60s clock-skew allowance on token expiration
    if (payload.exp && effectiveNowSec > payload.exp + 60) {
      await this._handleRevoked(token);
      if (force) {
        throw new ClientResponseError({
          status: 401,
          data: { message: "The token is expired." },
        });
      }
      return null;
    }

    const sessionCache = this._options.sessionCache;
    const ttlMs = sessionCache ? sessionCache.ttl : 0;
    const collectionId =
      payload.collectionId ||
      this.authStore.record?.collectionId ||
      this.authStore.record?.collectionName;

    if (sessionCache && !force) {
      const cached = await sessionCache.get(token);
      if (cached) {
        const isFresh = nowMs - cached.checkedAt < ttlMs;
        const learnedLifetime = collectionId
          ? sessionCache.getCollectionLifetime(collectionId)
          : undefined;

        // Refresh when less than half of the learned lifetime remains.
        // If lifetime is not known yet, the first check refreshes once to learn it.
        if (learnedLifetime !== undefined && learnedLifetime > 0) {
          const remaining = payload.exp ? payload.exp - effectiveNowSec : Infinity;
          const isUnderHalfLife = remaining < learnedLifetime / 2;

          if (isFresh && !isUnderHalfLife) {
            // Cached and fresh -> no request to iglo.base
            this.authStore.save(token, cached.record);
            return cached.record;
          }
        }
      }
    }

    // Need check/refresh
    const executeRefresh = async (): Promise<RefreshOutcome> => {
      const collection =
        this.authStore.record?.collectionName ||
        this.authStore.record?.collectionId ||
        payload.collectionId ||
        (this.authStore.isSuperuser ? "_superusers" : "users");

      try {
        const fetchFunc = this._options.fetch || fetch;
        const sendOpts: SendOptions = {
          method: "POST",
          headers: {
            Authorization: token,
          },
          fetch: fetchFunc,
        };

        const res = await this.send<{ token: string; record: RecordModel }>(
          `/api/collections/${encodeURIComponent(collection)}/auth-refresh`,
          sendOpts,
        );

        const newToken = res?.token || token;
        const newRecord = (res?.record as AuthRecord) || this.authStore.record;

        return {
          kind: "ok",
          token: newToken,
          record: newRecord,
          serverDateHeader: this._lastServerDateHeader,
        };
      } catch (err: unknown) {
        if (err instanceof ClientResponseError) {
          if (err.status === 401 || err.status === 403 || err.status === 404) {
            return {
              kind: "revoked",
              status: err.status,
              error: err,
            };
          }
          return {
            kind: "transient",
            status: err.status,
            error: err,
          };
        }
        return {
          kind: "transient",
          error: err,
        };
      }
    };

    let outcome: RefreshOutcome;
    if (sessionCache) {
      outcome = await sessionCache.runSingleFlight(token, executeRefresh);
    } else {
      outcome = await executeRefresh();
    }

    // Apply the outcome to this client instance, auth store, and cookies
    if (outcome.kind === "ok") {
      const newToken = outcome.token;
      const newRecord = outcome.record;
      this._lastKnownToken = newToken;

      if (sessionCache) {
        const newPayload = getTokenPayload(newToken);
        if (newPayload.exp && outcome.serverDateHeader && newPayload.refreshable !== false) {
          const serverTimeMs = Date.parse(outcome.serverDateHeader);
          if (!Number.isNaN(serverTimeMs)) {
            const serverTimeSec = Math.floor(serverTimeMs / 1000);
            const learned = newPayload.exp - serverTimeSec;
            const colId = newPayload.collectionId || collectionId;
            if (learned > 0 && colId) {
              sessionCache.setCollectionLifetime(colId, learned);
            }
          }
        }
        await sessionCache.set(newToken, newRecord, this._clock());
        if (newToken !== token) {
          await sessionCache.delete(token);
        }
      }

      this.authStore.save(newToken, newRecord);

      if (newToken !== token) {
        this._writeSessionCookie(newToken, newRecord);
      }

      return newRecord;
    }

    if (outcome.kind === "revoked") {
      this._handleRevoked(token);
      if (force) {
        throw outcome.error;
      }
      return null;
    }

    // outcome.kind === "transient" (network error or 5xx)
    // Keep normal request's session and do not touch cookie
    if (this.authStore.record && payload.id && this.authStore.record.id !== payload.id) {
      this.authStore.clear();
    }

    if (force) {
      throw outcome.error;
    }
    return this.authStore.record;
  }

  private _writeSessionCookie(token: string, record: AuthRecord): void {
    if (!this.cookies.setAll) {
      return;
    }
    const payload = getTokenPayload(token);
    const nowSec = Math.floor((this._clock() + this._clockOffsetMs) / 1000);

    const cookieToSet = buildSessionCookieToSet(token, record, {
      cookieName: this._cookieName,
      secure: this._isSecure,
      nowSeconds: nowSec,
      exp: payload.exp,
      cookieOptions: this._options.cookieOptions,
    });

    try {
      const res = this.cookies.setAll([cookieToSet], { ...SSR_NO_CACHE_HEADERS });
      if (res && typeof (res as Promise<void>).catch === "function") {
        (res as Promise<void>).catch(() => {});
      }
    } catch {
      // In Next.js Server Components, setAll may throw if cookies are read-only
    }
  }

  private _handleRevoked(token: string): void {
    this.authStore.clear();

    if (this._options.sessionCache && token) {
      this._options.sessionCache.delete(token).catch(() => {});
    }

    if (this.cookies.setAll) {
      const clearedCookies = buildClearedSessionCookies({
        cookieName: this._cookieName,
        secure: this._isSecure,
        cookieOptions: this._options.cookieOptions,
      });
      try {
        const res = this.cookies.setAll(clearedCookies, { ...SSR_NO_CACHE_HEADERS });
        if (res && typeof (res as Promise<void>).catch === "function") {
          (res as Promise<void>).catch(() => {});
        }
      } catch {
        // In Next.js Server Components, setAll may throw if cookies are read-only
      }
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
