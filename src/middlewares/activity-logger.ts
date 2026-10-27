// Upstream: apis/middlewares.go (activityLogger)
//
// Placeholder: holds the middleware's id and priority in the default chain
// and only calls the next handler. The middleware itself is ported in
// M5.5 (request logs).

import type { RequestEvent } from "@/app/event-request";
import type { Handler } from "@/server/handler";
import {
  DefaultActivityLoggerMiddlewareId,
  DefaultActivityLoggerMiddlewarePriority,
} from "@/middlewares/middlewares";

export function activityLogger(): Handler<RequestEvent> {
  return {
    id: DefaultActivityLoggerMiddlewareId,
    priority: DefaultActivityLoggerMiddlewarePriority,
    func: (e) => e.next(),
  };
}
