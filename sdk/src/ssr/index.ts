// docs/design/13-ssr.md ("Clients", "Session cookie", "Session cache, check and refresh")
export { ServerClient, createServerClient } from "@sdk/ssr/server-client";
export { SuperuserClient, createSuperuserClient } from "@sdk/ssr/superuser-client";
export { createSessionCache, hashToken, DEFAULT_TTL_MS, DEFAULT_MAX_ENTRIES } from "@sdk/ssr/cache";
export {
  createRequestCookieAdapter,
  SSR_NO_CACHE_HEADERS,
  DEFAULT_COOKIE_KEY,
  isLocalhost,
  isHttpLocalUrl,
  findSessionCookie,
  formatSessionCookieValue,
  buildSessionCookieToSet,
  buildClearedSessionCookie,
} from "@sdk/ssr/cookies";
export type {
  Cookie,
  CookieToSet,
  CookieAdapter,
  SessionCache,
  SessionCacheEntry,
  SessionCacheOptions,
  CreateServerClientOptions,
  CreateSuperuserClientOptions,
  RequestCookieAdapter,
} from "@sdk/ssr/types";
