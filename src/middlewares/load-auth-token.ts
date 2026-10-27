// Upstream: apis/middlewares.go (loadAuthToken)
//
// Placeholder: holds the middleware's id and priority in the default chain
// and only calls the next handler. The middleware itself is ported in
// M2.3 (tokens and auth loading).

import type { RequestEvent } from "@/app/event-request";
import type { Handler } from "@/server/handler";
import {
  DefaultLoadAuthTokenMiddlewareId,
  DefaultLoadAuthTokenMiddlewarePriority,
} from "@/middlewares/middlewares";

export function loadAuthToken(): Handler<RequestEvent> {
  return {
    id: DefaultLoadAuthTokenMiddlewareId,
    priority: DefaultLoadAuthTokenMiddlewarePriority,
    func: (e) => e.next(),
  };
}
