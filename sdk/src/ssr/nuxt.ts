// docs/design/13-ssr.md ("Framework adapters", "Session cookie", "Session cache, check and refresh",
// "Browser client and realtime", "OAuth2", "CSRF").
//
// The Nuxt (Nitro) adapter: a server middleware. It takes a small structural event, not h3's,
// so nothing here imports `h3` or `nitropack`. The app's wrapper maps h3's event onto it:
//
//   auth.middleware({
//     method: getMethod(event),
//     path: event.path,                        // h3: the path and query
//     headers: event.node.req.headers,         // Node's headers, as they are
//     context: event.context,
//     readBody: () => readBody(event),         // only the popup route reads it
//     setCookie: (name, value, options) => setCookie(event, name, value, options),
//     setHeader: (name, value) => setResponseHeader(event, name, value),
//   })
//
// The middleware builds a Web `Request` from the event (the origin is `origin` from the options,
// else `http(s)://host` from the Host header, with `https` when `x-forwarded-proto` says so). The
// cookies are read from its `Cookie` header and written with `setCookie`. Those writes reach the
// response through the framework's own response. When cookies were written and the request goes
// on, `setHeader` adds the no-cache headers. A route answer is a `Response`: the app sends it
// with its framework's Web-response helper (h3's `sendWebResponse`), which keeps every header,
// Set-Cookie included.
//
// The middleware returns `undefined` to let the request continue. A returned `Response` answers
// it: a route's answer or the CSRF guard's 403.
import type { SerializeOptions } from "@sdk/tools/cookie";
import {
  createRequestCookieAdapter,
  SSR_NO_CACHE_HEADERS,
  type CookieAdapter,
  type CookieToSet,
} from "@sdk/ssr/index";
import {
  csrfRejection,
  handleRoute,
  resolveAdapterOptions,
  resumeSession,
  type AdapterOptions,
  type ResolvedAdapterOptions,
} from "@sdk/ssr/adapter";

/** The options of a cookie write, in the shape h3's `setCookie` takes. */
export interface NuxtCookieOptions {
  path: string;
  httpOnly?: boolean;
  sameSite?: boolean | "lax" | "strict" | "none";
  secure?: boolean;
  maxAge?: number;
  expires?: Date;
  domain?: string;
}

/** The parts of Nitro's event the middleware uses (see the file header for the mapping). */
export interface NuxtEvent {
  /** The request method. */
  method: string;
  /** The request target: the path and query, as h3's `event.path` has them. */
  path: string;
  /** The request headers, as Node has them (`event.node.req.headers`). */
  headers: Record<string, string | string[] | undefined>;
  /** Nitro's per-request context: the middleware sets `pb` and `pbBrowserToken` on it. */
  context: Record<string, unknown>;
  /** Reads the request body as JSON. Only the popup route calls it. */
  readBody?: () => Promise<unknown>;
  /** Writes a cookie on the response (h3's `setCookie`). */
  setCookie(name: string, value: string, options: NuxtCookieOptions): void;
  /** Sets a header on the response (h3's `setResponseHeader`). */
  setHeader(name: string, value: string): void;
}

export interface NuxtAuth {
  /**
   * A Nitro server middleware: sets `event.context.pb` and `event.context.pbBrowserToken`, answers
   * the adapter routes and the CSRF guard, else lets the request continue. Returns a `Response`
   * to answer the request, or `undefined` to continue.
   */
  middleware(event: NuxtEvent): Promise<Response | undefined>;
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

/** The serialize options of a core cookie write, in h3's `setCookie` shape. */
function nuxtOptions(options: SerializeOptions | undefined): NuxtCookieOptions {
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

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(", ") : value;
}

/** The request's origin, as the app's public origin or as the Host header tells it. */
function originOf(headers: Headers, options: ResolvedAdapterOptions): string {
  if (options.origin !== undefined) {
    return options.origin;
  }
  const host = headers.get("host") ?? "localhost";
  const proto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || "http";
  return `${proto}://${host}`;
}

/**
 * The Web request of a Nitro event. The popup route's JSON body is read here, once, since the
 * event's body can be read only once. A body that is not JSON becomes an unreadable body, which
 * the popup route answers with its own 400.
 */
async function requestOf(event: NuxtEvent, options: ResolvedAdapterOptions): Promise<Request> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(event.headers)) {
    const text = headerValue(value);
    if (text !== undefined) {
      headers.set(name, text);
    }
  }
  // a path that starts with "//" must not become a URL on another host
  const url = new URL(`/${event.path.replace(/^\/+/, "")}`, originOf(headers, options));

  let body: string | undefined;
  const isPopup = options.routes.popup !== false && url.pathname === options.routes.popup;
  if (isPopup && event.method === "POST" && event.readBody) {
    try {
      body = JSON.stringify(await event.readBody());
    } catch {
      body = undefined;
    }
  }
  return new Request(url, { method: event.method, headers, body });
}

/**
 * Creates the Nuxt auth. Throws a `TypeError` without a superuser client and without
 * `readableCookie: true` (see `resolveAdapterOptions`).
 */
export function createNuxtAuth(options: AdapterOptions): NuxtAuth {
  const resolved: ResolvedAdapterOptions = resolveAdapterOptions(options);

  return {
    middleware: async (event) => {
      const request = await requestOf(event, resolved);

      const denied = csrfRejection(request, resolved);
      if (denied) {
        return denied;
      }
      // the routes run before the session is resumed (see sveltekit.ts)
      const routed = await handleRoute(request, resolved);
      if (routed) {
        return routed;
      }

      const requestCookies = createRequestCookieAdapter(request);
      let wrote = false;
      const cookies: CookieAdapter = {
        getAll: () => requestCookies.getAll(),
        isSecure: requestCookies.isSecure,
        setAll: (toSet: CookieToSet[]) => {
          wrote = true;
          for (const c of toSet) {
            event.setCookie(c.name, c.value, nuxtOptions(c.options));
          }
        },
      };

      const session = await resumeSession(cookies, request, resolved);
      event.context.pb = session.server;
      event.context.pbBrowserToken = session.browserToken;

      if (wrote) {
        for (const [name, value] of Object.entries(SSR_NO_CACHE_HEADERS)) {
          event.setHeader(name, value);
        }
      }
      return undefined;
    },
  };
}
