# Port plan

## Upstream baseline

| | |
|---|---|
| Repository | https://ganigeorgiev.com/pocketbase/pocketbase (current home). Read-only archive with the same tag: https://github.com/pocketbase/pocketbase |
| Tag | `v0.40.6` |
| Commit | `9d281ccaba65f2686eb7b0b614ccda72d1116a1b` (2026-10-23) |
| License | MIT |
| Notes | The GitHub archive's `master` is one commit ahead (a README note about the move). The new host is a web forge without a git endpoint at the time of writing; the GitHub tag is the source for porting |

Release binaries of v0.40.6 for each platform are pinned by SHA-256 in `test/differential/upstream.lock` and used as the reference server.

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
| `tests/data` | fixture `pb_data` | `test/fixtures/upstream` |

Not ported: `plugins/jsvm`, `plugins/migratecmd`, `plugins/ghupdate` (the `update` command, D19), `tools/hook`, the hook and event plumbing in `core/events.go` and `core/event_*.go`, `tools/template` (only used by hooks), and the type generator (`tygoja`). That is roughly 6,000 lines of Go plus generated typings, and a large share of the indirection in `core`.

## Milestones

Each milestone ends with something usable and tested.

| # | Milestone | Done when |
|---|---|---|
| M0 | **Skeleton and spikes:** Bun project, `@/` aliases, oxlint/oxfmt, hooks, CI, Renovate, `bun build --compile`, `Bun.serve` with `/api/health`, CLI flags, opening `pb_data` with upstream pragmas, the differential test harness that starts the upstream binary. Spikes, each with a short report in `docs/perf/`: read worker pool vs main-thread reads (D8), thumbnail library (D10), multipart memory, SSE with 1,000 connections, bcrypt `$2b$` round-trip through upstream, `setCustomSQLite` on macOS | The executable opens upstream's fixture `pb_data` read-only and serves `/api/health`; every spike has a recorded decision |
| M1 | **Data layer:** fresh-install schema identical to upstream (`sqlite_schema` diff is empty), open-time checks, settings (with encryption), collections model and validation, all field types, table sync for create/update/delete of collections, view collections | Creating and editing collections through internal calls produces the same `sqlite_schema` and `_collections` rows as upstream for the same operations |
| M2 | **Read path:** fexpr and filter-to-SQL with ported unit tables, record field resolver, records list and view, expand, fields picker, `skipTotal`, rules for list and view, superuser and record auth by token, `/api/collections` read endpoints | Ported list/view scenarios pass; the filter differential fuzzer runs clean for 100,000 cases |
| M3 | **Write path:** create, update, delete, validation messages, `+`/`-` modifiers, cascade delete, local file uploads and deletion, `.attrs`, batch API, collections write/import/truncate endpoints, settings API | Ported record, collection, batch and settings scenarios pass; the data round-trip suite passes |
| M4 | **Auth and mail:** password, refresh, verification, password reset, email change, OTP, MFA, auth origins and alerts, impersonation, OAuth2 with all providers, SMTP and sendmail, email templates, rate limits, superuser IPs | Ported auth scenarios pass; emails in Mailpit match upstream's |
| M5 | **Realtime and operations:** realtime SSE and permission-aware broadcast, files endpoint with thumbnails and protected files, S3 storage, backups (local and S3, scheduled, restore), logs and stats, crons, `/api/sql`, trusted proxy, gzip, CORS | The JS SDK scenario suite and realtime scenarios pass against iglo.base; backups restore across both servers |
| M6 | **Dashboard and CLI:** vendored UI with the patch set, installer, `superuser` commands, `serve` with automatic HTTPS | The dashboard checklist passes in `agent-browser` |
| M7 | **1.0:** performance comparison against upstream ([Architecture](02-architecture.md#performance-bar)), operations guide (install, systemd unit, backups, cutover from PocketBase, rollback), user documentation linked from the dashboard (D17), release workflow on `v*` tags | Tagged release with binaries for linux-x64, linux-arm64 and darwin-arm64 (D18); a local copy of a production backup moved to iglo.base and rolled back to PocketBase once, with outbound settings disabled first (D20) |

M2 and M3 are the critical path. M4 and the S3/backups parts of M5 can run in parallel once M3's write path exists. Within M5, S3 backups come before S3 file storage, because the first real deployment uploads backups to S3 and keeps files local (D15).

## Testing strategy

Compatibility is proven by running both servers, not by reading code.

### Differential suite

- A scenario is a sequence of HTTP requests (and realtime subscriptions) plus a fixture. The harness copies the fixture twice, starts upstream v0.40.6 on one copy and iglo.base on the other, sends the same requests to both and compares responses after normalization (IDs, tokens and timestamps compared by format; `json` field values compared as bytes).
- Most scenarios are generated from upstream's `apis/*_test.go` table tests (`Name`, `Method`, `URL`, `Body`, `Headers`, `ExpectedStatus`, `ExpectedContent`, `NotExpectedContent`). Their `ExpectedEvents` (hook counts) are dropped. Each scenario also keeps its upstream expectations, so it can run against iglo.base alone in fast CI.
- Deliberate differences ([API compatibility](04-api-compatibility.md#deliberate-differences)) are marked per scenario.

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
