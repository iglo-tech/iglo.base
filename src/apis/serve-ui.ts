// Upstream: apis/serve.go (the /_/{path...} dashboard route, defaultCSP),
// apis/extensions.go (the /_ group with /_/extensions.js), with Static
// (@/apis/base) on the embedded dashboard build (@/apis/ui-pack).
//
// There are no dashboard extensions (D5, docs/design/04-api-compatibility.md):
// /_/extensions.js is always an empty script, kept for cached old builds,
// and /_/extensions/{name}/... is not a route, so it is the dashboard's 404.

import { requestEventKeySkipSuccessActivityLog } from "@/middlewares/activity-logger";
import { staticHandler, StaticWildcardParam } from "@/apis/base";
import { embeddedFS } from "@/apis/static-fs";
import type { StaticFS } from "@/apis/ui-pack";
import type { RequestEvent } from "@/app/event-request";
import { gzip } from "@/middlewares/gzip";
import type { Router } from "@/server/router";

export const defaultCSP =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' http://127.0.0.1:* https://tile.openstreetmap.org data: blob:; connect-src 'self' http://127.0.0.1:* https://nominatim.openstreetmap.org; script-src 'self' http://127.0.0.1:*; frame-ancestors 'none'";

const cacheControl = "max-age=1209600, stale-while-revalidate=86400";

// Binds the dashboard routes (Serve's /_/{path...} route and
// bindUIExtensions' /_ group), in upstream's order: after the router's own
// routes.
export function bindDashboard(router: Router<RequestEvent>, ui: StaticFS): void {
  router
    .GET(`/_/{${StaticWildcardParam}...}`, staticHandler(embeddedFS(ui), false))
    .bindFunc((e) => {
      if (
        !e.app.isDev &&
        // exclude root path
        e.request.pathValue(StaticWildcardParam) !== "" &&
        !e.response.header.get("Cache-Control")
      ) {
        e.response.header.set("Cache-Control", cacheControl);
      }

      if (!e.response.header.get("Content-Security-Policy")) {
        e.response.header.set("Content-Security-Policy", defaultCSP);
      }

      return e.next();
    })
    .bind(gzip());

  const uiGroup = router
    .group("/_")
    .bindFunc((e) => {
      if (!e.app.isDev && !e.response.header.get("Cache-Control")) {
        e.response.header.set("Cache-Control", cacheControl);
      }

      if (!e.response.header.get("Content-Security-Policy")) {
        e.response.header.set("Content-Security-Policy", defaultCSP);
      }

      return e.next();
    })
    .bind(gzip());

  // the combined main.js of the extensions: there are none
  uiGroup
    .GET("/extensions.js", (e) =>
      e.stream(200, "text/javascript", new ReadableStream({ start: (c) => c.close() })),
    )
    .bindFunc((e) => {
      // SkipSuccessActivityLog
      e.set(requestEventKeySkipSuccessActivityLog, true);
      return e.next();
    });
}
