// docs/design/13-ssr.md ("Session cookie", "Clients")
import { BaseAuthStore, type AuthRecord } from "@sdk/stores/BaseAuthStore";
import { cookieParse, cookieSerialize, type SerializeOptions } from "@sdk/tools/cookie";
import type { Cookie, CookieToSet, CookieValueMap, RequestCookieAdapter } from "@sdk/ssr/types";

export const SSR_NO_CACHE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Cache-Control": "private, no-cache, no-store, must-revalidate, max-age=0",
  Expires: "0",
  Pragma: "no-cache",
});

export const DEFAULT_COOKIE_KEY = "pb_auth";

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

/** The `__Host-` prefixed session cookie wins; the plain name is read as a migration fallback. */
export function findSessionCookie(
  cookies: Cookie[],
  baseName: string = DEFAULT_COOKIE_KEY,
): Cookie | undefined {
  const prefixed = `__Host-${baseName}`;
  const hostMatch = cookies.find((c) => c.name === prefixed);
  if (hostMatch) {
    return hostMatch;
  }
  return cookies.find((c) => c.name === baseName);
}

function safeDecode(value: string): string {
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

interface CookieSettings {
  cookieName?: string;
  secure?: boolean;
  cookieOptions?: Partial<SerializeOptions>;
}

/** `cookieOptions.secure` overrides the flag; the default is secure (`__Host-`). */
function isSecureSession(settings: CookieSettings): boolean {
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
 * Expiring cookies for a session end. When the session cookie is `Secure`, the plain
 * name is cleared too: a `pb_auth` written before the prefix was in use must not survive.
 */
export function buildClearedSessionCookies(settings: CookieSettings): CookieToSet[] {
  const baseName = settings.cookieName ?? DEFAULT_COOKIE_KEY;
  const clear = (name: string, secure: boolean): CookieToSet => ({
    name,
    value: "",
    options: { ...serializeBase(settings, secure), maxAge: 0, expires: new Date(0) },
  });

  if (isSecureSession(settings)) {
    return [clear(`__Host-${baseName}`, true), clear(baseName, false)];
  }
  return [clear(baseName, false)];
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
