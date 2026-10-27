// Upstream: apis/middlewares_body_limit.go (BodyLimit)
//
// Placeholder: holds the middleware's id and priority in the default chain
// and only calls the next handler. The middleware itself is ported in
// M5.7 (body limit).

import type { RequestEvent } from "@/app/event-request";
import type { Handler } from "@/server/handler";
import {
  DefaultBodyLimitMiddlewareId,
  DefaultBodyLimitMiddlewarePriority,
} from "@/middlewares/middlewares";

export function bodyLimit(): Handler<RequestEvent> {
  return {
    id: DefaultBodyLimitMiddlewareId,
    priority: DefaultBodyLimitMiddlewarePriority,
    func: (e) => e.next(),
  };
}
