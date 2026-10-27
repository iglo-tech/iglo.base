# Work plan

How the [port plan](09-port-plan.md) is split into tasks that agents can do one at a time and in parallel, and how each task is briefed, checked and merged.

## How work is handled

### Roles

| Role | Who | Does |
|---|---|---|
| Owner | the project owner | Decides scope and design changes, deliberate API differences, anything touching production data or real credentials. Approves the start of each wave |
| Lead | one agent session | Keeps this plan current, writes task briefs, starts workers, reviews and merges their PRs, resolves conflicts between tasks, escalates to the owner |
| Worker | one agent per task | Does one task in its own branch and worktree, opens one PR |
| Reviewer | a fresh agent, never the worker | Reviews one PR against upstream's source and these docs |

### One task

- **Size:** one upstream area that a single agent can port and test in one session: usually up to about 1,500 upstream Go lines plus their tests.
- **Branch and worktree:** `task/<id>-<slug>`, created from the current `main`. One PR per task.
- **Write scope:** the task names the modules it owns. A worker changes only those, plus new tests. A change to a module another task owns, or to a shared contract (below), goes back to the lead.
- **Done:** the acceptance check in the brief passes in CI, the design docs that the task touches still match the code, and the PR description lists what was ported (upstream file → iglo.base file) and anything left out with a reason.

### Task brief

The lead writes each brief from this template and passes it to the worker as its whole context:

```text
Task <id>: <title>
Goal: <one sentence>
Read first: AGENTS.md, docs/design/<docs>
Upstream (v0.41.0): <files and tests to port>
Owns: <src/... and test/... paths>
Depends on: <task ids, already merged>
Acceptance: <commands and scenario sets that must pass>
Out of scope: <what a neighboring task does>
Measurements: <docs/perf/... if the task changes db, filters, realtime or files>
```

### Rules for workers

- Follow `AGENTS.md`. Upstream v0.41.0 is the reference; read its source in the upstream checkout (task M0.2), never from memory.
- Port upstream's tests for the area first and run them against the upstream binary, then port the code. Each ported file names its upstream source file in a header comment.
- If upstream and the design disagree, or a test can only pass with a deliberate API difference, stop and report it in the PR. Do not decide it.
- No new runtime dependency, no change to a decision record, no change to another task's module without the lead.
- Never use production data. Fixtures are upstream's `tests/data`, fresh installs and generated data.

### Shared contracts

These are created in M0 and change only through a small task of their own, because every other task builds on them:

- the app context passed to modules (databases, settings, clock, filesystem, mailer, logger), with no process-global state;
- the database layer (`src/db`): connections, transactions, the query builder;
- the router, request event and API error helpers (`src/server`, `src/apis` base), matching upstream's error shape;
- the scenario format and the differential harness (`test/differential`, `test/scenarios`).

### Review and merge

1. CI is green: lint, format, typecheck, unit tests, the task's scenarios against iglo.base, and the differential suite for the touched areas.
2. A reviewer agent reads the PR next to the upstream files it ports and checks: behavior matches upstream, rules from `AGENTS.md`, no hook remnants or extension surface, tests through public boundaries only.
3. The lead fixes small findings itself, sends larger ones back to the worker, and merges with a squash commit. `main` stays green.
4. Escalations wait for the owner; other tasks continue.

### Parallelism

Tasks run in waves. A task starts when everything it depends on is merged. The lead runs at most four workers at once at first, and raises that once the shared contracts are stable. Tasks in the same wave own disjoint modules, so they do not conflict.

## Tasks

IDs follow milestones. "Upstream" names the main sources; each brief lists the exact files. Scenario counts are upstream's named `apis/*_test.go` scenarios (727 in total).

### M0: skeleton, tooling and spikes

Wave 0 is serial; the spikes run in parallel after M0.1.

| ID | Task | Upstream | Depends on | Acceptance |
|---|---|---|---|---|
| M0.1 | Project skeleton: `package.json`, `tsconfig` with `@/` aliases, oxlint, oxfmt, pre-commit hook, CI, Renovate, `bun build --compile`, CLI flag parsing (rejected extension flags, `update` error), `serve` with `/api/health` | `cmd/`, `pocketbase.go`, `apis/health.go` | none | Compiled executable serves `/api/health`; removed flags fail with the documented message; `AGENTS.md` lists the verification commands |
| M0.2 | Upstream reference: script that fetches upstream source at the pinned commit into a git-ignored directory and downloads the pinned v0.41.0 binaries (`test/differential/upstream.lock`); Mailpit and an S3 test server for tests | release files | M0.1 | One command prepares the upstream checkout, binaries, Mailpit and S3 test server on Linux and macOS |
| M0.3 | Shared contracts: app context, clock, API error helpers, router with upstream's route patterns, request event, base middlewares order | `tools/router`, `apis/base.go`, `core/app.go` (interfaces only) | M0.1 | Router matches upstream's pattern tests; error bodies match upstream's shape |
| M0.4 | Database layer: open both files with upstream pragmas, write connection, transactions, busy retry, the dbx subset builder | `core/db*.go`, `pocketbase/dbx` (used subset) | M0.1 | Opens upstream's fixture read-only; builder produces upstream's SQL text for the ported cases |
| M0.5 | Differential harness and scenario format: run a scenario against upstream and iglo.base on copies of a fixture, normalize, compare; run against iglo.base alone in fast CI | `tests/api.go`, `tests/app.go` | M0.2, M0.3 | The 3 health scenarios run against both servers |
| M0.6 | Spike D8: read worker pool vs main-thread reads, `--queryTimeout` | none | M0.4 | Report in `docs/perf/`; D8 updated |
| M0.7 | Spike D10: thumbnail library | `tools/filesystem` thumbs | M0.1 | Report; D10 updated |
| M0.8 | Spikes: multipart memory near 32 MiB, 1,000 SSE connections, bcrypt `$2b$` round trip through upstream, `setCustomSQLite` on macOS | none | M0.1, M0.2 | One report each; follow-up decisions recorded |

### M1: data layer

| ID | Task | Upstream | Depends on | Acceptance |
|---|---|---|---|---|
| M1.1 | Base tools: `types` (DateTime, JSONRaw, JSONArray, GeoPoint), `security` (random, JWT, AES-GCM), `list`, `inflector`, `store` | `tools/types`, `tools/security`, small tools | M0.1 | Ported unit tables pass; JSON raw text round-trips byte for byte |
| M1.2 | System schema and migrations: fresh-install schema, `_migrations` rows, open-time checks and refusal message | `migrations/`, `core/migrations*.go` | M0.4 | `sqlite_schema` of a fresh install equals upstream's; upstream v0.41.0 opens it with nothing pending; v0.40.x data opens; older data is refused |
| M1.3 | Settings: model, defaults, validation, encryption, `_params` | `core/settings*.go` | M1.1, M1.2 | Settings written by either server read back identically, encrypted and plain |
| M1.4 | Simple fields: text, editor, number, bool, email, url, date, autodate, select, json, geoPoint | `core/field_*.go` | M1.1 | Ported field tests pass |
| M1.5 | Complex fields: file, relation, password | `core/field_file.go`, `field_relation.go`, `field_password.go` | M1.4 | Ported field tests pass |
| M1.6 | Collections model, options (including auth options), validation, import | `core/collection_model*.go`, `collection_validate.go`, `collection_import.go` | M1.4 | Ported collection tests pass |
| M1.7 | Table sync and view collections | `core/collection_record_table_sync.go`, `core/view.go` | M1.6 | Same `sqlite_schema` and `_collections` rows as upstream for the same create, update and delete sequence |
| M1.8 | Record model and queries (internal CRUD, no HTTP) | `core/record_model*.go`, `core/record_query*.go` | M1.5, M1.7 | Records written internally read back identically in upstream |

### M2: read path

| ID | Task | Upstream | Depends on | Acceptance |
|---|---|---|---|---|
| M2.1 | fexpr and `tools/search`: tokenizer, parser, filter-to-SQL, sort, macros, functions | `fexpr`, `tools/search` | M0.4, M1.1 | Ported SQL tables pass |
| M2.2 | Record field resolver | `core/record_field_resolver*.go` | M2.1, M1.8 | Ported resolver tables pass |
| M2.3 | Tokens and auth loading: token parsing and signing, `Authorization` loading, superuser IP check | `core/record_tokens.go`, auth middleware | M1.8, M0.3 | Tokens from upstream verify in iglo.base and the reverse |
| M2.4 | Records list and view: expand, fields picker, `skipTotal`, list and view rules | `apis/record_crud.go` (read), `apis/record_helpers.go`, `core/record_query_expand.go`, `tools/picker` | M2.2, M2.3 | Ported list and view scenarios from `record_crud_test.go` pass in both servers |
| M2.5 | Collections read endpoints, scaffolds, OAuth2 providers metadata | `apis/collection.go` (read) | M1.7, M2.3 | Ported read scenarios from `collection_test.go` pass |
| M2.6 | Filter differential fuzzer | none | M2.4 | 100,000 cases clean |

### M3: write path

| ID | Task | Upstream | Depends on | Acceptance |
|---|---|---|---|---|
| M3.1 | Records create, update, delete: validation messages, `+`/`-` modifiers, cascade delete, create/update/delete rules | `apis/record_crud.go` (write), `forms/record_upsert.go` | M2.4 | Remaining `record_crud_test.go` scenarios (145 in the file) and the 16 `record_crud_superuser_test.go` scenarios pass |
| M3.2 | Local files: blob store, `.attrs`, uploads, file names, deletion worker | `tools/filesystem` (local), `core/field_file.go` save path | M1.5, M0.8 | Files and `.attrs` written by iglo.base are served by upstream |
| M3.3 | Batch API | `apis/batch.go` | M3.1 | 15 batch scenarios pass |
| M3.4 | Collections write, import, truncate, view dry run | `apis/collection.go` (write), `apis/collection_import.go` | M2.5, M1.7 | Remaining collection scenarios and 8 import scenarios pass |
| M3.5 | Settings API (S3 and email test endpoints stubbed until M4.4 and M5.4) | `apis/settings.go` | M1.3, M0.3 | Settings scenarios pass except the test endpoints |
| M3.6 | Data round-trip suite | none | M3.1, M3.2 | Upstream → iglo.base → upstream on the fixture and generated data, clean |

### M4: auth and mail

| ID | Task | Upstream | Depends on | Acceptance |
|---|---|---|---|---|
| M4.1 | Password auth, refresh, auth methods, impersonate, auth origins and alerts | `apis/record_auth_with_password.go`, `_refresh`, `_methods`, `_impersonate`, `core/auth_origin*` | M3.1 | Their scenarios pass (about 60) |
| M4.2 | OTP and MFA | `apis/record_auth_otp_request.go`, `_with_otp`, `core/otp*`, `core/mfa*` | M4.1, M4.4 | OTP and MFA scenarios pass (about 60, including `record_crud_otp`/`_mfa`) |
| M4.3 | Verification, password reset, email change, email templates | `apis/record_auth_verification*`, `_password_reset*`, `_email_change*`, `mails/` | M4.1, M4.4 | Their scenarios pass (about 70); emails in Mailpit match upstream's |
| M4.4 | Mailer: SMTP and `sendmail` with v0.41.0 behavior, test email endpoint | `tools/mailer`, `forms/test_email_send.go` | M0.2, M1.3 | Messages for the same action match upstream's in Mailpit |
| M4.5 | OAuth2 flow, redirect endpoint, `_externalAuths`, mock provider harness | `apis/record_auth_with_oauth2*.go`, `core/external_auth*`, `tools/auth/auth.go` | M4.1 | OAuth2 and redirect scenarios pass (about 80, including `record_crud_external_auth`) with one mock provider |
| M4.6 | OAuth2 providers, part 1: Apple, Bitbucket, Box, Discord, Facebook, Gitea, Gitee, GitHub, GitLab, Google, Instagram, Kakao, Lark, Linear, LiveChat | `tools/auth/*.go` | M4.5 | Each provider passes against its mock |
| M4.7 | OAuth2 providers, part 2: mailcow, Microsoft, monday.com, Notion, OIDC (3 slots), Patreon, Planning Center, Spotify, Strava, Trakt, Twitch, Twitter/X, VK, WakaTime, Yandex | `tools/auth/*.go` | M4.5 | Each provider passes against its mock |
| M4.8 | Rate limiter | `apis/middlewares_rate_limit.go` | M0.3, M1.3 | Rate-limit scenarios in `middlewares_test.go` pass |

### M5: realtime and operations

| ID | Task | Upstream | Depends on | Acceptance |
|---|---|---|---|---|
| M5.1 | Realtime: SSE broker, subscriptions, permission-aware broadcast after commit | `apis/realtime.go`, `tools/subscriptions` | M3.1, M0.8 | 19 realtime scenarios pass; 1,000 connections measured |
| M5.2 | Files endpoint, file tokens, protected files, thumbnails | `apis/file.go`, thumbs in `tools/filesystem` | M3.2, M0.7 | 28 file scenarios pass |
| M5.3 | Backups: create, list, download, delete, restore, upload, scheduled, local storage | `apis/backup*.go`, `core/backup*.go` | M3.2, M5.6 | 39 backup scenarios pass; backups restore across both servers |
| M5.4 | S3 with `Bun.S3Client`: backups first (D15), then file storage; S3 test endpoint | `tools/filesystem/internal/s3blob`, `forms/test_s3_filesystem.go` | M5.3 | Backups and files in the S3 test server are read back by upstream |
| M5.5 | Logs: buffered writer, API, stats, retention | `core/log*.go`, `tools/logger`, `apis/logs.go` | M0.4, M2.1 | 15 log scenarios pass |
| M5.6 | Cron scheduler, built-in jobs, `/api/crons` | `tools/cron`, `apis/cron.go` | M0.3 | 8 cron scenarios pass, with an injected clock |
| M5.7 | SQL console, `pb_public` static files, trusted proxy, gzip, CORS, body limits | `apis/sql.go`, `apis/serve.go` static, middlewares | M0.3, M2.3 | 11 SQL scenarios and the rest of `middlewares_test.go` pass |
| M5.8 | JavaScript SDK suite | none | M5.1, M5.2, M5.3 | Every SDK service method passes against both servers |
| M5.9 | Crash and restart tests | none | M5.3 | Kills during write, upload, backup and restore leave data both servers open |

### M6: dashboard and CLI

| ID | Task | Upstream | Depends on | Acceptance |
|---|---|---|---|---|
| M6.1 | Vendor `ui/` at v0.41.0 with the patch set, embed it, serve `/_/` with upstream's headers | `ui/`, `apis/serve.go` | M0.1 | Dashboard loads against iglo.base; `ui/PATCHES.md` lists every change; the 10 `extensions_test.go` scenarios pass with the marked differences |
| M6.2 | Installer and `superuser` commands | `apis/installer.go`, `cmd/superuser.go` | M4.1, M6.1 | Install flow works; `superuser` command tests pass |
| M6.3 | Automatic HTTPS (`serve example.com`) | `apis/serve.go` autocert | M0.1 | Certificates from a local ACME test server |
| M6.4 | Dashboard checklist and browser tests | none | M6.1, M6.2, M5.3, M5.5 | The `agent-browser` checklist passes; automated install, collection-and-record and logs tests pass |

### M7: 1.0 (MVP)

| ID | Task | Upstream | Depends on | Acceptance |
|---|---|---|---|---|
| M7.1 | Performance comparison against upstream | none | M5.8 | Numbers in `docs/perf/` meet the [performance bar](02-architecture.md#performance-bar) |
| M7.2 | User documentation linked from the dashboard, operations guide | none | M6.4 | Every dashboard documentation link resolves |
| M7.3 | Release workflow: three binaries on `v*` tags, bundled SQLite on macOS | none | M0.8 | A test tag produces three working binaries |
| M7.4 | Cutover rehearsal on the staging copy, with the owner (D20) | none | M7.3 | Move and rollback done once; outbound settings disabled before the first start |

M7.4 is the only task that touches production data. It is run with the owner, never by an unattended worker.

### After 1.0

| ID | Task | Depends on |
|---|---|---|
| P.1 | Official Docker image that wraps the release executable (D3) | M7.3 |

## Order

```text
M0.1 ─ M0.2 ─ M0.3 ─ M0.4 ─ M0.5          (serial, then spikes M0.6–M0.8 in parallel)
M1.1 ─┬─ M1.2 ─ M1.3
      └─ M1.4 ─ M1.5, M1.6 ─ M1.7 ─ M1.8
M2.1 ─ M2.2 ─ M2.4 ─ M2.6     M2.3, M2.5 alongside
M3.1 ─ M3.3, M4.1 …           M3.2, M3.4, M3.5 alongside; M3.6 when M3.1 and M3.2 are in
M4 and M5 run in parallel once M3.1 is merged; M6.1 can start any time after M0.1
M7 last
```

The critical path is M0 → M1.4 → M1.6 → M1.7 → M1.8 → M2.2 → M2.4 → M3.1. Everything else is scheduled around it.
