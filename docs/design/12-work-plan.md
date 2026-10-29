# Work plan

How the [port plan](09-port-plan.md) is split into tasks that agents do one at a time, and how each task is briefed, reviewed by the council (the lead and one cross-lab reviewer) and merged without the owner.

## How work is handled

### Roles

| Role | Who | Does |
|---|---|---|
| Owner | the project owner | Sets direction. Is not asked for approvals: agents merge and decide on their own, and log decisions for later review. Takes part only in M7.4 (production data) |
| Lead (chief of staff) | a scheduled agent run, every 45 minutes ([runbook](../chief-of-staff.md)) | Keeps this plan and [`docs/status.md`](../status.md) current, writes task briefs, starts workers and the council, merges, decides design questions |
| Worker | one agent per task | Does one task in its own branch and worktree, opens one PR |
| Council | the lead and one fresh reviewer from another lab: GPT-6.1 Sol (xhigh reasoning), never the worker (D25) | The reviewer reviews each finished PR deeply against upstream's source and these docs. A PR merges only when both approve the same commit |

### Models

| Work | Model |
|---|---|
| Lead | Claude Opus 5.5 |
| Workers on core, security- or format-critical code (data layer, filters, resolver, tokens, auth flows, realtime, files, backups) | Claude Opus 5.5, medium effort |
| Workers on mechanical tasks (M0.2, M4.6, M4.7, M5.8, M7.2) and any bulk work inside other tasks (converting upstream table tests to scenario data, reading large files, summarizing logs and CI output) | Claude Haiku 5.5 |
| Reviewer | GPT-6.1 Sol at xhigh reasoning (no Claude reviewer, D25) |

### One task

- **Size:** one upstream area that a single agent can port and test in one session: usually up to about 1,500 upstream Go lines plus their tests.
- **Branch and worktree:** `task/<id>-<slug>`, created from the current `main`. One PR per task.
- **Write scope:** the task names the modules it owns. A worker changes only those, plus new tests. A change to a module another task owns, or to a shared contract (below), goes back to the lead.
- **Decisions:** design questions are decided by the lead, never left waiting. Each one is recorded in [Decisions](10-decisions.md) as "decided by agents, for owner review" and listed in `docs/status.md`.
- **Done:** the acceptance check in the brief passes locally (D25), the design docs that the task touches still match the code, and the PR description lists what was ported (upstream file → iglo.base file) and anything left out with a reason.

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

- Follow `AGENTS.md`. Upstream v0.41.0 is the reference; read its source in the upstream checkout (`.upstream/pocketbase`, created by `bun run upstream:prepare`), never from memory.
- Hand bulk mechanical work to Claude Haiku 5.5 subagents, and keep the judgment calls yourself.
- Port upstream's tests for the area first and run them against the upstream binary, then port the code. Each ported file names its upstream source file in a header comment.
- If upstream and the design disagree, or a test can only pass with a deliberate API difference, stop and report it in the PR. The lead decides it.
- No new runtime dependency, no change to a decision record, no change to another task's module without the lead.
- Never use production data. Fixtures are upstream's `tests/data`, fresh installs and generated data.

### Shared contracts

These are created in M0 and change only through a small task of their own, because every other task builds on them:

- the app context passed to modules (databases, settings, clock, filesystem, mailer, logger), with no process-global state;
- the database layer (`src/db`): connections, transactions, the query builder;
- the router, request event and API error helpers (`src/server`, `src/apis` base), matching upstream's error shape;
- the scenario format and the differential harness (`test/differential`, `test/scenarios`).

### Review and merge

1. The worker finishes when its PR is open and its acceptance check and the full local check (`bun run check`, `bun run test:reference`) pass on this host. CI is not a gate (D25).
2. **Review:** one reviewer from another lab (GPT-6.1 Sol, D25) reviews the PR deeply: the diff next to the upstream files it ports, these docs and `AGENTS.md`, behavior against upstream, no hook remnants or extension surface, tests through public boundaries only, the task's scope. It posts one PR comment with a verdict, `APPROVE` or `CHANGES`, for the exact head commit. A blocking finding names the realistic client and request behind it; malformed or exotic input that is handled safely is a backlog item, not a blocker (D26).
3. **Council:** the lead and the reviewer must agree. The lead reads every finding: it fixes or delegates the ones it agrees with, and answers the ones it disagrees with in the PR, with upstream's behavior as the reference. Later rounds verify the fixes and the code they touch, not the whole PR again.
4. **Deadlock:** after three rounds without agreement, the lead decides. Upstream's binary (the scenarios and the differential suite) is the tiebreaker, D26 decides what counts as a blocker, and the reasoning goes in the PR.
5. The lead squash-merges, deletes the branch and updates `docs/status.md`. `main` stays green locally.

### Pace

Correct first time over fast. One task at a time, end to end; the next one starts after the previous one is merged. At most two agents run at once (the worker or a fixer, and the reviewer), plus short lead-run helpers. If any agent hits a usage or rate limit, the lead pauses new work for an hour instead of retrying. Parallel tasks are considered only after M1 is merged, and still at most two workers.

### Hard limits

- No agent reads, copies or uses production data. M7.4 waits for the owner.
- No real credentials and no external services except GitHub and the upstream forge.
- Nothing destructive outside the repository. The host rules in `/home/t3-code/AGENTS.md` apply (no Docker disk accounting, no broad disk scans, low-priority bounded diagnostics).

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
| M0.8 | Spikes: multipart memory near 32 MiB, 1,000 SSE connections, bcrypt `$2b$` round trip through upstream (`setCustomSQLite` on macOS moved to P.2, D24) | none | M0.1, M0.2 | One report each; follow-up decisions recorded |

### M1: data layer

| ID | Task | Upstream | Depends on | Acceptance |
|---|---|---|---|---|
| M1.1 | Base tools: `types` (DateTime, JSONRaw, JSONArray, GeoPoint), `security` (random, JWT, AES-GCM), `list`, `inflector`, `store` | `tools/types`, `tools/security`, small tools | M0.1 | Ported unit tables pass; JSON raw text round-trips byte for byte |
| M1.1a | Go `regexp/syntax` parser subset (Perl flags, the parse tree, Go's error texts) and `security.RandomStringByRegex` on it; the same tree later lets M1.4 check text `pattern` values with Go's semantics | `tools/security/random_by_regex.go`, Go `regexp/syntax` | M1.1 | Ported random-by-regex tests pass; the same patterns are accepted, and rejected with upstream's error text, as the upstream binary does |
| M1.1b | Go `regexp` matching on the M1.1a parse tree: `syntax` compile and prog, the NFA (`exec.go`), `Compile`, `MatchString`, `QuoteMeta`, submatches, `ReplaceAllString`, `Split`. Linear time, as Go, so user patterns (text and password field `pattern`) cannot backtrack exponentially | Go `regexp`, `regexp/syntax` compile and prog | M1.1a | Go's `regexp` test tables for the ported functions pass (`find_test.go`, `all_test.go`, `exec_test.go`'s RE2 search tests); field patterns behave as in the upstream binary |
| M1.1c | Validation: the ozzo-validation v4.4.1 subset upstream uses (rules, `Errors`, error codes, messages and params), the `is` rules upstream uses with govalidator `a9d515a`, and `core/validators` | `ozzo-validation`, `is`, govalidator (used subset), `core/validators` | M1.1b | Ported unit tables pass; validation error JSON (code, message) matches upstream's |
| M1.2 | System schema and migrations: fresh-install schema, `_migrations` rows, open-time checks and refusal message | `migrations/`, `core/migrations*.go` | M0.4, M1.7 (the init migration saves system collections) | `sqlite_schema` of a fresh install equals upstream's; upstream v0.41.0 opens it with nothing pending; v0.40.x data opens; older data is refused |
| M1.3 | Settings: model, defaults, validation, encryption, `_params`, the superuser IP check that reads them (from M2.3), and the Settings API (folded in from M3.5 on 2026-10-29; S3 and email test endpoints stubbed until M5.4 and M4.4, Apple client secret until M4.6) | `core/settings*.go`, `superuserIPsWhitelist` in `apis/middlewares.go`, `apis/settings.go` | M1.1, M1.1c, M1.2, M0.3 | Settings written by either server read back identically, encrypted and plain; settings scenarios pass except the test endpoints |
| M1.4 | Simple fields: text, editor, number, bool, email, url, date, autodate, select, json, geoPoint | `core/field_*.go` | M1.1, M1.1a, M1.1b, M1.1c | Ported field tests pass |
| M1.5 | Complex fields: relation and password (bcrypt hashes in Go's `$2a$` form) | `core/field_relation.go`, `field_password.go` | M1.4 | Ported field tests pass; password hashes written by either server verify in the other |
| M1.5a | MIME detection: a port of `gabriel-vasile/mimetype` v1.4.15 (the whole detection tree, `Detect`, `DetectReader`, `Is`, `Extension`, aliases and the 4096-byte read limit), used by file uploads, file serving, mail attachments and file names | `gabriel-vasile/mimetype` v1.4.15 | M1.1 | Its test tables and testdata pass; the upstream binary accepts and rejects the same uploads by `mimeTypes` as iglo.base's detection predicts |
| M1.5b | File field: settings, value normalization and modifiers, upload size and MIME checks (`core/validators/file.go`, the `filesystem.File` model); storing and deleting files stays with M3.2 | `core/field_file.go`, `core/validators/file.go`, `tools/filesystem/file.go` | M1.5, M1.5a | Ported field and validator tests pass; the same uploads are accepted or rejected as by the upstream binary |
| M1.6 | Collection model: `Collection` and its constructors, JSON (options flattened as upstream), `PostScan`, `DBExport`, index helpers, default system fields and id, base, view and auth options with their defaults and auth email templates; `FieldsList`; `tools/dbutils` | `core/collection_model.go` (model part), `collection_model_*_options.go`, `collection_model_auth_templates.go`, `core/fields_list.go`, `tools/dbutils` | M1.5, M1.5b | Ported model, FieldsList and dbutils tests pass; `_collections` rows written by upstream read back and export byte for byte |
| M1.6a | Collection validation and queries: `collectionValidator`, the options' `Validate` methods, `updateGeneratedIdIfExists`, find/cache/references/unique-name queries; the rule check waits for M2.2 and the view query check for M1.7; OAuth2 provider names are checked against upstream's fixed name list until M4.5 adds the providers | `core/collection_validate.go`, the `Validate` parts of `collection_model_*_options.go`, `updateGeneratedIdIfExists` in `core/collection_model.go`, `core/collection_query.go` (find, cache, references, unique name) | M1.6 | Ported validation and query tests pass, except rule and view-query cases, which are marked pending; validation errors (code, message, params) match upstream's |
| M1.7 | Table sync, view collections, collection save and delete, import | `core/collection_record_table_sync.go`, `core/view.go` (without `FindRecordByViewFile`), the save and delete part of `core/collection_model.go` (without `updateGeneratedIdIfExists`), `core/collection_import.go`, `normalizeViewQueryId` and `resaveViewsWithChangedFields` in `core/collection_query.go`; M1.6a's view field generation and view query check | M1.6a | Same `sqlite_schema` and `_collections` rows as upstream for the same create, update and delete sequence; ported save, delete, view and import tests pass |
| M1.8 | Split on 2026-10-28 into M1.8a, M1.8b and M1.8c (two workers stopped before writing code). The filter finders and `CanAccessRecord` go to M2.2, `FindAuthRecordByToken` to M2.3, expand to M2.4 | — | — | M1.8c's acceptance |
| M1.8a | Record model: `Record` and its constructors (`newRecordFromNullStringMap`), accessors, Original/Fresh/Clone, expand getters and setters, FieldsData/CustomData and the visibility flags, Set/Get/Load and the typed getters, file getters, DBExport, Hide/Unhide, PublicExport, JSON, ReplaceModifiers; auth accessors; IsSuperuser | `core/record_model.go` (up to `callFieldInterceptors`, without the save/delete chain), `core/record_model_auth.go`, `IsSuperuser` in `core/record_model_superusers.go` | M1.5b, M1.7 | Ported model tests pass; rows written by upstream export through PublicExport with upstream's GET body bytes |
| M1.8b | Record queries: `RecordQuery` (execLockRetry, hydration), FindRecordById, FindRecordsByIds, FindAllRecords, FindFirstRecordByData, CountRecords, FindAuthRecordByEmail, `FindRecordByViewFile`; DryRunView's sample with records | `core/record_query.go` (without the filter, token and access functions), `FindRecordByViewFile` in `core/view.go` | M1.8a | Ported query tests pass; the same records are found as upstream finds |
| M1.8c | Record save, validate and delete (internal CRUD, no HTTP): the save chain in upstream's hook order, field interceptors, token key refresh, cross-auth id check, cascade delete, superuser protections, `TruncateCollection` | `core/record_model.go` (`callFieldInterceptors` to the end), `core/record_model_superusers.go`, `TruncateCollection` in `core/collection_query.go` | M1.8b | Records written internally read back identically in upstream |

### M2: read path

| ID | Task | Upstream | Depends on | Acceptance |
|---|---|---|---|---|
| M2.1 | fexpr and `tools/search`: tokenizer, parser, filter-to-SQL, sort, macros, functions | `fexpr`, `tools/search` | M0.4, M1.1 | Ported SQL tables pass |
| M2.2 | Record field resolver, the collection rule check M1.6a leaves pending, and the filter record queries | `core/record_field_resolver*.go`; `FindRecordsByFilter`, `FindFirstRecordByFilter`, `CanAccessRecord` in `core/record_query.go` | M2.1, M1.8c | Ported resolver tables pass |
| M2.3 | Tokens and auth loading: token parsing and signing, `Authorization` loading, the `Require*` auth guards (the superuser IP check moved to M1.3, which owns the settings it reads) | `core/record_tokens.go`, `FindAuthRecordByToken` in `core/record_query.go`, `loadAuthToken` and the `Require*` guards in `apis/middlewares.go` | M1.8c, M0.3 | Tokens from upstream verify in iglo.base and the reverse |
| M2.4 | Records list and view: expand, fields picker, `skipTotal`, list and view rules | `apis/record_crud.go` (read), `apis/record_helpers.go`, `core/record_query_expand.go`, `tools/picker` | M2.2, M2.3, M1.2 (serve opens pb_data) | Ported list and view scenarios from `record_crud_test.go` pass in both servers |
| M2.5 | Collections read endpoints, scaffolds, OAuth2 providers metadata | `apis/collection.go` (read) | M1.7, M2.3 | Ported read scenarios from `collection_test.go` pass |
| M2.6 | Filter differential fuzzer | none | M2.4 | 100,000 cases clean |

### M3: write path

| ID | Task | Upstream | Depends on | Acceptance |
|---|---|---|---|---|
| M3.1 | Records create, update, delete: validation messages, `+`/`-` modifiers, cascade delete, create/update/delete rules | `apis/record_crud.go` (write), `forms/record_upsert.go` | M2.4 | Remaining `record_crud_test.go` scenarios (145 in the file) and the 16 `record_crud_superuser_test.go` scenarios pass |
| M3.2 | Local files: blob store, `.attrs`, uploads, file names, deletion worker | `tools/filesystem` (local), `core/field_file.go` save path | M1.5b, M0.8 | Files and `.attrs` written by iglo.base are served by upstream |
| M3.3 | Batch API | `apis/batch.go` | M3.1 | 15 batch scenarios pass |
| M3.4 | Collections write, import, truncate, view dry run (folded into M2.5 on 2026-10-29) | `apis/collection.go` (write), `apis/collection_import.go` | M2.5, M1.7 | Remaining collection scenarios and 8 import scenarios pass |
| M3.5 | Folded into M1.3 on 2026-10-29 (settings can only be checked through a public boundary with the API) | — | — | M1.3's acceptance |
| M3.6 | Data round-trip suite | none | M3.1, M3.2 | Upstream → iglo.base → upstream on the fixture and generated data, clean |
| M3.7 | JavaScript migrations (D23): `pb_migrations` applied at startup and recorded in `_migrations`, the `migrate` command, `--migrationsDir`, `--automigrate` with upstream's templates, and the bindings migration files use; remove the `pb_migrations` warning and the `migrate`/flag rejections | `plugins/migratecmd`, the migration part of `plugins/jsvm` | M3.4 | Upstream's `migratecmd` tests pass; migrations generated by either server apply in the other with the same `sqlite_schema`, `_collections` and `_migrations`; the JS migration examples from upstream's docs run |

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
| M6.2 | Installer and `superuser` commands (folded into M6.1 on 2026-10-29) | `apis/installer.go`, `cmd/superuser.go` | M4.1, M6.1 | Install flow works; `superuser` command tests pass |
| M6.3 | Automatic HTTPS (`serve example.com`) | `apis/serve.go` autocert | M0.1 | Certificates from a local ACME test server |
| M6.4 | Dashboard checklist and browser tests | none | M6.1, M6.2, M5.3, M5.5 | The `agent-browser` checklist passes; automated install, collection-and-record and logs tests pass |

### M7: 1.0 (MVP)

| ID | Task | Upstream | Depends on | Acceptance |
|---|---|---|---|---|
| M7.1 | Performance comparison against upstream | none | M5.8 | Numbers in `docs/perf/` meet the [performance bar](02-architecture.md#performance-bar) |
| M7.2 | User documentation linked from the dashboard, operations guide | none | M6.4 | Every dashboard documentation link resolves |
| M7.3 | Release workflow: the linux-x64 binary on `v*` tags (D24) | none | M0.8 | A test tag produces a working linux-x64 binary |
| M7.4 | Cutover rehearsal on the staging copy, with the owner (D20) | none | M7.3 | Move and rollback done once; outbound settings disabled before the first start |

M7.4 is the only task that touches production data. It is run with the owner, never by an unattended worker.

### After 1.0

| ID | Task | Depends on |
|---|---|---|
| P.1 | Official Docker image that wraps the release executable (D3) | M7.3 |
| P.2 | macOS (darwin-arm64) and linux-arm64 builds: release binaries, bundled SQLite on macOS through `Database.setCustomSQLite`, macOS CI job for `test:reference` (D24) | M7.3 |

## Order

```text
M0.1 ─ M0.2 ─ M0.3 ─ M0.4 ─ M0.5          (serial, then spikes M0.6–M0.8 in parallel)
M1.1 ─ M1.1a ─ M1.1b ─ M1.1c ─ M1.4 ─ M1.5 ─ M1.5a ─ M1.5b ─ M1.6 ─ M1.6a ─ M1.7 ─┬─ M1.8a ─ M1.8b ─ M1.8c
                                                                                   └─ M1.2 ─ M1.3
M2.1 ─ M2.2 ─ M2.4 ─ M2.6     M2.3, M2.5 alongside
M3.1 ─ M3.3, M4.1 …           M3.2, M3.4, M3.5 alongside; M3.6 when M3.1 and M3.2 are in
M4 and M5 run in parallel once M3.1 is merged; M6.1 can start any time after M0.1
M7 last
```

**Usable first (lead decision, 2026-10-29).** With the critical path through M3.1 merged, the next tasks follow what a real app needs to run on iglo.base, as far as their dependencies allow: M1.3 (settings, with the Settings API) → M4.1 (password auth) → M0.8 → M3.2 (file storage) → M2.5 → M3.4 (collections API) → M6.1 → M6.2 (dashboard and installer) → M4.4 (mail) → M0.7 → M5.2 (file serving) → M5.1 (realtime), then the rest in milestone order.

The critical path was M0 → M1.1 → M1.1a → M1.1b → M1.1c → M1.4 → M1.5 → M1.5a → M1.5b → M1.6 → M1.6a → M1.7 → M1.8a → M1.8b → M1.8c → M2.2 → M2.3 → M1.2 → M2.4 → M3.1. Everything else is scheduled around it.
