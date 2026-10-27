# Admin UI

## Approach: reuse upstream's dashboard

PocketBase's dashboard is a client of the public API. It talks to the server only through the PocketBase JS SDK, so if the API is compatible, the dashboard works unchanged. iglo.base vendors it instead of rewriting it.

| | |
|---|---|
| Upstream source | `ui/` at v0.40.6: about 220 files, 35,000 lines of vanilla JavaScript and CSS, built with [Shablon](https://github.com/ganigeorgiev/shablon) and Vite |
| Runtime dependencies | the `pocketbase` JS SDK and Leaflet from npm; vendored in `public/libs`: Shablon (0BSD), TinyMCE 6.8.6 (MIT), uPlot, Prism; dprint WASM for formatting at build time |
| License | MIT, part of PocketBase. TinyMCE must stay on 6.x: TinyMCE 7 and later are GPL-2.0-or-later without a commercial key |
| In iglo.base | `ui/`, built with `bun run --cwd ui build` (Vite under Bun), output embedded in the executable and served at `/_/` |

This also keeps the dashboard as a free end-to-end test of API compatibility: if a dashboard screen breaks, the API differs.

## Patch set

Changes to upstream's `ui/` are kept small and listed in `ui/PATCHES.md`, one entry per change, so a later upstream dashboard can be compared and re-applied by hand.

| Change | Why |
|---|---|
| Stop loading `/_/extensions.js` in `src/main.js` | No dashboard extensions. The endpoint still returns an empty script for cached old builds |
| Settings → Import collections: replace the "use Go or JS migrations" hint with a note that iglo.base has no user migrations | The linked features do not exist |
| Backups → restore modal: reword "applies all migrations that are missing" to "applies system migrations"| Only system migrations exist |
| Product name, logo, page title and footer: "iglo.base", with "PocketBase-compatible" and a link to PocketBase | Identity and credit ([Open questions](11-open-questions.md) has the default) |
| Documentation links (`PB_DOCS_URL`): keep pointing at pocketbase.io for API, rules and auth docs | They describe the same behavior |
| Version shown in the footer: iglo.base version plus "compatible with PocketBase v0.40.6" | Users need both |

No other UI changes in v1. In particular, the API preview panels (`src/apiPreview`) stay as they are: they document the same API.

## Installer

On `serve`, if `_superusers` has no superuser other than upstream's installer placeholder (`core.DefaultInstallerEmail`), iglo.base finds or creates that placeholder record, prints the installer URL `/_/#/pbinstall/<token>` with a short-lived auth token for it, and opens it in a browser when possible, as upstream's `apis/installer.go`. The placeholder is part of the data format: PocketBase and iglo.base must treat it the same way.

`superuser upsert|create|update|delete|otp|ips` CLI commands are available for headless setups.

## Serving

- `/_/` and assets with `Cache-Control: max-age=1209600, stale-while-revalidate=86400` outside `--dev`, gzip, and upstream's dashboard `Content-Security-Policy`.
- `X-Frame-Options` and `Cross-Origin-Opener-Policy` as upstream.

## Verification

- The upstream dashboard screens are exercised with `agent-browser` against iglo.base, following a written checklist in `docs/manual-tests/dashboard.md`: install, collections (all field types, rules, indexes, view collections), records (create, edit, files, relations, filters), auth options and OAuth2 provider setup, settings (mail test, S3 test, backups, rate limits, trusted proxy), logs, crons, SQL console, import/export.
- Automated browser tests cover the install flow, a full collection-and-record round trip and the logs page.
