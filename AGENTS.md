# AGENTS.md

## Repository identity

The project is `iglo.base`; its canonical repository is https://github.com/iglo-tech/iglo.base and its default branch is `main`.

iglo.base is an independently maintained port of PocketBase v0.41.0 (`f6baa0c43f379de21cd806de97ad6a2b8ca97b83`) to Bun and TypeScript. Upstream moved from GitHub (now archived at v0.40.6) to https://ganigeorgiev.com/pocketbase/pocketbase; clone it from `https://ganigeorgiev.com/git/pocketbase/pocketbase`. v0.41.0 keeps v0.40.x's data format, so v0.40.x `pb_data` works too. iglo.base is not an official PocketBase edition and is not intended to operate as a public open-source community project. It is published "as is": no formal support process, no issue triage process, no release promise, and no community governance files.

License: MIT, inherited from PocketBase. Keep PocketBase's copyright notice in `LICENSE`. Do not add code under incompatible licenses.

## Current state

Released (v1.0.0, 2026-11-05); post-1.0 work follows the work plan. The design in `docs/design/` describes the code; read `docs/design/README.md` first. When code and design disagree, fix one of them in the same change.

## The two compatibility contracts

These override convenience, style and performance. Read `docs/design/03-data-compatibility.md` and `docs/design/04-api-compatibility.md` before touching storage or HTTP code.

1. **Data:** iglo.base opens a PocketBase v0.41.0 (or v0.40.x, same format) `pb_data` directory without converting it, and leaves it in a state PocketBase v0.41.0 can open. Never add iglo-specific tables, columns, indexes, triggers, `_params` rows or `_migrations` rows. Never rewrite stored values into a different format.
2. **API:** every endpoint, field, status code, error body, header and realtime message that PocketBase v0.41.0 exposes behaves the same for the requests real clients send. Match results, not implementations: port upstream logic where the result depends on it and use Bun and Web APIs elsewhere. Malformed or hand-crafted input must be handled safely but may get a different error (D26). The reference is the upstream binary, checked by the differential test suite. Deliberate differences are listed in `docs/design/04-api-compatibility.md` and nowhere else.

## No extension surface

Do not add hooks, plugins, event buses for user code, an embedded JavaScript VM, custom route registration, dashboard extensions, a public library API or "escape hatch" configuration that runs user code. See `docs/design/01-scope.md` and decision D5. The one exception is JavaScript migrations in `pb_migrations` (D23), run by Bun with the bindings upstream gives migration files. TypeScript data migrations next to the schema file (D40, built on `develop`) are the same exception: migration files, run only at startup. Internal modules may call each other; that is not an extension API.

## Stack

- Bun ≥ 1.4, TypeScript, native ESM. Bun is the package manager (`bun.lock`).
- `Bun.serve` for HTTP. No Express or other framework.
- `bun:sqlite` as the only database. No other database, Redis or external queue.
- Upstream's S3 client ported on `fetch` for S3 storage and backups (`Bun.S3Client` cannot return the raw error bodies the API shows), `Bun.password` for bcrypt, Web Crypto for JWT and AES-GCM.
- The admin dashboard is upstream's `ui/` (vanilla JS, Shablon, Vite), vendored with a small patch set (`docs/design/08-admin-ui.md`).
- One compiled executable per platform (linux-x64, linux-arm64; D24, D35) is the release artifact. The official Docker image (`Dockerfile`, `.github/workflows/docker.yml`, D33; linux/amd64 and linux/arm64) only wraps those executables; it never builds from source. Do not add compose files, other registries or other distribution paths.
- The JavaScript SDK in `sdk/` (a Bun workspace; D36) is a second published artifact: the npm package `iglo.base`, a copy of the PocketBase JS SDK v0.28.1 that keeps the `pocketbase` package's API and ships ES modules only (no `./cjs`, `./umd` or script-tag build). It is built with `Bun.build` and `tsc` into `sdk/dist/`, uses no Bun-only APIs and no runtime dependencies, and has its own `@sdk/*` alias (the root's `@/*` maps to `src/`). Strict types, no `any` in `sdk/src` except the aliases in `sdk/src/tools/loose.ts`. Changes keep behavior identical to the upstream SDK unless a task says otherwise. The npm package is the only other distribution path allowed.

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
- Upstream PocketBase v0.41.0 is the reference: the differential suite runs the same requests against both and compares normalized responses.
- Port upstream's Go API scenarios (`apis/*_test.go`) as data-driven tests. Drop only their hook-event expectations.
- Time-dependent behavior is tested with an injected clock, not by sleeping.
- Use `agent-browser` to verify the admin dashboard.
- Store manual test data and test credentials in regular `.md` files in the repository.
- Never commit production data, backups or anything taken from them. The staging copy of production data lives outside the repository, and its outbound settings (S3 backups, SMTP) are disabled before any server runs on it (`docs/design/10-decisions.md` D20).

## Work split

The port is split into tasks in `docs/design/12-work-plan.md`. A task's worker follows its brief and the worker rules there, and changes only the modules the task owns. The chief of staff follows `docs/chief-of-staff.md` and keeps `docs/status.md` current. Agents decide and merge without the owner; decisions are logged for later review.

## Verification

Run from the repository root. Verification is local (D25): run `bun run check` and `bun run test:reference` on this host before a PR is ready. CI (`.github/workflows/ci.yml`) runs the same commands only on demand and is not a merge gate. Releases ship linux-x64 and linux-arm64 executables (D35); this host runs linux-x64 only, and linux-arm64 is tested natively by the on-demand `ci.yml` job `check-linux-arm64`. Other systems run from source with Bun (not tested or supported).

```sh
bun install --frozen-lockfile   # install
bun run lint                    # oxlint --deny-warnings
bun run format:check            # oxfmt --check (bun run format writes)
bun run typecheck               # tsc --noEmit
bun run test                    # bun test; builds the executable and tests it
bun run build                   # scripts/build.ts: dashboard pack, then bun build --compile of src/main.ts and the workers into dist/iglo-base (IGLO_VERSION sets the version)
bun run upstream:prepare        # pinned reference tools into .upstream/ (network; verified by SHA-256)
bun run sdk:build               # sdk/scripts/build.ts: tsc + Bun.build of sdk/ into sdk/dist/ (ESM bundle and declarations)
bun run sdk:check-package       # npm pack, install into a temporary project, import with Node and Bun, bun build, tsc consumer checks
bun run test:reference          # sdk:build and upstream:prepare, then the smoke tests in test/differential/
bun run test:browser            # dashboard browser tests in test/browser/ (needs agent-browser; not part of check)
bun run test:examples         # example apps in examples/ against both servers, one at a time (needs agent-browser; not part of check)
```

`bun run check` runs lint, format:check, typecheck (which builds the SDK first and checks `sdk/` too), test (which includes the SDK's unit tests in `sdk/test`, upstream's ported to `bun test` against a fetch mock), build (server executable and SDK) and `sdk:check-package` after install; `bun test` skips `test/differential/` (see `bunfig.toml`). `bun run test:reference` needs `git`, `unzip` and `tar`; Windows and macOS are out of scope (D18, D35). `bun run hooks:install` sets `core.hooksPath` to `.githooks`, whose pre-commit hook formats staged files with oxfmt. Markdown is not formatted by oxfmt.

Changes to the database access layer, filters, realtime or file handling must include before/after measurements, stored under `docs/perf/`.
