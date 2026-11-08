# P.13f SSR user docs

Written by the chief of staff on 2026-11-08. Owner direction 2026-11-07 (SSR out of the box). The SSR work is merged: P.13b–e (#91–#94). The spec is `docs/design/13-ssr.md` and D38. This task writes the user guide. It changes no SDK behavior.

## Scope

- **`docs/ssr.md`.** A new user guide in plain, short English, in the style of `docs/operations.md`. It must answer, for someone moving from PocketBase, every problem PocketBase lists under "Why not JS SSR" (https://pocketbase.io/docs/how-to-use/#why-not-js-ssr): what iglo.base's SDK does for each and what the app still has to do. Sections:
  - The model, in a few lines: per-request user client, long-lived superuser client, the HttpOnly session cookie with the user record, the session cache and its trade-off, and short browser tokens for realtime.
  - Install and setup: `iglo.base` from npm, environment variables, and creating the superuser credential or API key the app server uses (without one, the readable-cookie fallback and its XSS trade-off).
  - One guide per framework, matching the merged adapter APIs and the example apps exactly:
    - Next.js (App Router, `proxy.ts`, Node.js runtime, Server Components, Route Handlers, Server Actions);
    - SvelteKit;
    - Nuxt;
    - Astro;
    - React Router 7 / Remix (including the `sessionHeaders` re-export on session routes and boundary routes);
    - plain Web `Request`/`Response` (Bun, Hono, Deno).

    Each guide covers wiring the adapter, sign-in and sign-out, reading the user in a page, a protected page, OAuth2 (redirect flow; Apple and other form_post providers through the popup and hand-off), the browser client with realtime, and CSRF.
  - Caching and CDNs: which responses get no-cache headers, and what the app must add itself (the Next.js limits, a handler's own `Cache-Control` in Nuxt).
  - Security notes: `__Host-` cookies on https, `allowedOrigins` behind proxies, open-redirect protection, and what is still weaker over plain http.
  - Troubleshooting: the server-only error in browser bundles or on Edge, cookies not set in Server Components, realtime after sign-out, clock skew.
- **Every code sample must be correct against the merged code.** Take the samples from the example apps and the unit tests where possible. Check every exported name and option in `sdk/src/ssr/`. Do not document anything that does not exist.
- **`sdk/README.md`.** Keep its "Server-side rendering" section short. Point it to the guide by its GitHub URL (`https://github.com/iglo-tech/iglo.base/blob/main/docs/ssr.md`); the npm page cannot follow relative links. Remove text the guide now duplicates, if the README gets long.
- **`examples/*/README.md`.** Link the matching guide section.
- **Publish on the site.** In the site repository `iglo-tech/iglo.tech` (private, on GitHub), add `docs/ssr.md` to the iglo.base project's `docs` list in `src/data/projects.ts`: slug `ssr`, title "Server-side rendering", and a one-line summary. Follow that repository's `AGENTS.md`. Open a separate PR there, titled "iglo.base: SSR guide", and run its checks as its AGENTS.md says. Its fetch step reads `docs/ssr.md` from iglo.base's `main`, so its build can only pass after the iglo.base PR merges: say so in that PR. Do not merge it.

## Verification

- iglo.base: `bun run check` passes. Code samples are compiled where practical. No `test:reference` is needed for a docs-only change.
- Open the iglo.base PR titled "P.13f: SSR user docs" against `main`, and in its body link the site PR. Do not merge either PR.
- The worker rules from `docs/design/12-work-plan.md` apply.
