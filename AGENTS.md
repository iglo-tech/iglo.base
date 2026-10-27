# AGENTS.md

## Repository identity

The project is `iglo.base`; its canonical repository is https://github.com/iglo-tech/iglo.base and its default branch is `main`.

iglo.base is an independently maintained port of PocketBase v0.40.6 (`9d281ccaba65f2686eb7b0b614ccda72d1116a1b`) to Bun and TypeScript. Upstream moved from GitHub (now archived) to https://ganigeorgiev.com/pocketbase/pocketbase; the GitHub archive has the same v0.40.6 tag. iglo.base is not an official PocketBase edition and is not intended to operate as a public open-source community project. It is published "as is": no formal support process, no issue triage process, no release promise, and no community governance files.

License: MIT, inherited from PocketBase. Keep PocketBase's copyright notice in `LICENSE`. Do not add code under incompatible licenses.

## Current state

Design phase. The design is in `docs/design/` and is the source of truth until code exists. Read `docs/design/README.md` first. When code and design disagree, fix one of them in the same change.

## The two compatibility contracts

These override convenience, style and performance. Read `docs/design/03-data-compatibility.md` and `docs/design/04-api-compatibility.md` before touching storage or HTTP code.

1. **Data:** iglo.base opens a PocketBase v0.40.6 `pb_data` directory without converting it, and leaves it in a state PocketBase v0.40.6 can open. Never add iglo-specific tables, columns, indexes, triggers, `_params` rows or `_migrations` rows. Never rewrite stored values into a different format.
2. **API:** every endpoint, field, status code, error body, header and realtime message that PocketBase v0.40.6 exposes behaves the same. The reference is the upstream binary, checked by the differential test suite. Deliberate differences are listed in `docs/design/04-api-compatibility.md` and nowhere else.

## No extension surface

Do not add hooks, plugins, event buses for user code, a JavaScript VM, user migrations, custom route registration, dashboard extensions, a public library API or "escape hatch" configuration that runs user code. See `docs/design/01-scope.md` and decision D5. Internal modules may call each other; that is not an extension API.

## Stack

- Bun ≥ 1.4, TypeScript, native ESM. Bun is the package manager (`bun.lock`).
- `Bun.serve` for HTTP. No Express or other framework.
- `bun:sqlite` as the only database. No other database, Redis or external queue.
- `Bun.S3Client` for S3 storage and backups, `Bun.password` for bcrypt, Web Crypto for JWT and AES-GCM.
- The admin dashboard is upstream's `ui/` (vanilla JS, Shablon, Vite), vendored with a small patch set (`docs/design/08-admin-ui.md`).
- One compiled executable is the only release artifact. Do not add Docker, compose, or parallel distribution paths.

## Rules

- Use `@/` path-alias imports everywhere, including tests. No relative imports (`./`, `../`) unless a tool cannot resolve aliases.
- Import from the module that owns a symbol. No barrel files, re-export layers, service locators or generic registries.
- No process-global state. Modules receive the database, settings and clock they use.
- Keep module and function names close to upstream's Go packages where that helps side-by-side review. Each ported file names its upstream source file in a header comment.
- `json` field values, `_params.value` and other stored JSON are passed through as raw text unless a value must be changed. `JSON.parse` + `JSON.stringify` reorders integer-like keys and loses precision on large numbers.
- Network calls (SMTP, OAuth2, S3) never run inside a database write transaction.
- Add a runtime dependency only when the design lists it or a decision record justifies it.
- Do not restore upstream community files (`CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, issue or PR templates, funding files).
- Dependency updates use Renovate. Do not add Dependabot.
- Application code logs only errors and things that need attention. No informational console output. CLI command output (including the `serve` banner, which upstream prints) is fine.

## Tests

- Tests verify observable behavior through public boundaries: HTTP API, realtime streams, emails received by the SMTP sink (Mailpit), files on disk or in an S3 test server, and the `pb_data` directory read back by upstream PocketBase. Never read source files as text or assert on implementation details.
- Upstream PocketBase v0.40.6 is the reference: the differential suite runs the same requests against both and compares normalized responses.
- Port upstream's Go API scenarios (`apis/*_test.go`) as data-driven tests. Drop only their hook-event expectations.
- Time-dependent behavior is tested with an injected clock, not by sleeping.
- Use `agent-browser` to verify the admin dashboard.
- Store manual test data and test credentials in regular `.md` files in the repository.

## Verification

Until the M0 skeleton exists, changes are documentation only: check links, file names and `git status`. After M0, the commands are listed here and in `package.json`.

Changes to the database access layer, filters, realtime or file handling must include before/after measurements, stored under `docs/perf/`.
