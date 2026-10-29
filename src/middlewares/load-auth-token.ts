// Upstream: apis/middlewares.go (loadAuthToken, getAuthTokenFromRequest)
//
// The records are looked up in e.app. Upstream's debug log of a failed
// lookup is left out (application code logs only errors).

import type { RequestEvent } from "@/app/event-request";
import { equalFold } from "@/collections/go-strings";
import { findAuthRecordByToken } from "@/records/record-query";
import { TokenTypeAuth } from "@/records/record-tokens";
import type { Handler } from "@/server/handler";
import {
  DefaultLoadAuthTokenMiddlewareId,
  DefaultLoadAuthTokenMiddlewarePriority,
} from "@/middlewares/middlewares";

// loadAuthToken attempts to load the auth context based on the "Authorization: TOKEN" header value.
//
// This middleware does nothing in case of:
//   - missing, invalid or expired token
//   - e.auth is already loaded by another middleware
//
// This middleware is registered by default for all routes.
//
// Note: We don't throw an error on invalid or expired token (upstream
// leaves the handling to later middlewares).
export function loadAuthToken(): Handler<RequestEvent> {
  return {
    id: DefaultLoadAuthTokenMiddlewareId,
    priority: DefaultLoadAuthTokenMiddlewarePriority,
    func: (e) => {
      // already loaded by another middleware
      if (e.auth !== undefined) {
        return e.next();
      }

      const token = getAuthTokenFromRequest(e);
      if (token === "") {
        return e.next();
      }

      try {
        e.auth = findAuthRecordByToken(e.app, token, TokenTypeAuth);
      } catch {
        // a missing, invalid or expired token leaves the request a guest
      }

      return e.next();
    },
  };
}

export function getAuthTokenFromRequest(e: RequestEvent): string {
  const token = e.request.headers.get("Authorization") ?? "";

  // the "Bearer" schema prefix is not required by PocketBase and it is
  // supported only for compatibility with the defaults of some HTTP clients
  if (token.length > 7 && equalFold(token.slice(0, 7), "Bearer ")) {
    return token.slice(7);
  }

  return token;
}
