# Admin UI

## Approach: reuse upstream's dashboard

PocketBase's dashboard is a client of the public API. It talks to the server only through the PocketBase JS SDK, so if the API is compatible, the dashboard works unchanged. iglo.base vendors it instead of rewriting it.

| | |
|---|---|
| Upstream source | `ui/` at v0.41.0: about 220 files, 35,000 lines of vanilla JavaScript and CSS, built with [Shablon](https://github.com/ganigeorgiev/shablon) and Vite |
| Runtime dependencies | the `pocketbase` JS SDK and Leaflet from npm; vendored in `public/libs`: Shablon (0BSD), TinyMCE 6.8.6 (MIT), uPlot, Prism |
| License | MIT, part of PocketBase. TinyMCE must stay on 6.x: TinyMCE 7 and later are GPL-2.0-or-later without a commercial key |
| In iglo.base | `ui/`, built with `bun run --cwd ui build` (Vite under Bun), output embedded in the executable and served at `/_/` |

This also keeps the dashboard as a free end-to-end test of API compatibility: if a dashboard screen breaks, the API differs.

## Patch set

Changes to upstream's `ui/` are kept small and listed in `ui/PATCHES.md`, one entry per change, so a later upstream dashboard can be compared and re-applied by hand.

| Change | Why |
|---|---|
| Stop loading `/_/extensions.js` in `src/main.js` | No dashboard extensions. The endpoint still returns an empty script for cached old builds |
| Settings → Import collections: drop the Go part of the "use Go or JS migrations" hint; JS migrations are supported (D23) | Go migrations do not exist |
| Backups → restore modal: reword "applies all migrations that are missing" to "applies system migrations"| Only system migrations exist |
| Product name, logo, page title and footer: "iglo.base" only, no PocketBase label or link | One product for users ([D17](10-decisions.md#d17-dashboard-branding-iglobase-only)); credit stays in `LICENSE` and the README |
| Documentation links (`PB_DOCS_URL`): point at iglo.base's documentation | D17; where it lives is an [open question](11-open-questions.md) |
| Version shown in the footer: the iglo.base version | D17 |
| Product name in dashboard text ("By default PocketBase uses ...", the installer title, the trusted proxy help): "iglo.base" | D17. The `PocketBase` SDK class in code samples stays |
| Build: no `dist/`, `embed.go` or `embed_no_ui.go`; `bun.lock` instead of `package-lock.json` (same resolved versions) | Bun is the package manager; the build output is generated and embedded by `scripts/ui/build.ts` |

No other UI changes in v1. In particular, the API preview panels (`src/apiPreview`) stay as they are: they document the same API.

## Build and embedding

`bun run build` runs `scripts/ui/build.ts` first: `bun install --frozen-lockfile` and `vite build` under Bun in `ui/`, with `PB_VERSION` set to the executable's version, then packs `ui/dist` into `dist/ui.pack`. `src/main.ts` imports the pack as an embedded file (`with { type: "file" }`) and passes it to the CLI, so the executable serves the dashboard with no files beside it. Running from source without a build has no dashboard, as upstream's `no_ui` build: the banner shows only the REST API line and the installer prints the `superuser upsert` hint. An unchanged `ui/` (sources, lockfile, version) is not rebuilt.

## Installer

On `serve`, if `_superusers` has no superuser other than upstream's installer placeholder (`core.DefaultInstallerEmail`), iglo.base finds or creates that placeholder record, prints the installer URL `/_/#/pbinstall/<token>` with a short-lived auth token for it, and opens it in a browser when possible, as upstream's `apis/installer.go`. The placeholder is part of the data format: PocketBase and iglo.base must treat it the same way.

`superuser upsert|create|update|delete|otp|ips` CLI commands are available for headless setups.

## Serving

- `/_/` and assets with `Cache-Control: max-age=1209600, stale-while-revalidate=86400` outside `--dev`, gzip, and upstream's dashboard `Content-Security-Policy`.
- `X-Frame-Options` and `Cross-Origin-Opener-Policy` as upstream.
- `/_/{path...}` is upstream's `Static(ui, false)`: directory and `index.html` redirects, 404 JSON for missing files (no index fallback), ranges and preconditions of `http.ServeContent`. The root `/_/` has no `Cache-Control`; every other path, the 404s included, has it outside `--dev`.
- `/_/extensions.js` is an empty `text/javascript` response with the same headers; `/_/extensions/{name}/...` is the dashboard's 404.
- `test/ui/` checks these through the executable and `test/differential/ui/` against upstream's binary. `Vary: Origin` (CORS) comes with M5.7.

## Verification

- The upstream dashboard screens are exercised with `agent-browser` against iglo.base, following a written checklist in `docs/manual-tests/dashboard.md`: install, collections (all field types, rules, indexes, view collections), records (create, edit, files, relations, filters), auth options and OAuth2 provider setup, settings (mail test, S3 test, backups, rate limits, trusted proxy), logs, crons, SQL console, import/export.
- Automated browser tests cover the install flow, a full collection-and-record round trip and the logs page.
