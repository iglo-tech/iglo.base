// docs/design/13-ssr.md ("Framework adapters": @iglo.tech/iglo.base/ssr/next; "Session cookie"; "Session cache,
// check and refresh"; "CSRF"; "OAuth2"). The Next.js App Router adapter. proxy.ts (Next.js 16) or
// middleware.ts (Next.js 15.5, Node.js runtime) resumes the session on every request and forwards
// the refreshed cookies in the request it passes on, so Server Components (which cannot set cookies)
// read the session the middleware prepared. Server Components have no response of their own, so the
// no-cache headers come from the middleware's response and from the dynamic rendering of pages that
// read cookies. Next.js sets no-store on Server Action responses itself, and a Route Handler that
// changes the session sets the headers in its own response (docs/design/13-ssr.md, "Next.js").
import {
  csrfRejection,
  handleRoute,
  noStorePolicy,
  resolveAdapterOptions,
  resumeSession,
  withMutableHeaders,
  type AdapterOptions,
  type RequestSession,
  type ResolvedAdapterOptions,
} from "@sdk/ssr/adapter";
import { isHttpLocalUrl } from "@sdk/ssr/cookies";
import { createRequestCookieAdapter, type CookieAdapter, type CookieToSet } from "@sdk/ssr/index";
import type { SerializeOptions } from "@sdk/tools/cookie";

/** The cookie security the middleware resolved, passed on to the page as `"1"` or `"0"`. */
const SECURE_HEADER = "x-iglo-base-secure";
/** Every request header under this prefix belongs to the adapter: a client's copy is dropped. */
const ADAPTER_HEADER_PREFIX = "x-iglo-base-";

/**
 * What `cookies()` from `next/headers` returns, typed structurally. Values are the raw text the
 * browser sent. `set` is missing from the read-only store type, and it throws at runtime inside
 * Server Components; the adapter swallows that and keeps the refreshed session in memory.
 */
export interface NextCookieStore {
  getAll(): Array<{ name: string; value: string }>;
  set?(name: string, value: string, options?: SerializeOptions): unknown;
}

export interface NextAuthOptions extends AdapterOptions {
  /** NextResponse.next, supplied by the app: `next: (init) => NextResponse.next(init)`. The adapter cannot import next/server. */
  next: (init: { request: { headers: Headers } }) => Response;
}

export interface NextAuth {
  /**
   * middleware.ts: answers the CSRF guard and the adapter routes, and otherwise resumes the session.
   * The pass-through response gets the cookies the session wrote, and the request it forwards gets
   * the same cookies in its `Cookie` header, so Server Components read the refreshed session.
   */
  middleware(request: Request): Promise<Response>;
  /**
   * Server Components, route handlers and server actions: resumes the session from the cookie
   * store the middleware prepared. Cookie writes are attempted and swallowed (a read-only store
   * throws); a refresh made here updates memory only.
   */
  serverSession(input: {
    cookies: NextCookieStore;
    headers?: { get(name: string): string | null };
  }): Promise<RequestSession>;
}

/**
 * The cookie security from the options alone: `secure`, else the app origin's scheme. `undefined`
 * when neither is set, so the request decides (as the core does).
 */
function configuredSecure(options: ResolvedAdapterOptions): boolean | undefined {
  if (options.secure !== undefined) {
    return options.secure;
  }
  if (options.origin !== undefined) {
    return !isHttpLocalUrl(options.origin);
  }
  return undefined;
}

function parseSecureFlag(value: string | null): boolean | undefined {
  if (value === "1") {
    return true;
  }
  if (value === "0") {
    return false;
  }
  return undefined;
}

/** The raw `name=value` pairs of a Cookie header, in order. */
function cookiePairs(header: string): Array<{ name: string; raw: string }> {
  const pairs: Array<{ name: string; raw: string }> = [];
  for (const part of header.split(";")) {
    const pair = part.trim();
    if (pair === "") {
      continue;
    }
    const eq = pair.indexOf("=");
    pairs.push(eq === -1 ? { name: pair, raw: pair } : { name: pair.slice(0, eq), raw: pair });
  }
  return pairs;
}

/**
 * The Cookie header of the forwarded request: the browser's cookies with the written ones replaced,
 * removed (an empty value) or added. Values are percent-encoded, as the browser would send them.
 * Cookies the session did not touch are kept as the browser sent them.
 */
function cookieHeaderWith(header: string, written: CookieToSet[]): string {
  const changes = new Map<string, string | null>();
  for (const cookie of written) {
    changes.set(cookie.name, cookie.value === "" ? null : encodeURIComponent(cookie.value));
  }
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const pair of cookiePairs(header)) {
    if (!changes.has(pair.name)) {
      parts.push(pair.raw);
      continue;
    }
    seen.add(pair.name);
    const value = changes.get(pair.name);
    if (value !== null && value !== undefined) {
      parts.push(`${pair.name}=${value}`);
    }
  }
  for (const [name, value] of changes) {
    if (!seen.has(name) && value !== null) {
      parts.push(`${name}=${value}`);
    }
  }
  return parts.join("; ");
}

/**
 * The headers the page's request is forwarded with. Any `x-iglo-base-*` header the client sent is
 * dropped first, so only the middleware's own copy of the flag reaches the page.
 */
function forwardedHeaders(request: Request, written: CookieToSet[], secure: boolean): Headers {
  const headers = new Headers();
  request.headers.forEach((value, name) => {
    if (!name.startsWith(ADAPTER_HEADER_PREFIX)) {
      headers.append(name, value);
    }
  });
  headers.set(SECURE_HEADER, secure ? "1" : "0");
  if (written.length > 0) {
    headers.set("cookie", cookieHeaderWith(headers.get("cookie") ?? "", written));
  }
  return headers;
}

/** A cookie store's writes, through its `set` (a read-only store has none, or it throws). */
function storeWriter(cookies: NextCookieStore): (toSet: CookieToSet[]) => void {
  return (toSet) => {
    for (const cookie of toSet) {
      try {
        cookies.set?.(cookie.name, cookie.value, cookie.options);
      } catch {
        // a Server Component's store throws here: the refreshed session stays in memory only
      }
    }
  };
}

/**
 * The Next.js App Router adapter. The options carry the app's session cache and superuser client,
 * which it creates once; nothing here keeps state between requests.
 *
 * It runs on the Node.js runtime only: Next.js 16 `proxy.ts` always does, and Next.js 15.5
 * `middleware.ts` does with `export const runtime = "nodejs"`. The Edge runtime is not supported.
 * On Edge the package's browser condition resolves to a stub, so the import fails at build time
 * or the app answers every request with the stub's error (docs/design/13-ssr.md, "Runtime").
 *
 * @throws {TypeError} without a superuser client and without `readableCookie: true`
 */
export function createNextAuth(options: NextAuthOptions): NextAuth {
  const resolved = resolveAdapterOptions(options);
  const passThrough = options.next;

  async function middleware(request: Request): Promise<Response> {
    // Server Components cannot set headers, so only the middleware's own response gets them here
    const policy = noStorePolicy(request, resolved);
    const rejected = csrfRejection(request, resolved);
    if (rejected) {
      return policy.apply(rejected);
    }
    const routed = await handleRoute(request, resolved);
    if (routed) {
      return policy.apply(routed);
    }

    const cookies = createRequestCookieAdapter(request, { secure: configuredSecure(resolved) });
    const secure = cookies.isSecure;
    await resumeSession(cookies, request, { ...resolved, secure }, policy);

    let response = passThrough({
      request: { headers: forwardedHeaders(request, cookies.queuedCookies, secure) },
    });
    if (cookies.queuedCookies.length > 0) {
      // the cookies are written onto the response, so its headers must be mutable
      response = withMutableHeaders(response);
      cookies.applyToResponse(response);
    }
    return policy.apply(response);
  }

  async function serverSession(input: {
    cookies: NextCookieStore;
    headers?: { get(name: string): string | null };
  }): Promise<RequestSession> {
    // the middleware's flag names the cookie; the app's own setting wins over it, and the origin
    // decides only when the middleware did not run (no flag)
    const flag = parseSecureFlag(input.headers?.get(SECURE_HEADER) ?? null);
    const secure =
      resolved.secure ??
      flag ??
      (resolved.origin !== undefined ? !isHttpLocalUrl(resolved.origin) : true);

    const cookies: CookieAdapter = {
      getAll: () => input.cookies.getAll(),
      setAll: storeWriter(input.cookies),
      isSecure: secure,
    };
    // resumeSession wants the request for its origin, which the explicit `secure` makes unused
    const request = new Request(resolved.origin ?? "http://localhost/");
    return resumeSession(cookies, request, { ...resolved, secure });
  }

  return { middleware, serverSession };
}
