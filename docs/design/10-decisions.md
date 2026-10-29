# Decisions

Short records. Each one says what was decided, why, and what was considered instead. Change a decision by editing its record and noting the date.

## D1. Port of PocketBase v0.41.0, not a tracking fork

Decided 2026-10-27.

- **Decision:** port PocketBase v0.41.0 to TypeScript and own the result. Do not track upstream automatically; review later upstream releases by hand ([D16](#d16-upstream-releases-after-v0410-fixes-only-by-hand)).
- **Why:** the stack differs (Go upstream, Bun here), so a tracking fork is impossible anyway. v0.41.0 is the current release and the first on upstream's new host. Its data format and REST API are the same as v0.40.6's ([D21](#d21-baseline-moved-from-v0406-to-v0410)).
- **Considered:**
  - a Go fork with the extension code deleted, which keeps a second language and toolchain;
  - a clean-room reimplementation from the docs, which would miss the undocumented behavior that compatibility depends on.

## D2. MIT

- **Decision:** license iglo.base under MIT and keep PocketBase's copyright notice next to iglo.base's.
- **Why:** PocketBase is MIT; keeping the same license is the simplest correct option. fexpr (BSD-3-Clause) and Shablon (0BSD) keep their notices where they are vendored.

## D3. Bun, TypeScript, one executable

- **Decision:** Bun ≥ 1.4 and TypeScript, shipped as one compiled executable with the dashboard embedded. The MVP ships only that executable.
- **Post-MVP:** an official Docker image that wraps the same executable. Not before the executable works and 1.0 ships.
- **Why:** the same stack and release model as iglo.monitor and iglo.email. Bun's server, SQLite, S3 client, password hashing and bundler cover most of what upstream needs third-party Go modules for. PocketBase is also one executable, so the deployment model does not change.

## D4. PocketBase's data format, unchanged and two-way

- **Decision:** read and write `pb_data` exactly as PocketBase v0.41.0 does. No iglo-specific tables, columns, `_params` rows or `_migrations` rows.
- **Why:** moving without migrations was the main requirement. Keeping the format two-way also makes rollback trivial and lets upstream be the test oracle on the same files.
- **Considered:** an own schema with an importer. Rejected: it turns every move into a migration project and removes the easy rollback.

## D5. No extension surface

- **Decision:** no Go framework mode, no JS hooks, no user migrations, no dashboard extensions, no plugin API, no public library API.
- **Why:**
  - it was the one explicitly requested simplification;
  - upstream's core is shaped around hooks: removing them shrinks `core` and makes behavior fixed and testable;
  - an embedded JS VM is the riskiest and largest dependency to port;
  - custom logic belongs in the apps, talking to iglo.base over its API and realtime stream.
- **Consequence:** deployments that used hooks must move that logic out first ([Data compatibility](03-data-compatibility.md#cutover-checklist)).
- **Changed by D23 (2026-10-28):** user migrations (`pb_migrations`, the `migrate` command, `--migrationsDir`, `--automigrate`) are supported again; the rest of this decision stands.

## D6. Upstream's binary is the specification

- **Decision:** API behavior is defined by what upstream v0.41.0 does, checked by the differential suite, not by the docs or by reading code.
- **Why:** "100% compatible" can only be shown by comparison. Upstream's ~720 API scenarios give a large head start.

## D7. Reuse upstream's dashboard

- **Decision:** vendor upstream's `ui/` with a small, listed patch set.
- **Why:** it is a pure API client, so it works unchanged against a compatible server, and it is about 35,000 lines that would otherwise be rewritten for no product gain.
- **Considered:** rewriting it in the style of iglo.email (server-rendered TSX) or iglo.monitor (Vue). Rejected: large cost, and it would lose the dashboard as a compatibility check.

## D8. SQLite access: main-thread connection, read worker pool for timed reads

Decided by agents on 2026-10-28, for owner review (M0.6 spike, [report](../perf/M0.6-read-path.md)).

- **Decision:**
  - One connection per database file on the main thread runs every write, every transaction and every synchronous read, as upstream's nonconcurrent DB does. The db API stays synchronous.
  - The concurrent builders also have async resolvers (`oneAsync`, `allAsync`, `rowAsync`, `columnAsync`). Outside a transaction these run on a pool of Bun workers, each with read-only connections to both files, with upstream's pragmas. Request-path reads that can be slow use them: lists, views, counts, expands, logs, and rule checks outside write transactions. In a transaction both builders are the transaction, so its reads stay on its connection and run synchronously.
  - Default pool size: 4 workers (`defaultReadWorkers`). Queries wait in a queue for a free worker, as Go's `database/sql` waits for a free connection.
  - `--queryTimeout`: as upstream, `ModelQuery`, `AuxModelQuery` (and M1.8's `RecordQuery`) give their query a deadline of the timeout (≤ 0 means 30 s) for all lock-retry attempts. On the pool, a query still running at the deadline, or still queued, fails at the deadline with upstream's error, `context deadline exceeded; failed query: <SQL>`. The worker that runs it is terminated and replaced at once, so the pool always has its 4 live workers. A synchronous query (main thread or transaction), and the rows of `rows()`, are checked before the statement runs and before and after each step. It fails with the same error, also when no row was found, but late, because it cannot be interrupted. This is a deliberate difference ([04](04-api-compatibility.md#deliberate-differences)). The checks cost nothing measurable (8.2–8.7 µs per lookup by id and 277–323 µs per 30-row page, before and after, within run-to-run noise).
- **Why:**
  - **Small reads are faster on the main thread.** A lookup by id takes 0.011 ms there and 0.13–0.18 ms through a worker. The hop costs 0.06–0.11 ms per query. Moving every read to the pool would slow the many tiny internal reads (settings, collection cache, auth lookups) and would force an async API onto transactions, which must stay synchronous on the single write connection.
  - **Slow reads must leave the main thread.** An unindexed filter over 1M rows takes about 610 ms. On the main thread, a trivial request waits for every such query in front of it: the event loop lagged 3 s with 8 queued. On the pool, the event loop lag stays under 3 ms, and throughput grows with the pool size (indexed 30-row page on 1M rows: 359 q/s main, 576/1,039/1,288 q/s with 2/4/6 workers).
  - **The pool is the only way to meet the timeout without blocking.** `bun:sqlite` (Bun 1.4.4) has no `sqlite3_interrupt` and no progress handler, and `Worker.terminate()` does not stop a running statement. Calling `sqlite3_interrupt` through `bun:ffi` from a helper thread is not possible either: `Database#handle` is a counter (`handleNumber`), not the `sqlite3*`, and no API returns that pointer; on Linux SQLite is compiled into the bun binary with no exported or symbol-table `sqlite3_*` entries, and `Database.setCustomSQLite` returns false there; only macOS loads the system `libsqlite3.dylib`. Only a worker lets the caller get upstream's error at the deadline while other requests go on.
  - Each worker costs about 12 MiB idle and about 40 MiB with its page caches warm on the 1M-row database. Going from 4 to 6 workers added 24 % page throughput for 80 MiB.
- **Costs and limits:**
  - **A timed-out statement keeps running.** Its terminated thread uses one core and holds its WAL read snapshot until the statement returns. The pool keeps at most 2 × size abandoned threads (8 by default), so at most 3 × size threads in all. At that limit a worker whose query times out is not terminated: the query still fails at its deadline, and the worker takes queries again when its statement returns, or is replaced as soon as an abandoned thread exits. Only then can queries wait behind a timed-out statement.
  - **Reads on the pool see committed data only.** A read sees what the main thread committed before it was issued, because each statement starts its own read transaction in WAL. Uncommitted writes of a running transaction are visible only through that transaction's builders.
  - **Pool connections are read-only.** A statement that writes (for example `INSERT … RETURNING` through `concurrentDB().newQuery(...).allAsync()`) fails there with "attempt to write a readonly database". Upstream's concurrent connections can write.
  - **No early interrupt for synchronous reads.** A synchronous read, and any read in a write transaction, is not interrupted at the deadline as upstream's is: it fails after it finishes, and the event loop is blocked until then. Listed in the deliberate differences.
  - **Extra build entry point.** `bun build --compile` needs `src/db/read-worker.ts` as a second entry point (`package.json` `build`).
- **Considered:**
  - Everything on the main thread: simplest and fastest for small queries, but one slow filter stalls every request, and `--queryTimeout` cannot hold.
  - Every read on the pool: costs the hop on every small read, and makes transactions async.
  - A pool of child processes: killing a process does stop its statement, but it costs a process per connection and IPC serialization. Not needed while a terminated worker's statement is bounded by the data.
  - One worker per request: too much startup overhead.

## D9. Port the filter language, do not redesign it

- **Decision:** port fexpr, `tools/search` and the record field resolver file by file, aiming for the same SQL text.
- **Why:** rules are security boundaries. A "cleaner" implementation that differs in an edge case leaks or hides records. Same SQL text makes differences easy to find.

## D10. Thumbnails without native addons

Provisional until the M0 spike.

- **Decision:** a WebAssembly or pure-TypeScript image library, run in a worker.
- **Why:** native addons (for example `sharp`) complicate `bun build --compile` and cross-platform releases. Thumbnails need decode (JPEG, PNG, GIF, WebP, BMP, TIFF), resize with linear filtering, crop and encode (JPEG, PNG, GIF, BMP, TIFF), nothing more.
- **Considered:** `sharp` (fast, native), `wasm-vips` (complete, larger), `@jsquash/*` codecs plus a resize routine (small), a built-in Bun image API if the pinned Bun version has one. The spike compares binary size, memory on a 50-megapixel image, speed and output quality.

## D11. Upstream's names win over iglo.\* conventions

- **Decision:** keep `pb_data`, `pb_public`, `PB_*` environment variables, upstream flags and command names.
- **Why:** drop-in replacement. Existing systemd units, scripts and backups keep working.

## D12. Accept only v0.40.x data

- **Decision:** refuse to open data that has not run all v0.41.0 system migrations; tell the user to run PocketBase v0.41.0 on it once. v0.40.x data has the same system migrations (the newest, `1778828400_normalize_indexes.go`, shipped in v0.38.1) and opens directly.
- **Why:** upstream's historical upgrade migrations (v0.22 → v0.23 and later) are large, one-off and well tested upstream. Porting them adds risk for no lasting value.

## D13. No Effect, plain TypeScript

- **Decision:** plain async TypeScript with small explicit helpers, as in iglo.email.
- **Why:** the port translates Go code, which maps directly to plain TypeScript. A second paradigm would make the port and its review slower.

## D14. `json` values are raw text

- **Decision:** values of `json` fields, `_params.value` and collection `fields`/`options` JSON are kept as raw text and only re-serialized when changed.
- **Why:** upstream keeps raw JSON (`types.JSONRaw`). `JSON.parse` loses precision above 2^53 and moves integer-like keys first, which would silently change user data and API output.

## D15. Source data is plain v0.40.x

Decided 2026-10-27, after reading a production backup.

- **Decision:** the first data to be moved is treated as standard PocketBase v0.40.x data: the stock binary, no `pb_hooks`, no custom Go build, files on local storage, backups uploaded to S3.
- **Checked in the backup:** all v0.41.0 system migrations are recorded (the newest is `1778828400_normalize_indexes.go`); `s3.enabled` is false and files are under `storage/`; `backups.s3.enabled` is true with a weekly schedule.
- **`pb_migrations` rows:** the data also records 58 `*.js` migrations. Upstream's dashboard wrote them automatically on every schema change (`--automigrate`); nobody wrote them by hand. They are not needed to run: the schema itself lives in `_collections` and the tables. iglo.base keeps the rows. Since D23 it also runs `pb_migrations` and writes migration files on schema changes, as upstream (the original text said it ignored them, per D5).
- **Consequence:** S3 backups are tested early in M5, before S3 file storage.

## D16. Upstream releases after v0.41.0: fixes only, by hand

Decided 2026-10-27.

- **Decision:** review each upstream release by hand. Port security fixes and bug fixes that do not change the data format or the API. Data-format and API changes are not followed in 1.x; following them would be a new compatibility target and a new major version.
- **Why:** the compatibility contracts are fixed to v0.41.0. Following upstream automatically is impossible across languages (D1), and following its format changes would break rollback to v0.41.0.
- **Consequence:** apps that upgrade their SDKs past the v0.41 era may expect newer server behavior. That is checked per app, not followed by default.

## D17. Dashboard branding: iglo.base only

Decided 2026-10-27.

- **Decision:** the dashboard shows only iglo.base: name, logo, page title and footer. No "PocketBase-compatible" label or PocketBase link in the dashboard. Its documentation links point to iglo.base's own documentation ([Open questions](11-open-questions.md) has where it lives).
- **Why:** users see one product. Credit to PocketBase stays where the license requires it (`LICENSE`) and in the README and docs.
- **Consequence:** the documentation pages the dashboard links to must exist by 1.0.

## D18. Release platforms

Decided 2026-10-27.

- **Decision:** release binaries for linux-x64, linux-arm64 and darwin-arm64 only. Amended by [D24](#d24-mvp-targets-linux-x64-only): the MVP ships linux-x64 only; linux-arm64 and darwin-arm64 come after 1.0.
- **Why:** these are the platforms iglo.\* projects ship and deployments use. Windows needs extra work (no `sendmail`, restart by re-exec, file locking during restore) for no current user. Upstream's other targets (Windows, FreeBSD, 32-bit ARM and others) are dropped.

## D19. Drop the `update` command

Decided 2026-10-27.

- **Decision:** iglo.base has no `update` command. `plugins/ghupdate` is not ported.
- **Why:** deployments run iglo.base inside a container image that is rebuilt on every deploy, so a binary that replaces itself does nothing useful. Dropping it removes a network feature and a release-download path.
- **Consequence:** this is the one removal beyond the extension surface. Scripts that call `pocketbase update` change to rebuilding the image with a new iglo.base release.

## D20. Rehearse the cutover on a staging copy of production data

Decided 2026-10-27.

- **Decision:** compatibility is proven by upstream's test suite and the differential suite (D6). In addition, a copy of a real production backup is used locally in M7 to rehearse the move to iglo.base and the rollback to PocketBase v0.41.0. The first instance runs locally.
- **Handling:** the copy is production data. It is kept outside the repository and never committed, quoted or uploaded. Before either server is started on it, the copy's settings are changed so nothing leaves the machine: scheduled backups off, backup S3 upload off, SMTP pointed at Mailpit. Backups are never uploaded to the bucket the production settings name. If an S3 run is needed, the owner provides a separate test bucket; otherwise the local S3 test server is used.
- **Why:** real data catches field and rule combinations no fixture has. Production settings also schedule outbound work (S3 uploads, email) that a local run must not trigger.

## D21. Baseline moved from v0.40.6 to v0.41.0

Decided 2026-10-27, before any code.

- **Decision:** port PocketBase v0.41.0 (`f6baa0c43f379de21cd806de97ad6a2b8ca97b83`, 2026-10-26) instead of v0.40.6. Source: `https://ganigeorgiev.com/git/pocketbase/pocketbase`, tag `v0.41.0`.
- **Checked:** the 11 commits between the tags change no system migration (comments only) and no REST endpoint, field or status code. The fexpr, dbx and ozzo-validation bumps only change their import paths to the new host. What changed for iglo.base:
  - `PB_THUMBS_MAX_SOURCE_PIXELS` defaults to `100 << 20` (104,857,600) instead of `250 << 20`;
  - mail: SMTP no longer sets an empty HTML part; `sendmail` sends `text/plain` when there is no HTML, adds custom headers and a random `Message-ID`;
  - the `serve` banner uses `>` lines instead of tree characters;
  - the dashboard dropped dprint from its build and has small UI fixes.
  The rest (module move, `Event.Extra`, `ServeEvent.StartBannerFunc`, goja and JS VM types) belongs to the extension surface and is not ported.
- **Why:** it is the current upstream release, so the port starts current at no format cost. Data written by v0.40.x opens unchanged, and rollback works to v0.41.0 or v0.40.x.

## D22. Requests are normalized by `Bun.serve`

Decided by agents on 2026-10-27, for owner review (M0.3, [PR #3](https://github.com/iglo-tech/iglo.base/pull/3)).

- **Context:** `Bun.serve` hands the handler a parsed `Request`, not the raw request line and header list. Three things are already normalized by then, and none can be recovered:
  - `.` and `..` path segments, including percent-encoded `%2e%2e`, are resolved. Upstream's Go `ServeMux` answers such paths with a `307` redirect to the cleaned path, and does not treat `%2e%2e` as a dot segment (`/x/%2e%2e/api/health` is a 404 upstream).
  - `\` in the path becomes `/` (WHATWG URL parsing). Upstream treats it as an ordinary character, so `/api\health` is a 404 `File not found.` upstream.
  - Repeated request header lines are joined into one value with `", "`. Upstream's request info (`@request.headers.*` in rules) takes the first line only.
- **Decision:** keep `Bun.serve` (AGENTS.md stack) and accept these differences: iglo.base answers the normalized path, and sees a repeated header as the joined value. Recorded in [API compatibility](04-api-compatibility.md#deliberate-differences) and checked in `test/differential/router.test.ts` where HTTP can observe them.
- **Why:** the alternative, serving through Bun's `node:http` to see the raw request, changes the HTTP stack for every request to match inputs that SDKs and browsers do not send (they normalize URLs and do not repeat these headers). The normalized path still goes through the same route matching, rules and auth, so no check is skipped. A joined header value grants nothing a client could not already send as a single header. `pb_public` file serving (M5.7) must stay inside its root either way.
- **For later tasks:** M5.7 (trusted proxy `RealIP`) must decide how a joined value of a single-address header such as `X-Real-IP` is read, and record it here.
- **Revisit:** if a later `Bun.serve` exposes the raw request target and header lines, match upstream and remove the rows.

## D23. JavaScript migrations are supported

Decided by the owner on 2026-10-28.

- **Decision:** support upstream's JavaScript migrations: `pb_migrations/*.js` applied at startup and recorded in `_migrations`, the `migrate` command (`up`, `down`, `create`, `collections`, `history-sync`), `--migrationsDir` and `--automigrate`, with the globals upstream gives migration files ([Scope](01-scope.md#kept-javascript-migrations)). `pb_hooks` stays removed (D5).
- **Why:** the owner asked for it: only `pb_hooks` was meant to go. Existing deployments keep their migration workflow, and the 58 recorded `*.js` migrations in the source data (D15) stay meaningful.
- **How:** migration files are JavaScript modules run by Bun itself, so no JS VM is embedded. The globals are thin bindings over the internal modules (collections, records, fields, db, security), which stay internal; the bindings are the only surface, and only migration files see them.
- **Consequence:** a new task (M3.7) ports `plugins/migratecmd` and the migration bindings from `plugins/jsvm`. Until it lands, iglo.base keeps the current behavior (it warns about and ignores `pb_migrations`, and rejects `migrate`, `--migrationsDir` and `--automigrate`).

## D24. MVP targets Linux x64 only

Decided by the owner on 2026-10-28.

- **Decision:** the MVP (1.0) is built, tested and released for linux-x64 only. CI runs one Linux x64 job (`bun run check` and `bun run test:reference`); the macOS job is removed. macOS (darwin-arm64) and linux-arm64 builds, the bundled SQLite for macOS (`Database.setCustomSQLite`) and macOS CI move to after 1.0 (task P.2).
- **Why:** the owner wants a working MVP for x86 Linux first, with a lean CI, and no time spent on other platforms until then.
- **Consequence:** workers, fixers and the council do not investigate or fix macOS-only behavior before 1.0. Code that already handles macOS (for example `legacy_alter_table=OFF`, read-only WAL fixtures) stays. Amends D18.


## D25. One cross-lab reviewer, local verification only

Decided by the owner on 2026-10-29.

- **Decision:** each PR is reviewed by one reviewer from another lab than the lead: GPT-6.1 Sol at xhigh reasoning. The council is the lead and that reviewer: a PR merges when both agree, that is, the reviewer approves the head, or the lead and the reviewer agree that every remaining finding is out of scope (logged in the hardening backlog in `docs/status.md`). No Claude agent reviews Claude work. Verification is local: the worker, fixer and reviewer run `bun run check` and `bun run test:reference` on this host. CI is not a merge gate and runs only on demand (`workflow_dispatch`).
- **Why:** the Claude reviewer approved almost every head (about 38 approvals and 13 change requests over PRs #1–#28) while Sol raised most findings, so a second Claude review mostly re-checked Claude's own work. CI repeated the local runs on the same single environment and only added waiting.
- **Consequence:** replaces the two-member council in the [work plan](12-work-plan.md) and the [runbook](../chief-of-staff.md). Amends D24 (CI is no longer run on every push).

## D26. Compatible results, not ported implementations

Decided by the owner on 2026-10-29.

- **Decision:** the API contract is about results for the requests real clients send (the SDKs, the dashboard, browsers, ordinary HTTP tools): the same status codes, bodies, error texts, headers and stored data as upstream. It is not a requirement to port upstream's or Go's implementation. Code ports upstream logic where the result depends on it (rules and filters, field validation and normalization, token formats, bcrypt, Go regexp semantics for stored patterns, the data format) and uses Bun and Web platform APIs elsewhere when they give the same results for those requests.
- **Exotic input:** malformed or hand-crafted transport input that no normal client produces (unusual multipart encodings, chunked bodies placed at the exact body limit, escapes split at internal read-buffer boundaries, integer arguments at int64 overflow, and similar) must be handled safely: no crash, no corrupted or partial data, no security or rule bypass, bounded memory. Its exact status code and error text may differ from upstream. Such differences are not review blockers; the reviewer reports them as backlog items, and they are listed in the hardening backlog in `docs/status.md`.
- **Never relaxed:** the data contract (anything written to or read from `pb_data`), access rules and auth, and the results of requests a normal client sends.
- **Consequence:** reviewers must name the realistic client and request behind a blocking finding. Existing ports of Go standard library code stay unless they cost performance; M7.1 may replace them with native APIs (for example multipart parsing with Bun's `formData()` plus part-count and size checks) while the differential suite stays green. A class row is added to the deliberate differences in [API compatibility](04-api-compatibility.md).
