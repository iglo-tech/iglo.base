// Upstream: apis/health.go
//
// Only the guest response is ported. The superuser response (canBackup,
// realIP, possibleProxyHeader in "data") needs auth and lands in M2.3.

import type { App } from "@/app/app";
import type { RequestEvent } from "@/app/event-request";
import type { RouterGroup } from "@/server/group";
import type { HandlerResult } from "@/server/handler";

// bindHealthApi registers the health api endpoint.
export function bindHealthApi(_app: App, rg: RouterGroup<RequestEvent>): void {
  const subGroup = rg.group("/health");
  subGroup.GET("", healthCheck);
}

// healthCheck returns a 200 OK response if the server is healthy.
function healthCheck(e: RequestEvent): HandlerResult {
  // same key order as upstream's struct: message, code, data
  return e.json(200, { message: "API is healthy.", code: 200, data: {} });
}
