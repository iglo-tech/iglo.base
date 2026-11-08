// docs/design/13-ssr.md ("Framework adapters": iglo.base/ssr/react-router; "Session cookie";
// "Session cache, check and refresh"; "CSRF"; "OAuth2"; "Response headers"). The React Router 7 and
// Remix adapter: a loader, action or resource route asks for the session of its Web Request, and
// returns its data with the headers the session wrote. The route also re-exports `sessionHeaders`
// as its `headers` function, because React Router sends only the Set-Cookie lines of a loader's
// headers unless the route has that export.
import {
  csrfRejection,
  handleRoute,
  noStorePolicy,
  resolveAdapterOptions,
  resumeSession,
  setNoStoreHeaders,
  type AdapterOptions,
  type RequestSession,
} from "@sdk/ssr/adapter";
import { createRequestCookieAdapter } from "@sdk/ssr/index";

export interface ReactRouterAuth {
  /**
   * For a loader, action or resource route. Returns `{ response }` when the CSRF guard or an
   * adapter route answers the request: return that response as it is. Otherwise returns `{ session,
   * headers }`: the resumed session, and a `headers()` function. Call `headers()` when the route
   * builds its response, as the last step before it returns: it reads the cookies written up to
   * that call, so a sign-in or sign-out made later in the handler is not in an earlier call's
   * result. The route returns its data with it, for example `data(value, { headers: headers() })`
   * or `redirect(url, { headers: headers() })`. The route module must also export
   * `sessionHeaders` as `headers` (see `sessionHeaders`), or React Router drops the no-cache
   * headers.
   */
  session(request: Request): Promise<
    | {
        session: RequestSession;
        headers(): Headers;
      }
    | { response: Response }
  >;
}

/** The arguments React Router passes to a route's `headers` function. */
export interface RouteHeadersArgs {
  loaderHeaders: Headers;
  actionHeaders: Headers;
  parentHeaders: Headers;
  errorHeaders?: Headers;
}

/**
 * The `headers` function of a route that uses the session. The route re-exports it:
 * `export { sessionHeaders as headers } from "iglo.base/ssr/react-router";`
 *
 * React Router builds the headers of a page and of a `.data` response from the route's `headers`
 * export. A route without one copies only the Set-Cookie lines of its loader's and action's
 * headers, so the no-cache headers that `headers()` returns would be lost. This function starts
 * from the parent headers, as React Router does by default, and adds the no-cache headers when the
 * loader, the action or the error response carries them. Nothing is kept between calls.
 */
export function sessionHeaders({
  loaderHeaders,
  actionHeaders,
  parentHeaders,
  errorHeaders,
}: RouteHeadersArgs): Headers {
  const headers = new Headers(parentHeaders);
  const carriesUserData = [loaderHeaders, actionHeaders, errorHeaders].some(
    (source) => source?.get("cache-control")?.includes("no-store") === true,
  );
  if (carriesUserData) {
    setNoStoreHeaders(headers);
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
      const policy = noStorePolicy(request, resolved);
      const rejected = csrfRejection(request, resolved);
      if (rejected) {
        return { response: policy.apply(rejected) };
      }
      const routed = await handleRoute(request, resolved);
      if (routed) {
        return { response: policy.apply(routed) };
      }

      const cookies = createRequestCookieAdapter(request, { secure: resolved.secure });
      const session = await resumeSession(cookies, request, resolved, policy);
      return {
        session,
        headers: () => {
          // the cookies queued so far, with the no-cache headers when the request carries user data
          const response = cookies.applyToResponse(new Response(null));
          return policy.apply(response).headers;
        },
      };
    },
  };
}
