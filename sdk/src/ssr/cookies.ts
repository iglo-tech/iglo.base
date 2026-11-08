// docs/design/13-ssr.md ("Session cookie", "Clients")
import { BaseAuthStore, type AuthRecord } from "@sdk/stores/BaseAuthStore";
import { cookieParse, cookieSerialize, type SerializeOptions } from "@sdk/tools/cookie";
import { getTokenPayload } from "@sdk/tools/jwt";
import type { Cookie, CookieToSet, CookieValueMap, RequestCookieAdapter } from "@sdk/ssr/types";

export const SSR_NO_CACHE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Cache-Control": "private, no-cache, no-store, must-revalidate, max-age=0",
  Expires: "0",
  Pragma: "no-cache",
});

export const DEFAULT_COOKIE_KEY = "pb_auth";

/** The temporary cookie of the OAuth2 redirect flow (docs/design/13-ssr.md, "OAuth2"). */
export const OAUTH2_COOKIE_KEY = "pb_oauth2";
export const OAUTH2_COOKIE_MAX_AGE_SEC = 600;

export function isLocalhost(hostname: string): boolean {
  const clean = hostname.replace(/^\[|\]$/g, "").split(":")[0] ?? "";
  return clean === "localhost" || clean === "127.0.0.1" || clean === "::1";
}

export function isHttpLocalUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    return parsed.protocol === "http:" && isLocalhost(parsed.hostname);
  } catch {
    return false;
  }
}

export function normalizeCookies(raw: Cookie[] | CookieValueMap | undefined | null): Cookie[] {
  if (!raw) {
    return [];
  }
  if (Array.isArray(raw)) {
    return raw;
  }
  return Object.entries(raw).map(([name, value]) => ({ name, value }));
}

/** The name a cookie is written under: `__Host-` prefixed on secure origins, plain otherwise. */
export function cookieWireName(baseName: string, secure: boolean): string {
  return secure ? `__Host-${baseName}` : baseName;
}

/**
 * The cookie the SDK reads, by the one name it is written under for `secure` (see
 * `cookieWireName`). On a secure origin the plain name is never read: a sibling subdomain can set
 * a cookie for the parent domain under any name, but only the host itself can set a `__Host-` one.
 */
export function findCookie(
  cookies: Cookie[],
  baseName: string,
  secure: boolean,
): Cookie | undefined {
  const name = cookieWireName(baseName, secure);
  return cookies.find((c) => c.name === name);
}

/**
 * Whether a session cookie is present under either name. The CSRF guard does not know how the
 * app named its cookie (`secure` may come from the app's settings), so both names count: the
 * guard checks more requests, never fewer. Reading a value is still `findCookie`'s job.
 */
export function hasSessionCookieName(cookies: Cookie[], baseName: string): boolean {
  return cookies.some((c) => c.name === `__Host-${baseName}` || c.name === baseName);
}

/**
 * The record that belongs to a token, or null: a record for another user is dropped, since a
 * cookie can be edited by its user. Shared by the server and the browser client.
 */
export function recordForToken(token: string, record: AuthRecord): AuthRecord {
  const payload = getTokenPayload(token);
  if (record && payload.id && record.id !== payload.id) {
    return null;
  }
  return record;
}

export function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Reads the token and user record from a session cookie value. Adapters may hand over
 * the value decoded (the request adapter does) or as sent by the browser (Next.js does),
 * so the raw text is tried first and the percent-decoded text second, each decoded once.
 */
export function parseSessionValue(raw: string): { token: string; record: AuthRecord } | undefined {
  const candidates = raw === safeDecode(raw) ? [raw] : [raw, safeDecode(raw)];
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const obj = parsed as Record<string, unknown>;
    const token = typeof obj["token"] === "string" ? obj["token"] : "";
    if (!token) {
      return undefined;
    }
    const record = (obj["record"] ?? obj["model"] ?? null) as AuthRecord;
    return { token, record };
  }
  return undefined;
}

export function formatSessionCookieValue(
  wireName: string,
  token: string,
  record: AuthRecord,
  options?: SerializeOptions,
): string {
  const tempStore = new BaseAuthStore();
  tempStore.save(token, record);
  const cookieStr = tempStore.exportToCookie(options, wireName);
  const parsed = cookieParse(cookieStr);
  return (parsed[wireName] as string) ?? "";
}

export interface CookieSettings {
  cookieName?: string;
  secure?: boolean;
  cookieOptions?: Partial<SerializeOptions>;
  /** Fallback mode: the session cookie is written without `HttpOnly` (docs/design/13-ssr.md). */
  readable?: boolean;
}

/** `cookieOptions.secure` overrides the flag; the default is secure (`__Host-`). */
export function isSecureSession(settings: CookieSettings): boolean {
  return settings.cookieOptions?.secure ?? settings.secure ?? true;
}

/**
 * Serialize options shared by writes and clears. The app's `cookieOptions` come first,
 * then the name rules: `__Host-` requires `Secure`, `Path=/` and no `Domain`.
 */
function serializeBase(settings: CookieSettings, secure: boolean): SerializeOptions {
  const opts: SerializeOptions = {
    path: "/",
    sameSite: "lax",
    httpOnly: true,
    ...settings.cookieOptions,
    secure,
  };
  if (settings.readable) {
    // the browser client reads this cookie (no superuser credentials; see 13-ssr.md, "Browser client")
    opts.httpOnly = false;
  }
  if (secure) {
    delete opts.domain;
    opts.path = "/";
  }
  return opts;
}

export function buildSessionCookieToSet(
  token: string,
  record: AuthRecord,
  options: CookieSettings & { nowSeconds?: number; exp?: number },
): CookieToSet {
  const secure = isSecureSession(options);
  const wireName = secure
    ? `__Host-${options.cookieName ?? DEFAULT_COOKIE_KEY}`
    : (options.cookieName ?? DEFAULT_COOKIE_KEY);

  const nowSec = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const exp = options.exp;
  const serializeOpts: SerializeOptions = {
    ...serializeBase(options, secure),
    maxAge: exp !== undefined ? Math.max(0, exp - nowSec) : undefined,
    expires: exp !== undefined ? new Date(exp * 1000) : undefined,
  };

  return {
    name: wireName,
    value: formatSessionCookieValue(wireName, token, record, serializeOpts),
    options: serializeOpts,
  };
}

/**
 * Expiring cookies for a cookie's end, one per name the cookie may have been written under.
 * When `secure`, the plain name is cleared too. It is never read on a secure origin, so this
 * only removes what some other writer or an older build left under it. `optionsFor` gives the
 * serialize options of each name's write.
 */
function buildClearedCookies(
  baseName: string,
  secure: boolean,
  optionsFor: (cookieSecure: boolean) => SerializeOptions,
): CookieToSet[] {
  const clear = (name: string, cookieSecure: boolean): CookieToSet => ({
    name,
    value: "",
    options: { ...optionsFor(cookieSecure), maxAge: 0, expires: new Date(0) },
  });

  if (secure) {
    return [clear(`__Host-${baseName}`, true), clear(baseName, false)];
  }
  return [clear(baseName, false)];
}

/** Expiring cookies for a session end. */
export function buildClearedSessionCookies(settings: CookieSettings): CookieToSet[] {
  return buildClearedCookies(
    settings.cookieName ?? DEFAULT_COOKIE_KEY,
    isSecureSession(settings),
    (cookieSecure) => serializeBase(settings, cookieSecure),
  );
}

/**
 * The temporary OAuth2 cookie: HttpOnly, `SameSite=Lax` (the provider's redirect is a top-level
 * GET), `Path=/`, `Max-Age` 600 and the same `Secure`/`__Host-` rule as the session cookie.
 * The app's `cookieOptions` are not applied (apart from `secure`), so an app cannot make the
 * cookie unreachable from the provider's redirect.
 */
export function buildOAuth2CookieToSet(value: string, settings: CookieSettings): CookieToSet {
  const secure = isSecureSession(settings);
  return {
    name: secure ? `__Host-${OAUTH2_COOKIE_KEY}` : OAUTH2_COOKIE_KEY,
    value,
    options: {
      path: "/",
      sameSite: "lax",
      httpOnly: true,
      secure,
      maxAge: OAUTH2_COOKIE_MAX_AGE_SEC,
    },
  };
}

/** Expiring cookies for the temporary OAuth2 cookie, written with the same name rule. */
export function buildClearedOAuth2Cookies(settings: CookieSettings): CookieToSet[] {
  return buildClearedCookies(OAUTH2_COOKIE_KEY, isSecureSession(settings), (cookieSecure) => ({
    path: "/",
    sameSite: "lax",
    httpOnly: true,
    secure: cookieSecure,
  }));
}

export function createRequestCookieAdapter(
  request: Request,
  options?: { secure?: boolean },
): RequestCookieAdapter {
  const queuedCookies: CookieToSet[] = [];
  const queuedHeaders: Record<string, string> = {};

  const reqUrl = new URL(request.url);
  const isLocal = reqUrl.protocol === "http:" && isLocalhost(reqUrl.hostname);
  const isSecure = options?.secure ?? !isLocal;

  return {
    isSecure,
    getAll(): Cookie[] {
      const cookieHeader = request.headers.get("cookie") || "";
      const parsed = cookieParse(cookieHeader);
      return Object.entries(parsed).map(([name, value]) => ({
        name,
        value: typeof value === "string" ? value : String(value),
      }));
    },
    setAll(cookiesToSet: CookieToSet[], headers?: Record<string, string>): void {
      for (const c of cookiesToSet) {
        queuedCookies.push(c);
      }
      if (headers) {
        for (const [k, v] of Object.entries(headers)) {
          queuedHeaders[k] = v;
        }
      }
    },
    applyToResponse(response: Response): Response {
      for (const [k, v] of Object.entries(queuedHeaders)) {
        response.headers.set(k, v);
      }
      for (const c of queuedCookies) {
        const serialized = cookieSerialize(c.name, c.value, c.options);
        response.headers.append("Set-Cookie", serialized);
      }
      return response;
    },
    get queuedCookies(): CookieToSet[] {
      return queuedCookies;
    },
    get queuedHeaders(): Record<string, string> {
      return queuedHeaders;
    },
  };
}
