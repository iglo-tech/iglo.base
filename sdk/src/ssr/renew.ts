// docs/design/13-ssr.md ("Browser client and realtime", "CSRF"). The route's shape follows
// handlePopupHandOff (popup.ts): POST only, the Origin check always runs, and every answer
// carries SSR_NO_CACHE_HEADERS.
import { ClientResponseError } from "@sdk/ClientResponseError";
import { SSR_NO_CACHE_HEADERS, createRequestCookieAdapter } from "@sdk/ssr/cookies";
import { checkOrigin } from "@sdk/ssr/csrf";
import { mintBrowserToken } from "@sdk/ssr/browser-token";
import { createServerClient, type ServerClient } from "@sdk/ssr/server-client";
import type { SuperuserClient } from "@sdk/ssr/superuser-client";
import type {
  BrowserToken,
  CreateServerClientOptions,
  MintBrowserTokenOptions,
  RequestCookieAdapter,
} from "@sdk/ssr/types";

export interface BrowserTokenRenewOptions
  extends
    Omit<CreateServerClientOptions, "cookies" | "request" | "origin">,
    MintBrowserTokenOptions {
  /** Origins besides the request's own that may call the route (see `checkOrigin`). */
  allowedOrigins?: readonly string[];
  /** Mints with `impersonate`. Without it the server client must be in fallback mode. */
  superuser?: SuperuserClient;
}

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers, ...SSR_NO_CACHE_HEADERS },
  });
}

function errorResponse(status: number, message: string): Response {
  const response = jsonResponse(status, { status, message, data: {} });
  if (status === 405) {
    response.headers.set("Allow", "POST");
  }
  return response;
}

/**
 * The adapter route that renews a browser token: `POST` from the same origin, with the session
 * cookie. It resumes the session through `createServerClient` and checks it with iglo.base
 * (`auth.verify()`): a session revoked since its last check is refused here, though the cache
 * still holds it. On success it answers `200 { token, record, expiresAt, serverTime }` with a
 * freshly minted token, and the session cookie is rewritten if the session was refreshed.
 *
 * Answers: `401` when there is no valid session (the cookie is cleared when iglo.base revoked it,
 * or when impersonate answers `404`: the user was deleted after the check, so the session is
 * over), `403` for a foreign origin, `405` for another method, and `503` when iglo.base cannot be
 * reached, when the session check fails for another reason, or when impersonate answers `401` or
 * `403` (the superuser credentials were refused: missing, expired, revoked, or not a superuser's)
 * or fails for another reason. A `503` keeps the session cookie: the user's session is fine, and
 * an operator's credential problem must not sign every user out. A missing configuration (no
 * superuser client and no `readableCookie`) throws before any request to iglo.base is made.
 */
export async function handleBrowserTokenRenew(
  request: Request,
  { allowedOrigins, superuser, duration, ...options }: BrowserTokenRenewOptions,
): Promise<Response> {
  if (request.method !== "POST") {
    return errorResponse(405, "Method not allowed.");
  }
  const origin = checkOrigin(request, allowedOrigins);
  if (!origin.ok) {
    return errorResponse(403, "Cross-site request rejected.");
  }
  if (!superuser && options.readableCookie !== true) {
    // a configuration error: thrown before the session is checked or refreshed
    throw new TypeError(
      "handleBrowserTokenRenew needs a superuser client, or readableCookie: true",
    );
  }

  const cookies = createRequestCookieAdapter(request, { secure: options.secure });
  let client: ServerClient;
  try {
    client = await createServerClient({ ...options, cookies });
    await client.auth.verify();
  } catch (err: unknown) {
    if (!(err instanceof ClientResponseError)) {
      throw err;
    }
    if (err.status === 401 || err.status === 403 || err.status === 404) {
      return withCookies(errorResponse(401, "The session is not valid."), cookies);
    }
    return errorResponse(503, "The session could not be checked. Try again.");
  }

  let minted: BrowserToken | null;
  try {
    minted = await mintBrowserToken(client, superuser, { duration });
  } catch (err: unknown) {
    if (!(err instanceof ClientResponseError)) {
      throw err; // a programming error, not a sign-in problem
    }
    if (err.status === 404) {
      // impersonate found no such record (deleted since the check): the session is over.
      // Clearing the client's auth store clears the session cookie through the adapter.
      client.authStore.clear();
      return withCookies(errorResponse(401, "The session is not valid."), cookies);
    }
    // 401 and 403 are the superuser credentials refused (missing, expired, revoked, or not a
    // superuser's), not the user's session: the cookie is kept. The session may have been
    // refreshed by the check, so its cookie is written either way.
    return withCookies(
      errorResponse(503, "The browser token could not be minted. Try again."),
      cookies,
    );
  }
  if (!minted) {
    return withCookies(errorResponse(401, "The session is not valid."), cookies);
  }
  return withCookies(jsonResponse(200, minted), cookies);
}

function withCookies(response: Response, cookies: RequestCookieAdapter): Response {
  cookies.applyToResponse(response);
  return response;
}
