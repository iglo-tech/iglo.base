// Upstream: apis/middlewares.go (securityHeaders)

import type { RequestEvent } from "@/app/event-request";
import type { Handler } from "@/server/handler";
import {
  DefaultSecurityHeadersMiddlewareId,
  DefaultSecurityHeadersMiddlewarePriority,
} from "@/middlewares/middlewares";

// securityHeaders adds common security headers to the response.
//
// This middleware is registered by default for all routes.
export function securityHeaders(): Handler<RequestEvent> {
  return {
    id: DefaultSecurityHeadersMiddlewareId,
    priority: DefaultSecurityHeadersMiddlewarePriority,
    func: (e) => {
      e.response.header.set("X-XSS-Protection", "1; mode=block");
      e.response.header.set("X-Content-Type-Options", "nosniff");
      e.response.header.set("X-Frame-Options", "SAMEORIGIN");
      e.response.header.set("Cross-Origin-Opener-Policy", "same-origin");

      return e.next();
    },
  };
}
