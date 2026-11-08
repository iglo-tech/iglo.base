// docs/design/13-ssr.md ("Framework adapters": iglo.base/ssr/react-router; "Session cookie";
// "Session cache, check and refresh"; "CSRF"; "OAuth2"). The React Router 7 and Remix adapter: a
// loader, action or resource route asks for the session of its Web Request, and returns its data
// with the headers the session wrote, read when the route builds its response.
import {
  csrfRejection,
  handleRoute,
  noStorePolicy,
  resolveAdapterOptions,
  resumeSession,
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
   * or `redirect(url, { headers: headers() })`.
   */
  session(request: Request): Promise<
    | {
        session: RequestSession;
        headers(): Headers;
      }
    | { response: Response }
  >;
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
