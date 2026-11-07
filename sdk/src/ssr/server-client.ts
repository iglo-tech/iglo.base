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
  buildClearedSessionCookie,
  buildSessionCookieToSet,
  findSessionCookie,
  isHttpLocalUrl,
  normalizeCookies,
} from "@sdk/ssr/cookies";
import { DEFAULT_TTL_MS } from "@sdk/ssr/cache";

export class ServerClient extends Client {
  readonly cookies: CookieAdapter;
  private readonly _cookieName: string;
  private readonly _isSecure: boolean;
  private readonly _options: CreateServerClientOptions;
  private readonly _clock: () => number;
  private _clockOffsetMs: number = 0;

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

    if (options.secure !== undefined) {
      this._isSecure = options.secure;
    } else {
      const isLocal = isHttpLocalUrl(options.url);
      this._isSecure = !isLocal;
    }

    this.autoCancellation(false);

    const originalBeforeSend = this.beforeSend;
    this.beforeSend = (url: string, sendOptions: SendOptions) => {
      // Next.js and intermediate caches must not store SSR responses
      sendOptions.cache = "no-store";
      if (this._options.fetch && !sendOptions.fetch) {
        sendOptions.fetch = this._options.fetch;
      }

      if (originalBeforeSend) {
        return originalBeforeSend(url, sendOptions);
      }
      return { url, options: sendOptions };
    };

    const originalAfterSend = this.afterSend;
    this.afterSend = async (
      response: Response,
      data: Loose,
      sendOptions?: SendOptions,
    ): Promise<Loose> => {
      const dateHeader = response.headers?.get?.("date") || response.headers?.get?.("Date");
      if (dateHeader) {
        const serverTimeMs = Date.parse(dateHeader);
        if (!Number.isNaN(serverTimeMs)) {
          this._clockOffsetMs = serverTimeMs - this._clock();
          if (this._options.sessionCache) {
            this._options.sessionCache.clockOffsetMs = this._clockOffsetMs;
          }
        }
      }

      if (response.status === 401 && this.authStore.token) {
        await this._handleRevoked(this.authStore.token);
      }

      if (originalAfterSend) {
        return sendOptions
          ? originalAfterSend(response, data, sendOptions)
          : originalAfterSend(response, data);
      }
      return data;
    };

    this.auth = {
      verify: () => this.verifyAuth(),
    };
  }

  async verifyAuth(): Promise<AuthRecord> {
    return this._performSessionCheck(true);
  }

  /**
   * Internal initialization: reads cookies from adapter and runs check/refresh.
   */
  async init(): Promise<this> {
    await this._loadCookieAndCheck();
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
      try {
        rawJson = decodeURIComponent(rawJson);
      } catch {}
      const parsed = JSON.parse(rawJson);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        token = typeof parsed["token"] === "string" ? parsed["token"] : "";
        record = (parsed["record"] || parsed["model"] || null) as AuthRecord;
      }
    } catch {}

    if (token) {
      this.authStore.save(token, record);
    } else {
      // Fallback to loadFromCookie
      const cookiePayload = matched.value.startsWith(`${matched.name}=`)
        ? matched.value
        : `${matched.name}=${matched.value}`;
      this.authStore.loadFromCookie(cookiePayload, matched.name);
    }

    if (!this.authStore.token) {
      return;
    }

    await this._performSessionCheck(false);
  }

  private async _performSessionCheck(force: boolean): Promise<AuthRecord> {
    const token = this.authStore.token;
    if (!token) {
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
    const ttlMs = this._options.sessionCache ? DEFAULT_TTL_MS : 0;

    if (sessionCache && !force) {
      const cached = await sessionCache.get(token);
      if (cached) {
        const isFresh = nowMs - cached.checkedAt < ttlMs;
        const lifetime = payload.exp
          ? payload.iat
            ? payload.exp - payload.iat
            : (this._options.tokenDuration ?? 14 * 86400)
          : 0;
        const remaining = payload.exp ? payload.exp - effectiveNowSec : Infinity;
        const isUnderHalfLife = lifetime > 0 && remaining < lifetime / 2;

        if (isFresh && !isUnderHalfLife) {
          // Cached and fresh -> no request to iglo.base
          this.authStore.save(token, cached.record);
          return cached.record;
        }
      }
    }

    // Need check/refresh
    const doRefresh = async (): Promise<AuthRecord> => {
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
        this.authStore.save(newToken, newRecord);

        const checkedTime = this._clock();
        if (sessionCache) {
          await sessionCache.set(newToken, newRecord, checkedTime);
          if (newToken !== token) {
            await sessionCache.delete(token);
          }
        }

        if (newToken !== token) {
          await this._writeSessionCookie(newToken, newRecord);
        }

        return newRecord;
      } catch (err) {
        if (err instanceof ClientResponseError) {
          if (err.status === 401 || err.status === 403 || err.status === 404) {
            await this._handleRevoked(token);
            if (force) {
              throw err;
            }
            return null;
          }
        }
        // Network error or 5xx: keep session as is and do not touch cookie
        if (force) {
          throw err;
        }
        return this.authStore.record;
      }
    };

    let resultRecord: AuthRecord = null;
    if (sessionCache) {
      resultRecord = await sessionCache.runSingleFlight(token, doRefresh);
    } else {
      resultRecord = await doRefresh();
    }

    if (resultRecord && (!this.authStore.record || this.authStore.token === token)) {
      this.authStore.save(this.authStore.token || token, resultRecord);
    }
    return resultRecord;
  }

  private async _writeSessionCookie(token: string, record: AuthRecord): Promise<void> {
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

    await this.cookies.setAll([cookieToSet], { ...SSR_NO_CACHE_HEADERS });
  }

  private _isRevoked: boolean = false;

  private async _handleRevoked(token: string): Promise<void> {
    if (this._isRevoked) {
      return;
    }
    this._isRevoked = true;
    this.authStore.clear();

    if (this._options.sessionCache && token) {
      await this._options.sessionCache.delete(token);
    }

    if (this.cookies.setAll) {
      const cleared = buildClearedSessionCookie({
        cookieName: this._cookieName,
        secure: this._isSecure,
        cookieOptions: this._options.cookieOptions,
      });
      await this.cookies.setAll([cleared], { ...SSR_NO_CACHE_HEADERS });
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
