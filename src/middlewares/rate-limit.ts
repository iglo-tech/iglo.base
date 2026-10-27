// Upstream: apis/middlewares_rate_limit.go (rateLimit)
//
// Placeholder: holds the middleware's id and priority in the default chain
// and only calls the next handler. The middleware itself is ported in
// M4.8 (rate limiter).

import type { RequestEvent } from "@/app/event-request";
import type { Handler } from "@/server/handler";
import {
  DefaultRateLimitMiddlewareId,
  DefaultRateLimitMiddlewarePriority,
} from "@/middlewares/middlewares";

export function rateLimit(): Handler<RequestEvent> {
  return {
    id: DefaultRateLimitMiddlewareId,
    priority: DefaultRateLimitMiddlewarePriority,
    func: (e) => e.next(),
  };
}
