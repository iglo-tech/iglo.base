// Upstream: apis/health.go
//
// possibleProxyHeader checks upstream's common proxy headers; the
// configured trusted proxy headers (settings.trustedProxy.headers), which
// upstream checks first, are added with the settings (M1.3). realIP is
// RemoteIP until then (src/app/event-request.ts).

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
      // the settings' trusted proxy headers come first (M1.3)
      // common proxy headers
      "CF-Connecting-IP",
      "Fly-Client-IP",
      "X-Forwarded-For",
    ];
    for (const header of headersToCheck) {
      if ((e.request.headers.get(header) ?? "") !== "") {
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
