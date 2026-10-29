// Upstream: apis/health.go
//
// realIP is RemoteIP until the trusted proxy settings are applied to it
// (M5.7, src/app/event-request.ts).

import type { App } from "@/app/app";
import type { RequestEvent } from "@/app/event-request";
import type { RouterGroup } from "@/server/group";
import type { HandlerResult } from "@/server/handler";

// core.StoreKeyActiveBackup (core/backup.go): set while a backup is
// created or restored (M5.3)
export const StoreKeyActiveBackup = "@activeBackup";

// bindHealthApi registers the health api endpoint.
export function bindHealthApi(_app: App, rg: RouterGroup<RequestEvent>): void {
  const subGroup = rg.group("/health");
  subGroup.GET("", healthCheck);
}

// healthCheck returns a 200 OK response if the server is healthy.
function healthCheck(e: RequestEvent): HandlerResult {
  let data: { [key: string]: unknown };

  // @todo evaluate whether it is worth removing the extra info from the health endpoint
  if (e.hasSuperuserAuth()) {
    const canBackup = !e.app.store.has(StoreKeyActiveBackup);
    const realIP = e.realIP();

    // loosely check if behind a reverse proxy
    // (usually used in the dashboard to remind superusers in case deployed behind reverse-proxy)
    let possibleProxyHeader = "";
    const headersToCheck = [
      ...(e.app.settings.TrustedProxy.Headers ?? []),
      // common proxy headers
      "CF-Connecting-IP",
      "Fly-Client-IP",
      "X-Forwarded-For",
    ];
    for (const header of headersToCheck) {
      if (headerValue(e, header) !== "") {
        possibleProxyHeader = header;
        break;
      }
    }
    // a Go map: members in any order (written here in sorted order)
    data = { canBackup, possibleProxyHeader, realIP };
  } else {
    data = {}; // ensure that it is returned as object
  }

  // same key order as upstream's struct: message, code, data
  return e.json(200, { message: "API is healthy.", code: 200, data });
}

// Header.Get: "" for a missing header, and for a configured name that is
// not a valid header name (which Go never finds and Headers.get rejects)
function headerValue(e: RequestEvent, name: string): string {
  try {
    return e.request.headers.get(name) ?? "";
  } catch {
    return "";
  }
}
