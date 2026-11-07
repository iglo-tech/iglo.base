// docs/design/13-ssr.md ("Clients", "Session cookie", "Session cache, check and refresh")
import type { SerializeOptions } from "@sdk/tools/cookie";
import type { AuthRecord } from "@sdk/stores/BaseAuthStore";

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
  lang?: string;
  clock?: () => number;
  fetch?: (url: RequestInfo | URL, config?: RequestInit) => Promise<Response>;
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
