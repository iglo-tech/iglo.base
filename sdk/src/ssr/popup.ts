// docs/design/13-ssr.md ("OAuth2": popup flow; "Browser client and realtime"). The popup's token
// is checked with one auth-refresh, and the session cookie is written from the server's answer.
import { ClientResponseError } from "@sdk/ClientResponseError";
import type { RecordModel } from "@sdk/tools/dtos";
import { getTokenPayload } from "@sdk/tools/jwt";
import { SSR_NO_CACHE_HEADERS, createRequestCookieAdapter } from "@sdk/ssr/cookies";
import { checkOrigin } from "@sdk/ssr/csrf";
import { createServerClient } from "@sdk/ssr/server-client";
import type { CreateServerClientOptions } from "@sdk/ssr/types";

export interface PopupHandOffOptions extends Omit<
  CreateServerClientOptions,
  "cookies" | "request" | "origin"
> {
  /** Origins besides the request's own that may post the token (see `checkOrigin`). */
  allowedOrigins?: readonly string[];
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...SSR_NO_CACHE_HEADERS },
  });
}

function errorResponse(status: number, message: string): Response {
  return jsonResponse(status, { status, message, data: {} });
}

/**
 * The adapter route that completes a popup sign-in. It accepts `POST` with the JSON body
 * `{ "token": "..." }` from the same origin (always checked, with or without a session cookie),
 * and checks the token with one `auth-refresh`. On success the HttpOnly session cookie is written
 * from the refreshed token and record, and the response carries the record only: the token stays
 * in the cookie. The posted token is the only input trusted; nothing else the browser sends is.
 * A revoked token gets 401 and sets no cookie.
 */
export async function handlePopupHandOff(
  request: Request,
  { allowedOrigins, ...options }: PopupHandOffOptions,
): Promise<Response> {
  if (request.method !== "POST") {
    const response = errorResponse(405, "Method not allowed.");
    response.headers.set("Allow", "POST");
    return response;
  }
  const origin = checkOrigin(request, allowedOrigins);
  if (!origin.ok) {
    return errorResponse(403, "Cross-site request rejected.");
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, "The request body must be JSON.");
  }
  const token =
    body && typeof body === "object" && typeof (body as { token?: unknown }).token === "string"
      ? (body as { token: string }).token
      : "";
  const payload = token ? getTokenPayload(token) : {};
  if (!token || payload["type"] !== "auth" || typeof payload["collectionId"] !== "string") {
    return errorResponse(400, "The token is not an auth token.");
  }

  const cookies = createRequestCookieAdapter(request, { secure: options.secure });
  // No cookie is read: the posted token replaces whatever the browser sent before.
  const client = await createServerClient({
    ...options,
    cookies: { getAll: () => [], setAll: cookies.setAll, isSecure: cookies.isSecure },
  });

  let refreshed: { token: string; record: RecordModel };
  try {
    refreshed = await client.send<{ token: string; record: RecordModel }>(
      `/api/collections/${encodeURIComponent(payload["collectionId"])}/auth-refresh`,
      { method: "POST", headers: { Authorization: token } },
    );
  } catch (err: unknown) {
    if (err instanceof ClientResponseError && err.status >= 400 && err.status < 500) {
      return errorResponse(
        err.status === 401 || err.status === 403 ? 401 : err.status,
        err.message,
      );
    }
    return errorResponse(503, "The sign-in could not be checked. Try again.");
  }

  const record = refreshed?.record;
  if (!record || record.id !== payload["id"]) {
    return errorResponse(503, "The sign-in could not be checked. Try again.");
  }
  // authStore.save writes the session cookie and updates the session cache (see ServerClient)
  client.authStore.save(refreshed.token || token, record);

  const response = jsonResponse(200, { record });
  cookies.applyToResponse(response);
  return response;
}
