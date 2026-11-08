// docs/design/13-ssr.md ("Framework adapters", "Session cookie", "Session cache, check and refresh",
// "Browser client and realtime", "OAuth2", "CSRF").
//
// The SvelteKit adapter: a `handle` hook. The session is resumed from `event.cookies`, the server
// client and the browser-token function go on `event.locals`, and the adapter's routes and the
// CSRF guard run before the app's `resolve`. Cookie writes go to `event.cookies.set`, which
// SvelteKit applies to the response `resolve` returns. Those writes also set the no-cache headers
// on that response, when it does not carry them already (`event.setHeaders` is not used, since it
// is missing on some SvelteKit versions).
//
// Typed structurally: nothing here imports `@sveltejs/kit`.
import type { SerializeOptions } from "@sdk/tools/cookie";
import {
  createRequestCookieAdapter,
  SSR_NO_CACHE_HEADERS,
  type BrowserToken,
  type CookieAdapter,
  type CookieToSet,
  type ServerClient,
} from "@sdk/ssr/index";
import {
  csrfRejection,
  handleRoute,
  resolveAdapterOptions,
  resumeSession,
  type AdapterOptions,
  type ResolvedAdapterOptions,
} from "@sdk/ssr/adapter";

export interface SvelteKitCookies {
  getAll(): Array<{ name: string; value: string }>;
  set(
    name: string,
    value: string,
    options: {
      path: string;
      httpOnly?: boolean;
      sameSite?: boolean | "lax" | "strict" | "none";
      secure?: boolean;
      maxAge?: number;
      expires?: Date;
      domain?: string;
    },
  ): void;
}

export interface SvelteKitEvent {
  request: Request;
  url: URL;
  cookies: SvelteKitCookies;
  locals: object;
}

export interface SvelteKitAuth {
  /**
   * Use as `export const handle = auth.handle` (or inside `sequence()`). Resumes the session, sets
   * `event.locals.pb` and `event.locals.pbBrowserToken`, answers the adapter routes and the CSRF
   * guard, then calls `resolve(event)`.
   */
  handle(input: {
    event: SvelteKitEvent;
    resolve(event: SvelteKitEvent): Promise<Response>;
  }): Promise<Response>;
}

/** What the handle hook puts on `event.locals`; the app declares it in its `App.Locals` type. */
export interface SvelteKitLocals {
  pb: ServerClient;
  pbBrowserToken: () => Promise<BrowserToken | null>;
}

type SameSite = boolean | "lax" | "strict" | "none";

function sameSiteOf(value: boolean | string | undefined): SameSite | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === "lax" || value === "strict" || value === "none") {
    return value;
  }
  return undefined;
}

/** The serialize options of a core cookie write, in SvelteKit's `cookies.set` shape. */
function svelteKitOptions(options: SerializeOptions | undefined) {
  return {
    path: options?.path ?? "/",
    httpOnly: options?.httpOnly,
    sameSite: sameSiteOf(options?.sameSite),
    secure: options?.secure,
    maxAge: options?.maxAge,
    expires: options?.expires,
    domain: options?.domain,
  };
}

/** Sets the no-cache headers the response does not carry yet. A response with locked headers is sent as it is. */
function withNoCacheHeaders(response: Response): Response {
  for (const [name, value] of Object.entries(SSR_NO_CACHE_HEADERS)) {
    try {
      if (!response.headers.has(name)) {
        response.headers.set(name, value);
      }
    } catch {
      // immutable headers: the response goes out without them
    }
  }
  return response;
}

/**
 * Creates the SvelteKit auth. Throws a `TypeError` without a superuser client and without
 * `readableCookie: true` (see `resolveAdapterOptions`).
 */
export function createSvelteKitAuth(options: AdapterOptions): SvelteKitAuth {
  const resolved: ResolvedAdapterOptions = resolveAdapterOptions(options);

  return {
    handle: async ({ event, resolve }) => {
      const request = event.request;

      const denied = csrfRejection(request, resolved);
      if (denied) {
        return denied;
      }
      // the routes run before the session is resumed: they make their own client, so a
      // request answered by a route is not refreshed twice
      const routed = await handleRoute(request, resolved);
      if (routed) {
        return routed;
      }

      const requestCookies = createRequestCookieAdapter(request);
      let wrote = false;
      const cookies: CookieAdapter = {
        getAll: () => event.cookies.getAll(),
        isSecure: requestCookies.isSecure,
        setAll: (toSet: CookieToSet[]) => {
          wrote = true;
          for (const c of toSet) {
            event.cookies.set(c.name, c.value, svelteKitOptions(c.options));
          }
        },
      };

      const session = await resumeSession(cookies, request, resolved);
      Object.assign(event.locals, {
        pb: session.server,
        pbBrowserToken: session.browserToken,
      } satisfies SvelteKitLocals);

      const response = await resolve(event);
      return wrote ? withNoCacheHeaders(response) : response;
    },
  };
}
