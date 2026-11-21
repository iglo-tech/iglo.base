// Upstream: apis/record_auth_refresh.go
//
// The OnRecordAuthRefreshRequest hook is not ported (no extension
// surface): its default action runs directly.

import type { RequestEvent } from "@/app/event-request";
import { recordAuthResponse } from "@/apis/record-helpers";
import { getAuthTokenFromRequest } from "@/middlewares/load-auth-token";
import { newAuthToken, TokenClaimRefreshable } from "@/records/record-tokens";
import type { HandlerResult } from "@/server/handler";
import { JWTError, parseUnverifiedJWT } from "@/tools/security/jwt";
import type { MapClaims } from "@/tools/security/jwt";
import { toBool } from "@/tools/types/cast";

export async function recordAuthRefresh(e: RequestEvent): Promise<HandlerResult> {
  const record = e.auth;
  if (record === undefined) {
    return e.notFoundError("Missing auth record context.", null);
  }

  let token = getAuthTokenFromRequest(e);

  // skip token renewal if the token's payload doesn't explicitly allow it (e.g. impersonate tokens)
  let claims: MapClaims;
  try {
    claims = parseUnverifiedJWT(token, e.app.clock);
  } catch (error) {
    // upstream reads the claims parsed before the error
    claims = error instanceof JWTError ? error.claims : {};
  }
  if (Object.hasOwn(claims, TokenClaimRefreshable) && toBool(claims[TokenClaimRefreshable])) {
    try {
      token = newAuthToken(record, e.app.clock);
    } catch (error) {
      return e.internalServerError("Failed to refresh auth token.", error);
    }
  }

  return recordAuthResponse(e, record, token, "", undefined);
}
