// Upstream: apis/middlewares.go (rejectUnknownToken)

import type { RequestEvent } from "@/app/event-request";
import { getAuthTokenFromRequest } from "@/middlewares/load-auth-token";
import {
  DefaultRejectUnknownTokenMiddlewareId,
  DefaultRejectUnknownTokenMiddlewarePriority,
} from "@/middlewares/middlewares";
import type { Handler } from "@/server/handler";

// rejectUnknownToken responds 401 to a request whose Authorization token
// loads no auth record (unknown, invalid or expired, for example after a
// password change), instead of running it as a guest.
//
// It runs after loadAuthToken and the route's own middlewares (priority
// 9999), and before the route's action. This middleware is registered by
// default for all routes.
export function rejectUnknownToken(): Handler<RequestEvent> {
  return {
    id: DefaultRejectUnknownTokenMiddlewareId,
    priority: DefaultRejectUnknownTokenMiddlewarePriority,
    func: (e) => {
      // there is a token with the request but no associated auth record,
      // meaning that most likely the token is unknown, invalid or expired
      // (e.g. the user changed their password)
      if (e.auth === undefined && getAuthTokenFromRequest(e) !== "") {
        return e.unauthorizedError("", new Error("unknown authorization token"));
      }

      return e.next();
    },
  };
}
