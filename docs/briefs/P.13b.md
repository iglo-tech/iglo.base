# P.13b SSR server core

Written by the chief of staff on 2026-11-07. Owner direction 2026-11-07 (SSR out of the box, solved in the SDK). The spec is `docs/design/13-ssr.md` ("Clients", "Session cookie", "Session cache, check and refresh") and D38 in `docs/design/10-decisions.md`; read both fully. OAuth2 and CSRF (P.13c), the browser client and browser tokens (P.13d) and the framework adapters (P.13e) are later tasks: build only what they will sit on, and leave clear seams for them.

## Scope

- New entry point `iglo.base/ssr` (`sdk/src/ssr/`), a second ESM entry in `sdk/package.json` `exports` with its types; the `browser` export condition maps to a module that throws a clear error ("iglo.base/ssr is server-only"), so a client bundle fails at build time. Add it to `sdk:build` and `sdk:check-package` (Node and Bun import, `tsc` resolution, and a bundler build with the `browser` condition that must fail).
- `createServerClient({ url, cookies: { getAll, setAll }, ...options })`: a new `Client` per call, resumed from the request's `pb_auth` cookie through the existing `loadFromCookie`, `autoCancellation(false)`, every request sent with `cache: "no-store"`. The cookie adapter shape follows `@supabase/ssr` (`getAll()` returning `{ name, value }[]`, `setAll(cookies, headers)`), sync or async. Response headers to set with every cookie write: `Cache-Control: private, no-cache, no-store, must-revalidate, max-age=0`, `Expires: 0`, `Pragma: no-cache`.
- Session cookie per the design: token plus user record via the existing `exportToCookie` (keep its minimal-record fallback above 4,096 bytes); `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` and the `__Host-` prefix except for `localhost`, `127.0.0.1` and `::1` over http (the name is configurable; reading accepts both the prefixed and unprefixed name); `Max-Age` from the token's `exp`.
- Session cache: one per process, created explicitly and passed in (`createSessionCache({ ttl, maxEntries })`, defaults 5 minutes and 10,000; no hidden module global; `createServerClient` takes it as an option and works without one by checking every time). Keyed by a hash of the token (Web Crypto SHA-256, never the raw token), LRU, holding the user record and the last check time.
- Check and refresh per the design: cached and fresh → no request; otherwise, or under half the token's lifetime left → one `auth-refresh`; success updates the entry and writes the cookie when the token changed; 401/403/404 clears cookie and entry; network errors and 5xx keep the session and do not touch the cookie. Parallel calls for one token share one request (single-flight). Expiry checks allow 60 s of clock skew and correct for the offset between local time and iglo.base's `Date` header. `pb.auth.verify()` (or the name that fits the SDK's style; say which) forces a check.
- `createSuperuserClient({ url, email, password } | { url, token })`: one long-lived instance, `autoCancellation(false)`, re-authenticates before expiry (upstream's `autoRefreshThreshold` path), and a method that mints a short user token through `impersonate` (default 15 minutes) for P.13d.
- A core helper for plain Web `Request`/`Response` handlers (Bun, Hono, Deno): a cookie adapter built from a `Request` and a way to apply the queued cookies and headers to a `Response`. This is the reference adapter P.13e builds on.
- Strict types, no `any` (D36 rules), `@sdk/*` imports, header comments naming the design section instead of an upstream file (this code has no upstream source).

## Tests

- Unit tests in `sdk/test/ssr/` against the fetch mock: cookie parsing and writing (attributes on localhost and on https), cache hit and miss, TTL, LRU eviction, half-life refresh, single-flight (100 parallel calls → one request), 401 clears, 503 keeps, clock-skew correction, superuser re-auth and impersonate.
- Differential tests in `test/differential/sdk-ssr/` (run by `test:reference`) against both iglo.base and upstream PocketBase: two users, 200 parallel requests each through `createServerClient` with their own cookies, every response shows only its own user's data; with a warm cache no request reaches the server for the session check (count requests at the server); a token revoked by a password change is rejected on the next data call and cleared after the cache TTL (use an injected clock, no sleeping); impersonate tokens from the superuser client work for realtime subscribe on both servers.

## Docs

`docs/design/13-ssr.md` must match the code (fix the doc where the code had to differ, and say so in the PR). `sdk/README.md`: a short "Server-side rendering" section with a plain Web Request/Response example; the per-framework guides are P.13f. `sdk/CHANGELOG.md`: an "Unreleased" entry.

## Verification

`bun run check` and `bun run test:reference` pass locally (one after the other). Worker rules from `docs/design/12-work-plan.md` apply. Open a PR titled "P.13b: SSR server core" against `main`; do not merge.
