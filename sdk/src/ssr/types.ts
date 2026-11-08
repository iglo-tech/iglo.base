// docs/design/13-ssr.md ("Clients", "Session cookie", "Session cache, check and refresh")
import type { SerializeOptions } from "@sdk/tools/cookie";
import type { AuthRecord } from "@sdk/stores/BaseAuthStore";
import type { RecordAuthResponse } from "@sdk/services/RecordService";
import type { ClientResponseError } from "@sdk/ClientResponseError";
import type { OAuth2Error } from "@sdk/ssr/oauth2";

export interface Cookie {
  name: string;
  value: string;
}

export interface CookieToSet {
  name: string;
  value: string;
  options?: SerializeOptions;
}

export type CookieValueMap = Record<string, string>;

export interface CookieAdapter {
  getAll: () => Cookie[] | Promise<Cookie[]> | CookieValueMap | Promise<CookieValueMap>;
  setAll?: (cookies: CookieToSet[], headers?: Record<string, string>) => void | Promise<void>;
  /**
   * Whether the app's own request is https (set by adapters that know the request).
   * The session cookie is `Secure` and `__Host-` prefixed unless this is false.
   */
  isSecure?: boolean;
}

export interface SessionCacheEntry {
  record: AuthRecord;
  checkedAt: number;
}

export interface SessionCache {
  get(token: string): Promise<SessionCacheEntry | undefined>;
  set(token: string, record: AuthRecord, checkedAt?: number): Promise<void>;
  delete(token: string): Promise<void>;
  clear(): void;
  runSingleFlight<T>(token: string, fn: () => Promise<T>): Promise<T>;
  readonly size: number;
  readonly ttl: number;
  readonly maxEntries: number;
  clockOffsetMs?: number;
  getCollectionLifetime(collectionId: string): number | undefined;
  setCollectionLifetime(collectionId: string, lifetimeSec: number): void;
}

export interface SessionCacheOptions {
  ttl?: number;
  maxEntries?: number;
  clock?: () => number;
}

export interface CreateServerClientOptions {
  url: string;
  cookies: CookieAdapter;
  cookieName?: string;
  sessionCache?: SessionCache;
  secure?: boolean;
  origin?: string;
  request?: Request;
  cookieOptions?: Partial<SerializeOptions>;
  /**
   * Fallback without superuser credentials (docs/design/13-ssr.md, "Browser client and realtime"):
   * the session cookie is written without `HttpOnly`, so the browser client can read it. Weaker
   * against XSS than the default: any script on the page can read the session token.
   */
  readableCookie?: boolean;
  lang?: string;
  clock?: () => number;
  fetch?: (url: RequestInfo | URL, config?: RequestInit) => Promise<Response>;
}

/** What a page needs to start a browser client: a short-lived token and the user's record. */
export interface BrowserToken {
  token: string;
  record: AuthRecord;
  /** When the token expires, in milliseconds since the epoch (from its `exp` claim). */
  expiresAt: number;
}

export interface MintBrowserTokenOptions {
  /** Lifetime of the minted token in seconds (default 900, 15 minutes). */
  duration?: number;
}

export interface CreateSuperuserClientOptions {
  url: string;
  email?: string;
  password?: string;
  token?: string;
  autoRefreshThreshold?: number;
  lang?: string;
  fetch?: (url: RequestInfo | URL, config?: RequestInit) => Promise<Response>;
}

export interface RequestCookieAdapter extends CookieAdapter {
  isSecure: boolean;
  getAll: () => Cookie[];
  setAll: (cookiesToSet: CookieToSet[], headers?: Record<string, string>) => void;
  applyToResponse: (response: Response) => Response;
  readonly queuedCookies: CookieToSet[];
  readonly queuedHeaders: Record<string, string>;
}

export interface StartOAuth2Options {
  /** The app's callback URL, as registered with the provider (an absolute http(s) URL). */
  callbackUrl: string;
  /** Where the user goes after sign-in: a same-origin path. Anything else becomes `/`. */
  redirectTo?: string;
  /** The auth collection (default `users`). */
  collection?: string;
}

export type CompleteOAuth2Result =
  | { ok: true; redirectTo: string; auth: RecordAuthResponse }
  | { ok: false; redirectTo: string; error: OAuth2Error | ClientResponseError };
