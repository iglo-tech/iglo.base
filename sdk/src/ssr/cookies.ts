// docs/design/13-ssr.md ("Session cookie", "Clients")
import type { AuthRecord } from "@sdk/stores/BaseAuthStore";
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

export function formatSessionCookieValue(
  wireName: string,
  token: string,
  record: AuthRecord,
  options?: SerializeOptions,
): string {
  const rawData: { token: string; record: Record<string, unknown> | null } = {
    token: token,
    record: record ? JSON.parse(JSON.stringify(record)) : null,
  };

  let serialized = cookieSerialize(wireName, JSON.stringify(rawData), options);
  const resultLength =
    typeof Blob !== "undefined" ? new Blob([serialized]).size : serialized.length;

  if (rawData.record && resultLength > 4096) {
    rawData.record = {
      id: String(rawData.record["id"] ?? ""),
      email: rawData.record["email"] ?? "",
    };
    const extraProps = ["collectionId", "collectionName", "verified"];
    for (const prop of extraProps) {
      if (record && prop in record) {
        rawData.record[prop] = (record as Record<string, unknown>)[prop];
      }
    }
  }

  return JSON.stringify(rawData);
}

export function buildSessionCookieToSet(
  token: string,
  record: AuthRecord,
  options: {
    cookieName?: string;
    secure?: boolean;
    nowSeconds?: number;
    exp?: number;
    cookieOptions?: Partial<SerializeOptions>;
  },
): CookieToSet {
  const baseName = options.cookieName ?? DEFAULT_COOKIE_KEY;
  const isSecure = options.secure ?? true;
  const wireName = isSecure ? `__Host-${baseName}` : baseName;

  const nowSec = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const exp = options.exp;
  const maxAge = exp !== undefined ? Math.max(0, exp - nowSec) : undefined;
  const expires = exp !== undefined ? new Date(exp * 1000) : undefined;

  const serializeOpts: SerializeOptions = {
    path: "/",
    sameSite: "lax",
    httpOnly: true,
    secure: isSecure,
    maxAge: maxAge,
    expires: expires,
    ...options.cookieOptions,
  };

  const value = formatSessionCookieValue(wireName, token, record, serializeOpts);

  return {
    name: wireName,
    value: value,
    options: serializeOpts,
  };
}

export function buildClearedSessionCookie(options: {
  cookieName?: string;
  secure?: boolean;
  cookieOptions?: Partial<SerializeOptions>;
}): CookieToSet {
  const baseName = options.cookieName ?? DEFAULT_COOKIE_KEY;
  const isSecure = options.secure ?? true;
  const wireName = isSecure ? `__Host-${baseName}` : baseName;

  const serializeOpts: SerializeOptions = {
    path: "/",
    sameSite: "lax",
    httpOnly: true,
    secure: isSecure,
    maxAge: 0,
    expires: new Date(0),
    ...options.cookieOptions,
  };

  return {
    name: wireName,
    value: "",
    options: serializeOpts,
  };
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
