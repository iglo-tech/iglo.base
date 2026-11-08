// docs/design/13-ssr.md ("CSRF"). Convex Auth, Lucia and Better Auth check the Origin the same way.
import {
  createRequestCookieAdapter,
  DEFAULT_COOKIE_KEY,
  findSessionCookie,
} from "@sdk/ssr/cookies";

export interface CsrfOptions {
  /**
   * Origins besides the request's own that may send state-changing requests, for example
   * `https://www.example.com` when the app is served under two origins. Each entry must be an
   * origin: a scheme, a host and an optional port, with no path.
   */
  allowedOrigins?: readonly string[];
  /** The session cookie's base name (default `pb_auth`). */
  cookieName?: string;
}

export type OriginCheck = { ok: true } | { ok: false; reason: "missing-origin" | "foreign-origin" };

export type CsrfResult =
  | { ok: true }
  | { ok: false; reason: "missing-origin" | "foreign-origin"; response: Response };

const STATE_CHANGING_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function normalizeAllowed(allowedOrigins: readonly string[] | undefined): string[] {
  return (allowedOrigins ?? []).map((entry) => {
    let parsed: URL;
    try {
      parsed = new URL(entry);
    } catch {
      throw new TypeError(`allowedOrigins entry is not a URL: ${entry}`);
    }
    if (parsed.origin === "null" || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      throw new TypeError(`allowedOrigins entry is not an origin: ${entry}`);
    }
    return parsed.origin;
  });
}

/**
 * Whether the request comes from its own origin or an allowed one. `Origin` decides; `Referer`
 * is read only when `Origin` is absent. A request with neither, or with an `Origin` the browser
 * sent as `null`, is rejected. The request's own origin comes from its URL: behind a proxy that
 * changes the public origin, list the public origin in `allowedOrigins`.
 */
export function checkOrigin(request: Request, allowedOrigins?: readonly string[]): OriginCheck {
  // a configuration error is reported on every request, not only on those that reach the list
  const allowed = normalizeAllowed(allowedOrigins);
  const origin = request.headers.get("origin");
  const source = origin ?? request.headers.get("referer");
  if (source === null || source === "") {
    return { ok: false, reason: "missing-origin" };
  }

  let sourceOrigin: string;
  try {
    sourceOrigin = new URL(source).origin;
  } catch {
    return { ok: false, reason: "foreign-origin" };
  }
  if (sourceOrigin === "null") {
    return { ok: false, reason: "foreign-origin" };
  }

  const own = new URL(request.url).origin;
  if (sourceOrigin === own || allowed.includes(sourceOrigin)) {
    return { ok: true };
  }
  return { ok: false, reason: "foreign-origin" };
}

/**
 * The CSRF guard for an adapter's request handler, called before the handler runs. It rejects
 * `POST`, `PUT`, `PATCH` and `DELETE` requests that carry the session cookie unless their origin
 * passes `checkOrigin`. Requests without the session cookie, and `GET`, `HEAD` and `OPTIONS`,
 * pass. A rejection carries a ready 403 `Response`. Frameworks with their own check (Next.js
 * Server Actions) may skip this.
 */
export function checkCsrf(request: Request, options: CsrfOptions = {}): CsrfResult {
  if (!STATE_CHANGING_METHODS.has(request.method.toUpperCase())) {
    return { ok: true };
  }
  const cookies = createRequestCookieAdapter(request).getAll();
  if (!findSessionCookie(cookies, options.cookieName ?? DEFAULT_COOKIE_KEY)) {
    return { ok: true };
  }

  const check = checkOrigin(request, options.allowedOrigins);
  if (check.ok) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: check.reason,
    response: new Response(
      JSON.stringify({ status: 403, message: "Cross-site request rejected.", data: {} }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    ),
  };
}
