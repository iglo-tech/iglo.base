# SSR out of the box

Task P.13, owner direction 2026-11-07. Decision record: [D38](10-decisions.md#d38-ssr-in-the-sdk). iglo.base and its SDK (`iglo.base` on npm, D36) work with any JavaScript SSR framework without users solving the problems PocketBase leaves to them ([docs](https://pocketbase.io/docs/how-to-use/#why-not-js-ssr), [discussion #5313](https://github.com/pocketbase/pocketbase/discussions/5313)). Everything is in the SDK; the server's API stays PocketBase v0.41.0's.

## Sources

Read for this design (2026-11-07): PocketBase discussion #5313; the source of `@supabase/ssr` 0.12.7 and `@convex-dev/auth` 0.0.96 (Next.js server part); the docs of Appwrite SSR, Firebase session cookies, Clerk, Better Auth, Lucia and Auth.js (a Gemini research report, spot-checked by the lead). Upstream PocketBase v0.41.0 for the token model (`core/record_tokens.go`, `apis/record_auth_impersonate.go`).

| | Supabase | Convex Auth | Appwrite | Taken here |
|---|---|---|---|---|
| Client per request | `createServerClient` on cookie `getAll`/`setAll` | middleware + token helper | session client per request, admin client apart | the cookie adapter shape and the split between user and admin clients |
| Cookie | readable by JS, Lax, chunked | HttpOnly, Lax, `__Host-` | HttpOnly | HttpOnly, Lax, `__Host-` outside localhost |
| Refresh | middleware; rotating refresh tokens | middleware, when under 10 % of the lifetime | sliding | sliding at half the lifetime, in middleware |
| Browser | token read from the cookie | page gets the access token at render; the refresh token never leaves the server | short JWT minted by the server | a short token minted by the server, handed over at render |
| Caching, CSRF | `Cache-Control: private, no-store` with every cookie write | cross-origin requests lose their cookies | SameSite | both |

## What makes iglo.base easier

- **Refresh races are harmless.** Tokens are stateless JWTs. `auth-refresh` issues a new token and the old one stays valid until it expires, so parallel requests that refresh the same session cannot log the user out (Supabase needs a grace window for its rotating refresh tokens). The SDK still sends one refresh per session at a time.
- **Every API call validates the token.** A revoked token (password change, `tokenKey` change, deleted record) gets 401 on the next call. An explicit check is only needed when a page has to know who is signed in without making any other call.
- **Short browser tokens exist already.** `POST /api/collections/{c}/impersonate/{id}` with `duration` returns a non-refreshable token (`NewStaticAuthToken`). A superuser client on the app server mints one per page, so the long-lived session never reaches page JavaScript and no new endpoint is needed.

## Design

### Clients

- `createServerClient({ url, cookies, ... })` from `iglo.base/ssr`: a new SDK instance for one request, resumed from the request's cookie. `autoCancellation` is off and every request uses `cache: "no-store"` (Next.js caches `fetch` otherwise). It is never reused across requests.
- `createSuperuserClient({ url, email, password })` or `({ url, token })` (an API key from `impersonate`): one long-lived instance per process, held in memory, `autoCancellation` off, re-authenticated before its token expires (upstream's `autoRefreshThreshold`). It is for privileged work and for minting browser tokens, never for a user's request.
- `iglo.base/ssr` is server-only: its package `exports` maps the `browser` condition to a module that throws with a clear message, so importing it into a client bundle fails at build time.

### Session cookie

- One cookie, `pb_auth` by default, written by the existing `exportToCookie`: the token and the user record (owner, 2026-11-07: pages read the user without a request). `exportToCookie` keeps upstream's fallback to the minimal record fields when the value would exceed 4,096 bytes.
- Defaults: `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` and the `__Host-` prefix except on `localhost`, `127.0.0.1` and `::1` over http; `Max-Age` from the token's `exp`.
- Every response that writes the cookie also gets `Cache-Control: private, no-cache, no-store, must-revalidate, max-age=0`, so a CDN cannot hand one user's cookie to another (from Supabase).

### Session cache, check and refresh

No request re-authenticates by default (owner, 2026-11-07). Per server process:

- A bounded in-memory cache, keyed by a hash of the token, holds the user record and when the session was last checked against iglo.base. Default 10,000 entries (a few MB), least recently used dropped first; configurable.
- A request whose token is in the cache and was checked within the TTL (default 5 minutes) uses the cached record with no request to iglo.base.
- Otherwise, or when the token has less than half its lifetime left, the SDK calls `auth-refresh` once: success refreshes the cache entry and, when the new token differs, writes the cookie; 401/403/404 clears the cookie and the entry; a network error or 5xx keeps the session as it is and does not clear the cookie (the Convex Auth bug #174 logged users out on transient errors).
- Parallel requests for the same token share one `auth-refresh`.
- Expiry checks allow 60 seconds of clock skew, and the SDK corrects for the difference between the app server's clock and iglo.base's `Date` header.
- `pb.auth.verify()` forces a check for pages that must not show a revoked session for up to the TTL (account settings, payments).
- Trade-off: between checks, a revoked session can still render as signed in for up to the TTL. Data calls are not affected: iglo.base rejects the revoked token on every API call.

### Browser client and realtime

- At render, the server's adapter mints a browser token with the superuser client (`impersonate`, 15 minutes by default) and passes it to the page with the user record. `createBrowserClient()` uses it for realtime and for direct reads, so neither goes through the app server.
- Before it expires, the browser client gets a new one from an adapter route (`POST`, same origin, cookie-authenticated, Origin-checked). Realtime reconnects with the new token; the SDK already re-sends subscriptions on reconnect.
- Without superuser credentials the adapter falls back to a session cookie readable by JavaScript (`HttpOnly` off, documented as weaker against XSS), and the browser client reads it.

### OAuth2

- Redirect flow, server only: `startOAuth2(provider, { redirectTo })` reads `listAuthMethods`, stores `state`, the PKCE `codeVerifier`, the provider and `redirectTo` in a 10-minute HttpOnly cookie, and redirects to the provider. `completeOAuth2(request)` on the callback route checks `state`, calls `authWithOAuth2Code`, writes the session cookie and deletes the temporary one.
- Popup flow: the existing `authWithOAuth2()` in the browser, then the browser client posts the token to an adapter route that checks it with `auth-refresh` and sets the HttpOnly session cookie (Firebase's session-login pattern, with the Origin check below).

### CSRF

- `SameSite=Lax` on the session cookie.
- Adapters reject `POST`, `PUT`, `PATCH` and `DELETE` requests that carry the session cookie and whose `Origin` (or `Referer` without `Origin`) is not the app's own origin or a configured allowed origin (from Convex Auth, Lucia, Better Auth). Next.js Server Actions keep their own check.

### Framework adapters

Zero dependencies, typed structurally against each framework's cookie and request objects, all subpaths of the one package:

| Adapter | Where the session is resumed and refreshed | Notes |
|---|---|---|
| `iglo.base/ssr` (core) | any Web `Request`/`Response` handler (Bun, Hono, Deno) | the cookie adapter is `{ getAll, setAll }` |
| `iglo.base/ssr/next` | `middleware.ts` | Server Components cannot set cookies: they read the client the middleware prepared, and a refresh there updates memory only (from Supabase and Convex) |
| `iglo.base/ssr/sveltekit` | `handle` hook into `event.locals` | |
| `iglo.base/ssr/nuxt` | Nitro server middleware into `event.context` | |
| `iglo.base/ssr/astro` | middleware into `Astro.locals` | |
| `iglo.base/ssr/react-router` | a `loader`/`action` helper on the Web `Request` | React Router 7 and Remix |

## What is left out

- **Server changes.** iglo.base does not read auth cookies itself and gets no new endpoint (lead decision, 2026-11-07, D38).
- **JWKS or asymmetric tokens** for local verification: they would change the token format that PocketBase reads (data contract).
- **Cookie chunking:** with the minimal-record fallback the cookie stays under 4,096 bytes.
- **`auth-refresh` on every request,** as PocketBase's README examples do.

## Tasks

P.13a this design; P.13b server core (clients, cookie, cache, refresh, guards); P.13c OAuth2 and CSRF; P.13d browser client and realtime; P.13e adapters with Next.js and SvelteKit example apps run end to end; P.13f user docs. Every task tests through public boundaries against both servers: for P.13b, two users and 200 parallel requests each, with no response showing the other user's data and no request to iglo.base for cached sessions.
