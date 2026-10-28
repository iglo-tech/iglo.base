# Port plan

## Upstream baseline

| | |
|---|---|
| Repository | https://ganigeorgiev.com/pocketbase/pocketbase (current home), cloned from `https://ganigeorgiev.com/git/pocketbase/pocketbase`. The GitHub archive (https://github.com/pocketbase/pocketbase) ends at v0.40.6 |
| Tag | `v0.41.0` |
| Commit | `f6baa0c43f379de21cd806de97ad6a2b8ca97b83` (2026-10-26) |
| License | MIT |
| Notes | v0.41.0 has the same data format and REST API as v0.40.6 ([D21](10-decisions.md#d21-baseline-moved-from-v0406-to-v0410)). Its Go dependencies (fexpr, dbx, ozzo-validation) moved to the same host; their sources are under `https://ganigeorgiev.com/git/<project>/<repo>` (`fexpr/fexpr`, `pocketbase/dbx`) |

Release binaries of v0.41.0 for each platform are pinned by SHA-256 in `test/differential/upstream.lock` and used as the reference server. Upstream's stable download URL is `https://ganigeorgiev.com/meta/pocketbase/pocketbase/download/{tag}/{filename}`.

What gets ported, by upstream path (non-test Go lines):

| Upstream | Size | Becomes |
|---|---|---|
| `core` | about 22,400 | `src/collections`, `src/fields`, `src/records`, `src/resolver`, `src/auth`, `src/settings`, `src/backups`, `src/logs`, `src/db` |
| `apis` | about 8,700 | `src/apis`, `src/middlewares`, `src/realtime`, `src/batch`, `src/server` |
| `tools/filesystem` | about 5,100 | `src/files` (much smaller with `Bun.S3Client`) |
| `tools/auth` | about 3,700 | `src/oauth2` |
| `tools/router`, `tools/search`, `tools/cron`, `tools/subscriptions`, `tools/mailer`, `tools/security`, `tools/types`, others | about 7,000 | matching modules |
| `migrations` | about 1,700 | `src/migrations`: the end-state schema plus `_migrations` rows; historical upgrade logic is not ported |
| `forms`, `mails` | about 1,000 | `src/records`, `src/mail` |
| `cmd`, `pocketbase.go` | about 600 | `src/cli` |
| `ui` | about 35,000 JS/CSS | `ui/` vendored with a patch set ([Admin UI](08-admin-ui.md)) |
| `apis/*_test.go` | about 21,000, about 720 named scenarios | `test/scenarios` as data |
| `tests/data` | fixture `pb_data` | `test/fixtures/pocketbase` (vendored byte for byte) |

Not ported: `plugins/jsvm`, `plugins/migratecmd`, `plugins/ghupdate` (the `update` command, D19), `tools/hook`, the hook and event plumbing in `core/events.go` and `core/event_*.go`, `tools/template` (only used by hooks), and the type generator (`tygoja`). That is roughly 6,000 lines of Go plus generated typings, and a large share of the indirection in `core`.

## Milestones

Each milestone ends with something usable and tested. The [work plan](12-work-plan.md) splits them into tasks.

| # | Milestone | Done when |
|---|---|---|
| M0 | **Skeleton and spikes:** Bun project, `@/` aliases, oxlint/oxfmt, hooks, CI, Renovate, `bun build --compile`, `Bun.serve` with `/api/health`, CLI flags, opening `pb_data` with upstream pragmas, the differential test harness that starts the upstream binary. Spikes, each with a short report in `docs/perf/`: read worker pool vs main-thread reads (D8), thumbnail library (D10), multipart memory, SSE with 1,000 connections, bcrypt `$2b$` round-trip through upstream, `setCustomSQLite` on macOS | The executable opens upstream's fixture `pb_data` read-only and serves `/api/health`; every spike has a recorded decision |
| M1 | **Data layer:** fresh-install schema identical to upstream (`sqlite_schema` diff is empty), open-time checks, settings (with encryption), collections model and validation, all field types, table sync for create/update/delete of collections, view collections | Creating and editing collections through internal calls produces the same `sqlite_schema` and `_collections` rows as upstream for the same operations |
| M2 | **Read path:** fexpr and filter-to-SQL with ported unit tables, record field resolver, records list and view, expand, fields picker, `skipTotal`, rules for list and view, superuser and record auth by token, `/api/collections` read endpoints | Ported list/view scenarios pass; the filter differential fuzzer runs clean for 100,000 cases |
| M3 | **Write path:** create, update, delete, validation messages, `+`/`-` modifiers, cascade delete, local file uploads and deletion, `.attrs`, batch API, collections write/import/truncate endpoints, settings API | Ported record, collection, batch and settings scenarios pass; the data round-trip suite passes |
| M4 | **Auth and mail:** password, refresh, verification, password reset, email change, OTP, MFA, auth origins and alerts, impersonation, OAuth2 with all providers, SMTP and sendmail, email templates, rate limits, superuser IPs | Ported auth scenarios pass; emails in Mailpit match upstream's |
| M5 | **Realtime and operations:** realtime SSE and permission-aware broadcast, files endpoint with thumbnails and protected files, S3 storage, backups (local and S3, scheduled, restore), logs and stats, crons, `/api/sql`, trusted proxy, gzip, CORS | The JS SDK scenario suite and realtime scenarios pass against iglo.base; backups restore across both servers |
| M6 | **Dashboard and CLI:** vendored UI with the patch set, installer, `superuser` commands, `serve` with automatic HTTPS | The dashboard checklist passes in `agent-browser` |
| M7 | **1.0 (MVP):** performance comparison against upstream ([Architecture](02-architecture.md#performance-bar)), operations guide (install, systemd unit, backups, cutover from PocketBase, rollback), user documentation linked from the dashboard (D17), release workflow on `v*` tags | Tagged release with binaries for linux-x64, linux-arm64 and darwin-arm64 (D18); a local copy of a production backup moved to iglo.base and rolled back to PocketBase once, with outbound settings disabled first (D20) |

M2 and M3 are the critical path. M4 and the S3/backups parts of M5 can run in parallel once M3's write path exists. Within M5, S3 backups come before S3 file storage, because the first real deployment uploads backups to S3 and keeps files local (D15).

After 1.0 (post-MVP): an official Docker image that wraps the same executable ([D3](10-decisions.md#d3-bun-typescript-one-executable)).

## Testing strategy

Compatibility is proven by running both servers, not by reading code.

### Reference tools

`bun run upstream:prepare` puts the pinned reference tools in `.upstream/` (git-ignored): the v0.41.0 source checkout at `.upstream/pocketbase`, and the host's `pocketbase`, `mailpit` and `versitygw` binaries in `.upstream/bin/`. Each archive is checked against its SHA-256 in `test/differential/upstream.lock`. `bun run test:reference` runs it and the smoke tests in `test/differential/`. Plain `bun test` needs none of this.

### Differential suite

The scenario format and the harness are a shared contract ([work plan](12-work-plan.md#shared-contracts)); changes go through the lead.

- **Format** (`test/scenarios/scenario.ts`): a scenario is one of upstream's `apis/*_test.go` table entries as typed TypeScript data, one module per area (`test/scenarios/<area>.ts`), grouped in suites by Go test function and listed in `test/scenarios/suites.ts`. Names stay verbatim so a scenario can be found in the Go file. It keeps every `ApiScenario` field (`name`, `method`, `url`, `body`, `headers`, `delayMs`, `timeoutMs`, `expectedStatus`, `expectedContent`, `notExpectedContent`) except `ExpectedEvents` (hook counts), which is dropped. `TestAppFactory` and `BeforeTestFunc` become `prepare`, which changes the scenario's fixture copy before any server starts on it; `AfterTestFunc` becomes `after`, which checks through public boundaries while the server still runs. Realtime subscriptions come with M5.1.
- **Fixture:** upstream's `tests/data`, vendored byte for byte in `test/fixtures/pocketbase/` (a `test:reference` test compares it with the pinned source). As in `NewTestApp`, every server gets its own fresh copy per scenario; the vendored files are never opened.
- **Request:** sent over a raw socket with the target exactly as written, carrying only what `httptest.NewRequest` would: `Host: example.com`, the default `content-type: application/json`, the scenario's headers (trimmed) and `Content-Length` for a body. `timeoutMs` stops reading the response at that point and checks what arrived (upstream cancels the request context instead).
- **Upstream-expectation mode** (plain `bun test`, `test/scenarios/scenarios.test.ts`): each scenario runs against the compiled executable alone and is checked as `tests/api.go` checks it: the status, then the content lists against the body after Go's `jsontext` reformatting (compact, shortest string escaping, numbers verbatim, a trailing newline; bodies that are not valid JSON, have invalid UTF-8 or duplicate names stay unchanged), and an empty body when neither list is set.
- **Differential mode** (`bun run test:reference`, `test/differential/scenarios.test.ts`): the prepared fixture is copied once more for each server; upstream v0.41.0 and iglo.base start on their copies and get the same request. Upstream must meet the scenario's expectations, which confirms that they describe real upstream behavior. iglo.base must meet them too, and its response is compared with upstream's (`test/differential/harness/compare.ts`): the status, `content-type` and upstream's security headers by value, and the body byte for byte after two normalizations, since member order, whitespace, string escaping, number text and the text of `json` field values (under any `fields` projection) are part of the API contract. First, generated values are replaced by the same placeholder on both sides: a value at a key upstream generates (`id`, `created`, `updated`, `token`, `otpId`, `mfaId`, `state`, `codeVerifier`, `codeChallenge`, `clientId`, listed in `generatedKeys`) that has the key's format, is not in the starting data and is not sent in the scenario's URL or body (raw, percent-decoded, or as a decoded JSON string) is compared by format only, and must pair consistently with iglo.base's value within the scenario; a string equal to a paired value elsewhere in the scenario (a relation to a new record) is replaced too. Everything else, including request data that looks like an ID, compares exactly. Second, objects that upstream encodes from a Go map without `json.Deterministic`, whose member order changes from response to response (every object of a successful response with `fields`, `/api/health`'s `data`; listed in `unorderedObjects`), have their members sorted by name on both sides; each member keeps its bytes. The bytes around the top-level JSON value count too. When JSON bodies differ, a structural diff reports where. Only API JSON is normalized (upstream's `content-type` is `application/json` and the request is not under `/api/files/`); file downloads and other bodies are compared byte for byte. New rules are added as code in that file.
- **Markers:** `pending` (task id and reason) marks a scenario iglo.base cannot pass yet. It still runs in both modes and must fail; the run reports it, and the test fails once it passes, so the task that fixes it removes the marker. `difference` names a row of the [deliberate differences](04-api-compatibility.md#deliberate-differences) and gives iglo.base's own expectations: upstream is still checked against the scenario's, iglo.base against its own, and the responses are not compared.

### Data round-trip suite

Upstream → iglo.base → upstream on the same `pb_data`, as described in [Data compatibility](03-data-compatibility.md#verification). Runs on every change to `src/db`, `src/collections`, `src/fields`, `src/records`, `src/files`, `src/settings` and `src/migrations`.

### SDK suites

A scenario suite written with the official JavaScript SDK calls every SDK service method (records, auth flows, realtime, files, batch, collections, settings, logs, backups, crons) against both servers. The SDK version is pinned to the one upstream's dashboard uses (`pocketbase` 0.28.x).

### Other

- **Filters:** ported unit tables plus the differential fuzzer ([Rules and filters](05-rules-and-filters.md#testing)).
- **Mail:** Mailpit, comparing upstream's and iglo.base's messages for the same action.
- **OAuth2:** a local mock provider per provider type.
- **Time:** injected clock for tokens, OTP/MFA expiry, macros and cron.
- **Crash and restart:** kill during a write transaction, during upload, during backup and during restore; the data directory must open cleanly in both servers afterwards.
- **Dashboard:** `agent-browser` checklist ([Admin UI](08-admin-ui.md#verification)).

## How to port a module

1. Read the upstream files and their tests. Note every hook call in the code path, and decide what the core itself needed from it (often realtime broadcast or file cleanup).
2. Turn upstream's table tests for the module into scenarios or unit tables first, and run them against the upstream binary to confirm they describe real behavior.
3. Port the code to TypeScript, keeping names and structure close to upstream's. Replace hook chains with direct calls. Name the upstream source file in each new file's header.
4. Run the scenarios against iglo.base and the differential suite against both. Any difference is either fixed or added to the deliberate-differences list with a reason.
5. If the module writes to `pb_data`, extend the round-trip suite.
