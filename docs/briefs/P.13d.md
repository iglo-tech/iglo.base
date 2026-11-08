# P.13d SSR browser client and realtime

Written by the chief of staff on 2026-11-08. Owner direction 2026-11-07 (SSR out of the box, solved in the SDK). The spec is `docs/design/13-ssr.md` ("Browser client and realtime", plus "Clients" for `impersonate`, "CSRF" and the popup flow under "OAuth2"), and D38 in `docs/design/10-decisions.md`. Read both fully, and the merged code in `sdk/src/ssr/` that this builds on: P.13b (#91) and P.13c (#92). The framework adapters (P.13e) come later. Build the framework-neutral pieces they will call, on Web `Request`/`Response`, and leave clear seams for them.

## Scope

- **Minting at render (server).** Add a function in `iglo.base/ssr` that takes a `ServerClient` (after its session is resumed) and a `SuperuserClient`, and returns what the page needs: `{ token, record, expiresAt }` for the signed-in user, or `null` when nobody is signed in. Name it, and say why you put it where you did. The token comes from `superuser.impersonate(...)`, 900 s by default and configurable. It never returns or exposes the session token. The record is the server client's validated record, never data from the request.
- **Renew route (server).** Add `handleBrowserTokenRenew(request, options)` for an adapter route, styled like `handlePopupHandOff`:
  - It accepts `POST` only and always runs `checkOrigin`.
  - It resumes and validates the session from the request's cookie through `createServerClient`, so the session cache and refresh rules apply.
  - It answers `200 { token, record, expiresAt }` with a freshly minted token, `401` when there is no valid session, and `405`/`403` for the wrong method or origin. Every answer carries `SSR_NO_CACHE_HEADERS`.
- **Fallback without superuser credentials.** Add an option on `createServerClient` (or the cookie settings) that writes the session cookie with `HttpOnly` off, documented as weaker against XSS. Both the minting function and the renew route then answer from the session itself, without impersonate. In fallback mode the browser client reads the cookie.
- **Browser client.** Add `createBrowserClient({ url, token?, record?, renewUrl?, handOffUrl?, clock?, fetch?, lang? })`, in a browser-safe subpath (`iglo.base/ssr/browser`, or the main entry if you can justify it; `iglo.base/ssr` throws under the `browser` condition and must keep doing so). It returns a normal SDK `Client`:
  - Its auth store is seeded from the handed-over token and record. In fallback mode, with no token given, it is loaded from the JS-readable session cookie.
  - It renews before the token expires: at a fixed fraction of the remaining lifetime, at least 60 s before `exp`. It uses the injected clock, and a single-flight shared by parallel callers and timers. A `401` from the renew route clears the auth store. A network error or `5xx` keeps the current token and retries with a bounded backoff until it expires. Stop the timers on `dispose()` or something similar, so tests and page unloads don't leak them.
  - **Realtime.** Subscriptions keep receiving events across a renewal. Read upstream `apis/realtime.go` and the SDK's `RealtimeService` to see how a running SSE client's auth is set and how a changed token for the same record is treated. Then do the least that keeps subscriptions authorized: resubmit the subscriptions with the new token, or reconnect. After the auth store is cleared, the client continues as a guest.
  - `handOff()` (or a similar name) posts the current auth store token to `handOffUrl` after the existing `authWithOAuth2()` popup. It replaces the browser's long-lived popup token with a minted short one, from the hand-off answer or a renew call, so the long-lived token does not stay in page memory.
- Strict types with no `any` (D36 rules), `@sdk/*` imports, and header comments naming the design section. No Bun-only APIs in browser code.

## Tests

- **Unit tests** in `sdk/test/ssr/`, against the fetch mock with an injected clock and no sleeping:
  - minting with and without a session;
  - renew route: same origin, foreign origin, wrong method, no cookie, revoked session, and no-cache headers;
  - fallback cookie attributes;
  - browser client: renews at the right time, parallel renews make a single request, `401` clears the store, `5xx` keeps the token and retries, `dispose` stops the timers;
  - realtime is resubmitted after a renewal;
  - `handOff` swaps the token.
- **Differential tests** in `test/differential/sdk-ssr/` (run by `test:reference`), against both iglo.base and upstream PocketBase. Reuse the realtime and SDK harnesses under `test/differential/realtime/` and `test/differential/sdk/` for the EventSource setup:
  - A user signs in through a server client. A page token is minted. A browser client built from it subscribes to a collection whose rules allow the user, and receives a create event.
  - After a renewal, driven by the client clock, the same subscription still receives an event, and the new token is a different, valid token for the same user.
  - After the user's password changes, the renew route answers `401` and the browser client is signed out.
  - In fallback mode, without superuser credentials, the browser client reads the cookie and receives realtime events.
  - Compare the recorded results across both servers, and also assert the expected outcomes directly.

## Docs

- `docs/design/13-ssr.md` must match the code. Fix the doc where the code had to differ, and say so in the PR.
- `sdk/README.md`: in the "Server-side rendering" section, add a short example on plain Web `Request`/`Response`: mint at render, a renew route, and a browser client with a realtime subscription. Add the fallback note. The per-framework guides are P.13f.
- `sdk/CHANGELOG.md`: add to "Unreleased".
- `sdk:check-package` must cover the new subpath: imports under both Node and Bun, and a `browser`-condition bundle that includes it.

## Verification

`bun run check` and `bun run test:reference` pass locally, run one after the other. The worker rules from `docs/design/12-work-plan.md` apply. Open a PR titled "P.13d: SSR browser client and realtime" against `main`. Do not merge.
