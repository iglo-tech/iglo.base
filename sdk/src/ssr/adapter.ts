// docs/design/13-ssr.md ("Framework adapters", "OAuth2", "CSRF", "Browser client and realtime").
//
// The part every framework adapter shares: the route table, the per-request session, the CSRF
// guard and the browser-token mint. Each adapter (next.ts, sveltekit.ts, nuxt.ts, astro.ts,
// react-router.ts) maps its framework's request, cookies and locals onto these functions. Nothing
// here keeps state between requests: the session cache and the superuser client belong to the
// app, and the app passes them in the options.
import { ClientResponseError } from "@sdk/ClientResponseError";
import type { SerializeOptions } from "@sdk/tools/cookie";
import { DEFAULT_COOKIE_KEY, hasSessionCookieName, isHttpLocalUrl } from "@sdk/ssr/cookies";
import {
  checkCsrf,
  createRequestCookieAdapter,
  createServerClient,
  handleBrowserTokenRenew,
  handlePopupHandOff,
  mintBrowserToken,
  OAuth2Error,
  SSR_NO_CACHE_HEADERS,
  type BrowserToken,
  type CookieAdapter,
  type CreateServerClientOptions,
  type ServerClient,
  type SessionCache,
  type SuperuserClient,
} from "@sdk/ssr/index";

/** The paths the adapter answers. A route set to `false` is not mounted. */
export interface AdapterRoutes {
  /** `POST`: renews the browser token (`handleBrowserTokenRenew`). */
  renew: string | false;
  /** `POST` with the JSON body `{ "token": ... }`: completes a popup sign-in (`handlePopupHandOff`). */
  popup: string | false;
  /** `GET {oauth2Start}/{provider}`: starts the OAuth2 redirect flow (`startOAuth2`). */
  oauth2Start: string | false;
  /** `GET`: the provider's callback, which completes the flow (`completeOAuth2`). */
  oauth2Callback: string | false;
}

export const DEFAULT_ROUTES: Readonly<AdapterRoutes> = Object.freeze({
  renew: "/api/pb/renew",
  popup: "/api/pb/popup",
  oauth2Start: "/api/pb/oauth2/start",
  oauth2Callback: "/api/pb/oauth2/callback",
});

/** The options every adapter takes. The app creates `sessionCache` and `superuser` once. */
export interface AdapterOptions {
  /** iglo.base's URL as the app server reaches it. */
  url: string;
  /** The session cache, created by the app (`createSessionCache`) and shared by its requests. */
  sessionCache: SessionCache;
  /** Mints browser tokens with `impersonate`. Without it, `readableCookie` must be true. */
  superuser?: SuperuserClient;
  /**
   * The app's public origin, such as `https://app.example.com`. It sets the cookie security and
   * the OAuth2 callback URL. Default: the origin of each request.
   */
  origin?: string;
  /** Overrides the cookie's security (`Secure` and the `__Host-` prefix). */
  secure?: boolean;
  /** The session cookie's base name (default `pb_auth`). */
  cookieName?: string;
  cookieOptions?: Partial<SerializeOptions>;
  /** The fallback without superuser credentials: the session cookie is readable by page scripts. */
  readableCookie?: boolean;
  /**
   * The CSRF guard on state-changing requests that carry the session cookie. `false` turns it
   * off; `allowedOrigins` lists the other origins that may send them.
   */
  csrf?: false | { allowedOrigins?: readonly string[] };
  /** Lifetime of minted browser tokens in seconds (default 900). */
  browserTokenDuration?: number;
  routes?: Partial<AdapterRoutes>;
  lang?: string;
  clock?: () => number;
  fetch?: CreateServerClientOptions["fetch"];
}

export interface ResolvedAdapterOptions extends AdapterOptions {
  routes: AdapterRoutes;
}

/**
 * Checks the configuration once, when the app creates its adapter. Without superuser
 * credentials the adapter can only serve pages in fallback mode, so it must say so here.
 *
 * @throws {TypeError} without a superuser client and without `readableCookie: true`
 */
export function resolveAdapterOptions(options: AdapterOptions): ResolvedAdapterOptions {
  if (!options.superuser && options.readableCookie !== true) {
    throw new TypeError("the adapter needs a superuser client, or readableCookie: true");
  }
  const routes: AdapterRoutes = {
    renew: options.routes?.renew ?? DEFAULT_ROUTES.renew,
    popup: options.routes?.popup ?? DEFAULT_ROUTES.popup,
    oauth2Start: options.routes?.oauth2Start ?? DEFAULT_ROUTES.oauth2Start,
    oauth2Callback: options.routes?.oauth2Callback ?? DEFAULT_ROUTES.oauth2Callback,
  };
  return { ...options, routes };
}

/** The cookie security this request's app uses: the option, else the app origin, else the request. */
function secureFor(request: Request, options: ResolvedAdapterOptions): boolean | undefined {
  if (options.secure !== undefined) {
    return options.secure;
  }
  if (options.origin !== undefined) {
    return !isHttpLocalUrl(options.origin);
  }
  return undefined;
}

/** The app's public origin: the option, or the origin of the request. */
export function appOrigin(request: Request, options: ResolvedAdapterOptions): string {
  return options.origin ?? new URL(request.url).origin;
}

/** The session of one request, resumed from its cookies. */
export interface RequestSession {
  /** The server client for this request only. Never shared across requests. */
  server: ServerClient;
  /**
   * Mints the page's browser token for the signed-in user (`null` when nobody is signed in). A token
   * that is minted marks the request's responses as user data (see `NoStorePolicy`).
   */
  browserToken: () => Promise<BrowserToken | null>;
}

/**
 * Whether a request's responses carry user data, and so must not be stored by a cache. The policy
 * is on when the request carries a session cookie (under either name, as `checkCsrf` counts them),
 * and turns on the first time the request writes a cookie or mints a browser token. Every response
 * of an active request gets `SSR_NO_CACHE_HEADERS` (docs/design/13-ssr.md, "Session cookie").
 * Anonymous requests that write nothing keep their responses cacheable.
 */
export interface NoStorePolicy {
  /** Whether the responses of this request carry the no-cache headers. */
  readonly active: boolean;
  /** A cookie was written or a browser token minted: from now on the responses are user data. */
  markUserData(): void;
  /** Sets the no-cache headers on a response of this request, when the policy is active. */
  apply(response: Response): Response;
}

/**
 * The policy of one request. `onActive` runs once, when the policy turns on: at once when the
 * request carries a session cookie, otherwise at the first write or mint. For a framework that
 * sets headers before the handler's response is sent (Nitro) it sets them as they become needed.
 */
export function noStorePolicy(
  request: Request,
  options: ResolvedAdapterOptions,
  onActive?: () => void,
): NoStorePolicy {
  const baseName = options.cookieName ?? DEFAULT_COOKIE_KEY;
  let active = hasSessionCookieName(createRequestCookieAdapter(request).getAll(), baseName);
  const policy: NoStorePolicy = {
    get active() {
      return active;
    },
    markUserData() {
      if (!active) {
        active = true;
        onActive?.();
      }
    },
    apply(response) {
      if (active) {
        setNoStoreHeaders(response.headers);
      }
      return response;
    },
  };
  if (active) {
    onActive?.();
  }
  return policy;
}

/**
 * Sets SSR_NO_CACHE_HEADERS, replacing any the app set: a user's response must not be stored with
 * a public `Cache-Control`. A response with locked headers is sent as it is.
 */
export function setNoStoreHeaders(headers: Headers): void {
  for (const [name, value] of Object.entries(SSR_NO_CACHE_HEADERS)) {
    try {
      headers.set(name, value);
    } catch {
      // immutable headers: the response goes out without them
    }
  }
}

/**
 * Resumes the session of one request with `createServerClient`. `cookies` is the framework's
 * cookie access, mapped to `{ getAll, setAll, isSecure }`: writes made by the session check
 * (a refresh, a revoked session) go through its `setAll`. Each write and each minted browser token
 * turns `policy` on, so the adapter sets the no-cache headers on the response it returns.
 */
export async function resumeSession(
  cookies: CookieAdapter,
  request: Request,
  options: ResolvedAdapterOptions,
  policy: NoStorePolicy = noStorePolicy(request, options),
): Promise<RequestSession> {
  const tracked: CookieAdapter = {
    ...cookies,
    setAll: cookies.setAll
      ? (toSet, headers) => {
          if (toSet.length > 0) {
            policy.markUserData();
          }
          return cookies.setAll?.(toSet, headers);
        }
      : undefined,
  };
  const server = await createServerClient({
    url: options.url,
    cookies: tracked,
    origin: appOrigin(request, options),
    secure: secureFor(request, options),
    sessionCache: options.sessionCache,
    cookieName: options.cookieName,
    cookieOptions: options.cookieOptions,
    readableCookie: options.readableCookie,
    lang: options.lang,
    clock: options.clock,
    fetch: options.fetch,
  });
  return {
    server,
    browserToken: async () => {
      const token = await mintBrowserToken(server, options.superuser, {
        duration: options.browserTokenDuration,
      });
      if (token) {
        policy.markUserData();
      }
      return token;
    },
  };
}

/**
 * The origins the CSRF guard accepts besides the request's own: the app's public origin (when it
 * is configured, since behind a proxy the request's URL can name another origin) and the
 * `allowedOrigins` the app lists.
 */
function allowedOriginsOf(options: ResolvedAdapterOptions): string[] {
  const listed = options.csrf === false ? [] : (options.csrf?.allowedOrigins ?? []);
  return options.origin ? [new URL(options.origin).origin, ...listed] : [...listed];
}

/**
 * The CSRF guard for a request, before the app's handler runs: `undefined` lets it through, and
 * a response is the ready 403. It only looks at requests that carry the session cookie, so
 * the guard never rejects a sign-in form or a public page (see `checkCsrf`).
 */
export function csrfRejection(
  request: Request,
  options: ResolvedAdapterOptions,
): Response | undefined {
  if (options.csrf === false) {
    return undefined;
  }
  const result = checkCsrf(request, {
    allowedOrigins: allowedOriginsOf(options),
    cookieName: options.cookieName,
  });
  return result.ok ? undefined : result.response;
}

/** A `302` to `location` that carries the cookies and headers queued by `cookies`. */
export function redirectWithCookies(
  location: string,
  cookies: { applyToResponse(r: Response): Response },
): Response {
  const response = new Response(null, {
    status: 302,
    headers: { Location: location, ...SSR_NO_CACHE_HEADERS },
  });
  return cookies.applyToResponse(response);
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ status, message, data: {} }), {
    status,
    headers: { "Content-Type": "application/json", ...SSR_NO_CACHE_HEADERS },
  });
}

/** The provider name in `{oauth2Start}/{provider}`, or `null` when the path has none. */
function providerOf(pathname: string, start: string): string | null {
  const rest = pathname.slice(start.length + 1);
  if (rest === "" || rest.includes("/")) {
    return null;
  }
  try {
    return decodeURIComponent(rest);
  } catch {
    return null;
  }
}

/**
 * The adapter's routes. Returns the route's response, or `undefined` when the request is not for
 * one of them (the app then handles it). The renew and popup routes run their own origin checks.
 */
export async function handleRoute(
  request: Request,
  options: ResolvedAdapterOptions,
): Promise<Response | undefined> {
  const { pathname, searchParams } = new URL(request.url);
  const { routes } = options;
  const secure = secureFor(request, options);
  const common = {
    url: options.url,
    sessionCache: options.sessionCache,
    cookieName: options.cookieName,
    cookieOptions: options.cookieOptions,
    readableCookie: options.readableCookie,
    lang: options.lang,
    clock: options.clock,
    fetch: options.fetch,
    secure,
  };

  if (routes.renew !== false && pathname === routes.renew) {
    return handleBrowserTokenRenew(request, {
      ...common,
      superuser: options.superuser,
      duration: options.browserTokenDuration,
      allowedOrigins: allowedOriginsOf(options),
    });
  }
  if (routes.popup !== false && pathname === routes.popup) {
    return handlePopupHandOff(request, {
      ...common,
      allowedOrigins: allowedOriginsOf(options),
    });
  }

  if (routes.oauth2Start !== false && pathname.startsWith(`${routes.oauth2Start}/`)) {
    if (request.method !== "GET") {
      return methodNotAllowed("GET");
    }
    const provider = providerOf(pathname, routes.oauth2Start);
    // without a callback route there is no redirect URI to send the provider to
    if (provider === null || routes.oauth2Callback === false) {
      return jsonError(404, "Not found.");
    }
    const cookies = createRequestCookieAdapter(request, { secure });
    const origin = appOrigin(request, options);
    const server = await createServerClient({ ...common, origin, cookies });
    try {
      const location = await server.startOAuth2(provider, {
        callbackUrl: new URL(routes.oauth2Callback, origin).href,
        redirectTo: searchParams.get("redirectTo") ?? "/",
      });
      return redirectWithCookies(location, cookies);
    } catch (err: unknown) {
      if (err instanceof OAuth2Error) {
        const status =
          err.kind === "unknown-provider" ? 404 : err.kind === "unsupported-provider" ? 400 : 500;
        return jsonError(status, err.message);
      }
      if (err instanceof ClientResponseError) {
        return jsonError(502, "iglo.base refused the OAuth2 start.");
      }
      throw err;
    }
  }

  if (routes.oauth2Callback !== false && pathname === routes.oauth2Callback) {
    if (request.method !== "GET") {
      return methodNotAllowed("GET");
    }
    const cookies = createRequestCookieAdapter(request, { secure });
    const server = await createServerClient({
      ...common,
      origin: appOrigin(request, options),
      cookies,
    });
    const result = await server.completeOAuth2(request.url);
    const target = new URL(result.redirectTo, appOrigin(request, options));
    if (!result.ok) {
      target.searchParams.set(
        "oauth2_error",
        result.error instanceof OAuth2Error ? result.error.kind : "server",
      );
    }
    // absolute: Next.js parses a middleware's Location header without a base URL
    return redirectWithCookies(target.href, cookies);
  }

  return undefined;
}

function methodNotAllowed(allow: string): Response {
  const response = jsonError(405, "Method not allowed.");
  response.headers.set("Allow", allow);
  return response;
}
