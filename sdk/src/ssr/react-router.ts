// docs/design/13-ssr.md ("Framework adapters": iglo.base/ssr/react-router; "Session cookie";
// "Session cache, check and refresh"; "CSRF"; "OAuth2"). The React Router 7 and Remix adapter: a
// loader, action or resource route asks for the session of its Web Request, and returns its data
// with the headers the session wrote.
import {
  csrfRejection,
  handleRoute,
  resolveAdapterOptions,
  resumeSession,
  type AdapterOptions,
  type RequestSession,
} from "@sdk/ssr/adapter";
import { createRequestCookieAdapter } from "@sdk/ssr/index";
import type { RequestCookieAdapter } from "@sdk/ssr/types";
import { cookieSerialize } from "@sdk/tools/cookie";

export interface ReactRouterAuth {
  /**
   * For a loader, action or resource route. Returns `{ response }` when the CSRF guard or an
   * adapter route answers the request: return that response as it is. Otherwise returns `{ session,
   * headers }`: the resumed session, and the Set-Cookie and no-cache headers it wrote (empty when it
   * wrote nothing). The route returns its data with `headers`, for example `data(value, { headers })`.
   */
  session(
    request: Request,
  ): Promise<{ session: RequestSession; headers: Headers } | { response: Response }>;
}

/** The headers of the cookies a session wrote: its queued headers, then one Set-Cookie per cookie. */
function writtenHeaders(cookies: RequestCookieAdapter): Headers {
  const headers = new Headers(cookies.queuedHeaders);
  for (const cookie of cookies.queuedCookies) {
    headers.append("Set-Cookie", cookieSerialize(cookie.name, cookie.value, cookie.options));
  }
  return headers;
}

/**
 * The React Router adapter. The options carry the app's session cache and superuser client, which
 * it creates once; nothing here keeps state between requests.
 *
 * @throws {TypeError} without a superuser client and without `readableCookie: true`
 */
export function createReactRouterAuth(options: AdapterOptions): ReactRouterAuth {
  const resolved = resolveAdapterOptions(options);
  return {
    async session(request) {
      const rejected = csrfRejection(request, resolved);
      if (rejected) {
        return { response: rejected };
      }
      const routed = await handleRoute(request, resolved);
      if (routed) {
        return { response: routed };
      }

      const cookies = createRequestCookieAdapter(request, { secure: resolved.secure });
      const session = await resumeSession(cookies, request, resolved);
      return { session, headers: writtenHeaders(cookies) };
    },
  };
}
