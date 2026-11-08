# P.13e SSR framework adapters and example apps

Written by the chief of staff on 2026-11-08. Owner direction 2026-11-07 (SSR out of the box, solved in the SDK). The spec is `docs/design/13-ssr.md` ("Framework adapters" and everything the adapters wire together) and D38. Read both fully, plus the merged `sdk/src/ssr/` code from P.13b (#91), P.13c (#92) and P.13d (#93). This task adds the framework glue only. The per-framework user guides are P.13f.

## Scope

- **Adapters.** Each one is a subpath of the one `iglo.base` package, with zero dependencies, typed structurally against the framework's request, cookie and locals objects. Never import the framework itself, not even its types. Each adapter is server-only: map its `browser` condition to a module that throws, as `iglo.base/ssr` already does.
  - `iglo.base/ssr/next`: `middleware.ts` helper and Server Component helper. A refresh inside a Server Component updates memory only, because cookies there are read-only. Server Actions keep Next.js's own CSRF check.
  - `iglo.base/ssr/sveltekit`: `handle` hook that sets `event.locals.pb`.
  - `iglo.base/ssr/nuxt`: Nitro server middleware that sets `event.context.pb`.
  - `iglo.base/ssr/astro`: middleware that sets `Astro.locals.pb`.
  - `iglo.base/ssr/react-router`: a `loader`/`action` helper on the Web `Request`, for React Router 7 and Remix.
- **What every adapter does, by calling the existing core and never re-implementing it:**
  - Resumes the session per request with `createServerClient`, a shared `createSessionCache` and an optional `SuperuserClient`.
  - Writes cookies back with `SSR_NO_CACHE_HEADERS`.
  - Runs `checkCsrf` on unsafe methods, with an opt-out.
  - Exposes `mintBrowserToken` for the page.
  - Mounts or exports route handlers for the token renew (`handleBrowserTokenRenew`), the popup hand-off (`handlePopupHandOff`) and the OAuth2 redirect start and callback (`startOAuth2`/`completeOAuth2`), under configurable paths.
  - Keeps no state at module level; the app creates the cache and the superuser client and passes them in.
- **Example apps.**
  - **Placement:** `examples/nextjs` (App Router) and `examples/sveltekit`. Each is its own package with its own lockfile (Bun), outside the root workspace, so its dependencies never enter the root `bun.lock` or the SDK.
  - **SDK dependency:** each depends on the SDK built from this repository (a packed tarball or `file:` link made by the test script), never the published npm package.
  - **What each shows:** password sign-in and sign-out through a server action or form; a page that renders the signed-in user from the cookie; a protected page; the OAuth2 redirect flow; a browser client with a live realtime subscription and token renewal; and the readable-cookie fallback switched by an env variable.
  - **Credentials:** none real. The test script creates its own `pb_data` with a superuser and users.
- **`bun run test:examples`.** A new script, not part of `check`, because it installs framework packages and builds the apps. It builds the server and the SDK, starts iglo.base and upstream PocketBase v0.41.0 (from `upstream:prepare`) on fresh data dirs, and for each example app and each server:
  - builds and starts the app;
  - drives it end to end over HTTP with a cookie jar: sign in, protected page, revalidation after a password change (the next check signs out), OAuth2 against the fake provider from `test/differential/auth/`, the renew route, the CSRF rejection of a cross-origin POST, and the fallback mode;
  - with `agent-browser`, checks once per app that a realtime event reaches the page in a real browser.

  Run one app at a time (the host has limited memory). Add `test:examples` to the commands list in `AGENTS.md`, worded like `test:browser`.
- Strict types, no `any` (D36), `@sdk/*` imports, and header comments naming the design section. Add each subpath to `sdk/package.json` `exports`, to the build, and to `sdk:check-package`: it is imported under Node and Bun, and a `browser`-condition bundle of it fails.

## Tests

- Unit tests in `sdk/test/ssr/` for each adapter, against hand-made objects shaped like the framework's:
  - session resumed and cookies written;
  - no-cache headers;
  - CSRF rejection and opt-out;
  - routes mounted at the configured paths;
  - Next.js read-only cookies (no throw, memory-only refresh);
  - two parallel requests for different users never share a client.
- `test:examples` as above. The differential suite (`test:reference`) is unchanged unless an adapter needs a server behaviour check that is cheap to add there.

## Docs

- `docs/design/13-ssr.md` must match the code. Fix the doc where the code had to differ, and say so in the PR.
- `sdk/README.md`: one short paragraph per adapter in the "Server-side rendering" section, linking the example apps. The full guides are P.13f.
- `examples/*/README.md`: how to run the app locally.
- `sdk/CHANGELOG.md`: add the changes to "Unreleased".

## Verification

Run `bun run check`, `bun run test:reference` and `bun run test:examples` locally, one after the other, never in parallel. The worker rules from `docs/design/12-work-plan.md` apply. Open a PR titled "P.13e: SSR framework adapters and example apps" against `main`; do not merge. Delete every `node_modules`, `.next`, `.svelte-kit` and build output you created before you finish.
