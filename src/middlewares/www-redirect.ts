// Upstream: apis/middlewares.go (wwwRedirect)
//
// Bound by `serve` (src/server/serve.ts) for the "www." variants of the
// listener's host or the certificate domains.

import type { RequestEvent } from "@/app/event-request";
import type { Handler } from "@/server/handler";
import {
  DefaultWWWRedirectMiddlewareId,
  DefaultWWWRedirectMiddlewarePriority,
} from "@/middlewares/middlewares";

// wwwRedirect performs www->non-www redirect(s) if the request host
// matches with one of the values in redirectHosts.
export function wwwRedirect(redirectHosts: string[]): Handler<RequestEvent> {
  return {
    id: DefaultWWWRedirectMiddlewareId,
    priority: DefaultWWWRedirectMiddlewarePriority,
    func: (e) => {
      const host = e.request.host;

      if (host.startsWith("www.") && redirectHosts.includes(host)) {
        // note: the request URL has no scheme
        const schema = e.isTLS() ? "https://" : "http://";

        return e.redirect(307, schema + host.slice(4) + requestURI(e));
      }

      return e.next();
    },
  };
}

// Request.RequestURI: the request target as the client sent it (Bun.serve
// has already resolved its dot segments, D22, and drops a lone "?")
function requestURI(e: RequestEvent): string {
  const { escapedPath, rawQuery } = e.request;
  return rawQuery === "" ? escapedPath : `${escapedPath}?${rawQuery}`;
}
