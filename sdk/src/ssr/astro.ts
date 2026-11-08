// docs/design/13-ssr.md ("Framework adapters", "Session cookie", "Session cache, check and refresh",
// "Browser client and realtime", "OAuth2", "CSRF").
//
// The Astro adapter: a middleware (`export const onRequest = auth.onRequest`).
//
// Cookie choice: reads come from the request's `Cookie` header, because Astro's cookie store has
// no `getAll`. Writes go through `context.cookies.set`, which Astro applies to the response the
// page renders. The `Set-Cookie` headers of the final response are never used. The no-cache
// headers are set on the response `next()` returns whenever the request carries user data (see
// `NoStorePolicy` in adapter.ts). Route answers carry their own cookies and headers.
//
// Typed structurally: nothing here imports `astro`.
import type { SerializeOptions } from "@sdk/tools/cookie";
import { createRequestCookieAdapter, type CookieAdapter } from "@sdk/ssr/index";
import {
  csrfRejection,
  handleRoute,
  noStorePolicy,
  resolveAdapterOptions,
  resumeSession,
  type AdapterOptions,
  type ResolvedAdapterOptions,
} from "@sdk/ssr/adapter";

export interface AstroCookieStore {
  get(name: string): { value: string } | undefined;
  set(name: string, value: string, options?: Record<string, unknown>): void;
  delete(name: string, options?: Record<string, unknown>): void;
}

export interface AstroContext {
  request: Request;
  url: URL;
  cookies: AstroCookieStore;
  locals: object;
}

export interface AstroAuth {
  /**
   * An Astro middleware (`export const onRequest = auth.onRequest`). Sets `context.locals.pb` and
   * `context.locals.pbBrowserToken`, answers the adapter routes and the CSRF guard, else returns
   * `next()`.
   */
  onRequest(context: AstroContext, next: () => Promise<Response>): Promise<Response>;
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

/** The serialize options of a core cookie write, in Astro's `cookies.set` shape. */
function astroOptions(options: SerializeOptions | undefined): Record<string, unknown> {
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

/**
 * Creates the Astro auth. Throws a `TypeError` without a superuser client and without
 * `readableCookie: true` (see `resolveAdapterOptions`).
 */
export function createAstroAuth(options: AdapterOptions): AstroAuth {
  const resolved: ResolvedAdapterOptions = resolveAdapterOptions(options);

  return {
    onRequest: async (context, next) => {
      const request = context.request;
      // the no-cache headers go on every response of this request once it carries user data
      const policy = noStorePolicy(request, resolved);

      const denied = csrfRejection(request, resolved);
      if (denied) {
        return policy.apply(denied);
      }
      // the routes run before the session is resumed (see sveltekit.ts)
      const routed = await handleRoute(request, resolved);
      if (routed) {
        return policy.apply(routed);
      }

      const requestCookies = createRequestCookieAdapter(request);
      const cookies: CookieAdapter = {
        getAll: () => requestCookies.getAll(),
        isSecure: requestCookies.isSecure,
        setAll: (toSet) => {
          for (const c of toSet) {
            context.cookies.set(c.name, c.value, astroOptions(c.options));
          }
        },
      };

      const session = await resumeSession(cookies, request, resolved, policy);
      Object.assign(context.locals, {
        pb: session.server,
        pbBrowserToken: session.browserToken,
      });

      // read after next(): the page's render may write cookies or mint a token
      return policy.apply(await next());
    },
  };
}
