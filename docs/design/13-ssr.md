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

- `createServerClient({ url, cookies, origin?, request?, secure?, sessionCache?, cookieName?, cookieOptions?, fetch?, clock?, lang? })` from `iglo.base/ssr`: a new SDK instance for one request, resumed from the request's session cookie. `autoCancellation` is off. Every request is sent with `cache: "no-store"`, applied at the fetch layer after `beforeSend` (so an app that replaces `pb.beforeSend` cannot drop it, and Next.js never caches server client responses). It is never reused across requests.
- `createSuperuserClient({ url, email, password })` or `({ url, token })` (an API key from `impersonate`): one long-lived instance per process, held in memory, `autoCancellation` off, refreshed before its token expires (upstream's `autoRefreshThreshold`). With email and password, a rejected refresh re-authenticates with the password; a client built from a token alone cannot. A token that is not refreshable (`refreshable: false`, as `impersonate` issues) is never sent to `auth-refresh`, which the server answers with 403: its requests carry it until it expires, then fail with the server's 401, and the app creates a new client with a new token. It provides one method, `impersonate(collectionOrRecord, recordIdOrDuration?, duration?)`, which mints a short user token (default 900 s, 15 minutes) for page JavaScript and realtime, never for serving user requests.
- **One SDK copy.** `iglo.base/ssr` imports `Client`, `ClientResponseError` and `BaseAuthStore` from the main entry (`iglo.base`) instead of bundling its own. `instanceof ClientResponseError` and `instanceof PocketBase` therefore agree across both entries (checked by `sdk:check-package`).
- `iglo.base/ssr` is server-only: its package `exports` maps the `browser` condition to a module that throws with a clear message, so a bundle that imports it fails at build time.
- **Server-side sign-in and sign-out:** Every auth change the app makes on a server client's `authStore` (`authWithPassword`, `authWithOAuth2Code`, `authRefresh`, `authStore.save()`, `authStore.clear()`) writes or clears the session cookie through the adapter with `SSR_NO_CACHE_HEADERS`, and updates or evicts the session cache. A 401 from an ordinary data call never logs the user out; only the outcome of the session check decides session validity.
- **Session check:** `pb.auth.verify()` checks the session with iglo.base now, bypassing the cache, and throws the error when the session is not valid. It is the only name for the check; the SDK adds no other.

### Session cookie

- One cookie, `pb_auth` by default, written by the existing `exportToCookie`: the token and the user record (owner, 2026-11-07: pages read the user without a request). `exportToCookie` keeps upstream's fallback to the minimal record fields when the value would exceed 4,096 bytes.
- Defaults: `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` and the `__Host-` prefix except on `localhost`, `127.0.0.1` and `::1` over http; `Max-Age` from the token's `exp`.
- Cookie security decisions follow the **application's own request**: `secure` if given, else the adapter's `isSecure` (the request adapter sets it from the request URL), else `origin`, else `request.url`. They never follow the iglo.base URL, so an https app talking to `http://127.0.0.1:8090` gets `__Host-pb_auth; Secure`, and a local http app talking to an https backend gets a plain, non-`Secure` `pb_auth`. With none of these given, the cookie is secure.
- `cookieOptions` cannot break the name rules: `cookieOptions.secure` picks the name (`__Host-` when true), and a `__Host-` cookie never carries a `Domain` or a path other than `/`.
- Reading accepts both names; `__Host-pb_auth` wins. When the session ends, both names are cleared on secure origins, so a `pb_auth` written before the prefix does not survive.
- The record is used only when its `id` matches the token's `id`. A cookie can be edited by its user.
- The cookie value is decoded at most once per candidate. Adapters may return it decoded (the request adapter does) or as the browser sent it (Next.js does); the SDK tries the raw text first, then the percent-decoded text.
- Every response that writes the cookie also gets `Cache-Control: private, no-cache, no-store, must-revalidate, max-age=0`, `Expires: 0`, and `Pragma: no-cache`, so a CDN cannot hand one user's cookie to another (from Supabase).
- A throwing `setAll` (Next.js Server Components are read-only) never rejects the request: the cookie write is skipped and the request continues.

### Session cache, check and refresh

No request re-authenticates by default (owner, 2026-11-07). Per server process:

- A bounded in-memory cache, `createSessionCache({ ttl, maxEntries, clock })`, created explicitly and passed to each `createServerClient` (no module global). It is keyed by a SHA-256 hash of the token (Web Crypto; the raw token is never a key), holds the user record and when the session was last checked, and holds the learned token lifetimes and the clock offset. Defaults: `ttl` 300 000 ms (5 minutes), `maxEntries` 10,000 (least recently used dropped first). `ttl` is in milliseconds. Cache operations run in call order, so a write started by an auth change is visible to the next read.
- **Lifetime learning:** tokens have an `exp` claim and no `iat` claim. A successful session response teaches the cache the collection's lifetime: `auth-with-password`, `auth-with-otp`, `auth-with-oauth2` and `auth-refresh` (the refresh the check makes included), when the token has `type: "auth"`, is refreshable, and names the record in the response. The lifetime is `exp − serverNow`, with `serverNow` from the response's `Date` header. Other responses that carry a token do not teach it: `files/token` returns a 180-second file token, and `impersonate` returns a non-refreshable token. Lifetimes are kept per collection ID in the cache. Until a collection's lifetime is known, the first check of its session refreshes once to learn it. The SDK never assumes a fixed lifetime.
- A request whose token is in the cache, was checked within `ttl`, and has at least half its learned lifetime remaining uses the cached record with no request to iglo.base.
- Otherwise the SDK calls `auth-refresh` once. Parallel requests for the same token share that one request (single-flight). The shared flight returns a plain outcome, `{ kind: "ok", token, record } | { kind: "revoked", error } | { kind: "transient", error }`, and each waiting request applies it to its own client, auth store and cookie adapter:
  - `ok`: updates its auth store and the cache entry; writes the cookie when the token changed.
  - `revoked` (401, 403, 404): clears its session, evicts the cache entry and writes cleared cookies. `pb.auth.verify()` throws the error; an ordinary request continues signed out.
  - `transient` (network error or 5xx): keeps its session, does not touch the cookie or the cache. `pb.auth.verify()` throws the error to its own caller only; an ordinary request is not affected by another caller's `verify()`.
- Expiry checks allow 60 seconds of clock skew. The SDK corrects for the difference between the app server's clock and iglo.base's `Date` header, learned from each response and kept in the cache, so an app clock that is minutes off does not drop a session the server still accepts.
- Before the first response in a process the offset is unknown and counts as 0; the 60-second allowance still applies. So until then, an app clock more than 60 seconds fast can drop, without a request, a session whose token is close to its `exp` that iglo.base still accepts. The first response corrects the offset.
- Trade-off: between checks, a revoked session can still render as signed in for up to `ttl`. Data calls are not affected: iglo.base rejects the revoked token on every API call, as a guest.

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
