// Upstream: apis/middlewares.go (superuserIPsWhitelist)
//
// Placeholder: holds the middleware's id and priority in the default chain
// and only calls the next handler. The middleware itself is ported in
// M1.3 (settings), which owns the SuperuserIPs setting it reads.

import type { RequestEvent } from "@/app/event-request";
import type { Handler } from "@/server/handler";
import {
  DefaultSuperuserIPsWhitelistMiddlewareId,
  DefaultSuperuserIPsWhitelistMiddlewarePriority,
} from "@/middlewares/middlewares";

export function superuserIPsWhitelist(): Handler<RequestEvent> {
  return {
    id: DefaultSuperuserIPsWhitelistMiddlewareId,
    priority: DefaultSuperuserIPsWhitelistMiddlewarePriority,
    func: (e) => e.next(),
  };
}
