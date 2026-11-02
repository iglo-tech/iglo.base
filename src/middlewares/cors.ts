// Upstream: apis/middlewares_cors.go (ported there from echo/middleware)
//
// The CORS middleware `serve` binds (src/server/serve.ts) with the
// --origins list. It runs before the activity logger and the rate limiter,
// so preflight requests are neither logged nor counted. As upstream, it
// does not answer 405 for an unsupported route: a request that is not a
// preflight goes on to the router (404 for an unknown route).
//
// Upstream's AllowOriginFunc and UnsafeWildcardOriginWithAllowCredentials
// options are not set by `serve`, so they are not ported; the other
// options keep upstream's names for the side-by-side review.

import type { RequestEvent } from "@/app/event-request";
import type { Handler } from "@/server/handler";
import { DefaultActivityLoggerMiddlewarePriority } from "@/middlewares/middlewares";
import { compile, quoteMeta, type Regexp } from "@/tools/regexp/regexp";

export const DefaultCorsMiddlewareId = "pbCors";
// before the activity logger and rate limit so that OPTIONS preflight
// requests are not counted
export const DefaultCorsMiddlewarePriority = DefaultActivityLoggerMiddlewarePriority - 1;

// CORSConfig defines the config for CORS middleware.
export interface CORSConfig {
  // AllowOrigins determines the value of the Access-Control-Allow-Origin
  // response header. The wildcard characters '*' and '?' are supported as
  // subdomain segments and are converted to regex fragments '.*' and '.'.
  //
  // Optional. Default value ["*"].
  AllowOrigins?: string[];
  // AllowMethods determines the value of the Access-Control-Allow-Methods
  // response header of a preflight response.
  //
  // Optional. Default value DefaultCORSConfig.AllowMethods.
  AllowMethods?: string[];
  // AllowHeaders determines the value of the Access-Control-Allow-Headers
  // response header. When empty, the request's
  // Access-Control-Request-Headers are echoed.
  AllowHeaders?: string[];
  // AllowCredentials sets Access-Control-Allow-Credentials: true.
  AllowCredentials?: boolean;
  // ExposeHeaders determines the value of Access-Control-Expose-Headers.
  ExposeHeaders?: string[];
  // MaxAge determines the value of the Access-Control-Max-Age response
  // header; the header is set only if MaxAge != 0, and a negative value
  // sends "0".
  MaxAge?: number;
}

// DefaultCORSConfig is the default CORS middleware config.
export const DefaultCORSConfig = {
  AllowOrigins: ["*"],
  AllowMethods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE"],
};

// CORS returns a CORS middleware.
export function cors(
  config: CORSConfig,
  logInvalidPattern?: (line: string) => void,
): Handler<RequestEvent> {
  // Defaults
  const allowOrigins =
    config.AllowOrigins && config.AllowOrigins.length > 0
      ? config.AllowOrigins
      : DefaultCORSConfig.AllowOrigins;
  const methods =
    config.AllowMethods && config.AllowMethods.length > 0
      ? config.AllowMethods
      : DefaultCORSConfig.AllowMethods;
  const allowCredentials = config.AllowCredentials ?? false;
  const maxAgeConfig = config.MaxAge ?? 0;

  const allowOriginPatterns: Regexp[] = [];
  for (const origin of allowOrigins) {
    if (origin === "*") {
      continue; // "*" is handled differently and does not need regexp
    }

    let pattern = quoteMeta(origin);
    pattern = pattern.replaceAll("\\*", ".*");
    pattern = pattern.replaceAll("\\?", ".");
    pattern = "^" + pattern + "$";

    try {
      allowOriginPatterns.push(compile(pattern));
    } catch {
      // This is to preserve previous behaviour - invalid patterns were just ignored.
      logInvalidPattern?.(`invalid AllowOrigins pattern ${origin}`);
    }
  }

  const allowMethods = methods.join(",");
  const allowHeaders = (config.AllowHeaders ?? []).join(",");
  const exposeHeaders = (config.ExposeHeaders ?? []).join(",");

  const maxAge = maxAgeConfig > 0 ? String(maxAgeConfig) : "0";

  return {
    id: DefaultCorsMiddlewareId,
    priority: DefaultCorsMiddlewarePriority,
    func: (e) => {
      const req = e.request;
      const res = e.response;
      const origin = headerGet(req.headers, "Origin");
      let allowOrigin = "";

      res.header.append("Vary", "Origin");

      // Preflight request is an OPTIONS request, using three HTTP request
      // headers: Access-Control-Request-Method, Access-Control-Request-Headers,
      // and the Origin header. For simplicity we just consider method type
      // and later `Origin` header.
      const preflight = req.method === "OPTIONS";

      // No Origin provided. This is (probably) not request from actual
      // browser - proceed executing middleware chain
      if (origin === "") {
        if (!preflight) {
          return e.next();
        }
        return e.noContent(204);
      }

      // Check allowed origins
      for (const o of allowOrigins) {
        if (o === "*" || o === origin) {
          allowOrigin = o;
          break;
        }
        if (exactWildcardMatch(origin, o)) {
          allowOrigin = origin;
          break;
        }
      }

      // to avoid regex cost by invalid (long) domains (253 is domain name max limit)
      if (allowOrigin === "" && goLen(origin) <= 253 + 3 + 5 && origin.includes("://")) {
        for (const re of allowOriginPatterns) {
          if (re.matchString(origin)) {
            allowOrigin = origin;
            break;
          }
        }
      }

      // Origin not allowed
      if (allowOrigin === "") {
        if (!preflight) {
          return e.next();
        }
        return e.noContent(204);
      }

      res.header.set("Access-Control-Allow-Origin", allowOrigin);
      if (allowCredentials) {
        res.header.set("Access-Control-Allow-Credentials", "true");
      }

      // Simple request
      if (!preflight) {
        if (exposeHeaders !== "") {
          res.header.set("Access-Control-Expose-Headers", exposeHeaders);
        }
        return e.next();
      }

      // Preflight request
      res.header.append("Vary", "Access-Control-Request-Method");
      res.header.append("Vary", "Access-Control-Request-Headers");
      res.header.set("Access-Control-Allow-Methods", allowMethods);

      if (allowHeaders !== "") {
        res.header.set("Access-Control-Allow-Headers", allowHeaders);
      } else {
        const h = headerGet(req.headers, "Access-Control-Request-Headers");
        if (h !== "") {
          res.header.set("Access-Control-Allow-Headers", h);
        }
      }
      if (maxAgeConfig !== 0) {
        res.header.set("Access-Control-Max-Age", maxAge);
      }

      return e.noContent(204);
    },
  };
}

// Header.Get. Bun.serve joins repeated lines with ", " (D22), so a repeated
// Origin is matched as the joined value, which no allowed origin equals.
function headerGet(headers: Headers, name: string): string {
  return headers.get(name) ?? "";
}

// len() of a Go string: its UTF-8 bytes (a header value holds bytes as
// Latin-1 characters, one per byte)
function goLen(s: string): number {
  return s.length;
}

function matchScheme(domain: string, pattern: string): boolean {
  const didx = domain.indexOf(":");
  const pidx = pattern.indexOf(":");
  return didx !== -1 && pidx !== -1 && domain.slice(0, didx) === pattern.slice(0, pidx);
}

// exactWildcardMatch compares domain with a * wildcard pattern
export function exactWildcardMatch(domain: string, pattern: string): boolean {
  if (!matchScheme(domain, pattern)) {
    return false;
  }

  const didx = domain.indexOf("://");
  const pidx = pattern.indexOf("://");
  if (didx === -1 || pidx === -1) {
    return false;
  }
  const domAuth = domain.slice(didx + 3);
  // to avoid long loop by invalid long domain
  if (goLen(domAuth) > 253) {
    return false;
  }
  const patAuth = pattern.slice(pidx + 3);

  const domComp = domAuth.split(".").toReversed();
  const patComp = patAuth.split(".").toReversed();

  if (patComp.length !== domComp.length) {
    return false;
  }

  for (let i = 0; i < domComp.length; i++) {
    const p = patComp[i];

    if (p === "*") {
      continue;
    }

    if (p !== domComp[i]) {
      return false;
    }
  }

  return true;
}
