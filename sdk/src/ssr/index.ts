// docs/design/13-ssr.md ("Clients", "Session cookie", "Session cache, check and refresh")
export { ServerClient, createServerClient } from "@sdk/ssr/server-client";
export { SuperuserClient, createSuperuserClient } from "@sdk/ssr/superuser-client";
export { createSessionCache, DEFAULT_TTL_MS, DEFAULT_MAX_ENTRIES } from "@sdk/ssr/cache";
export {
  createRequestCookieAdapter,
  SSR_NO_CACHE_HEADERS,
  DEFAULT_COOKIE_KEY,
} from "@sdk/ssr/cookies";
export { OAuth2Error, type OAuth2ErrorKind } from "@sdk/ssr/oauth2";
export { checkCsrf, checkOrigin } from "@sdk/ssr/csrf";
export { handlePopupHandOff } from "@sdk/ssr/popup";
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
  StartOAuth2Options,
  CompleteOAuth2Result,
} from "@sdk/ssr/types";
export type { CsrfOptions, CsrfResult, OriginCheck } from "@sdk/ssr/csrf";
export type { PopupHandOffOptions } from "@sdk/ssr/popup";
