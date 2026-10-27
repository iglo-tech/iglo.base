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

## D6. Upstream's binary is the specification

- **Decision:** API behavior is defined by what upstream v0.41.0 does, checked by the differential suite, not by the docs or by reading code.
- **Why:** "100% compatible" can only be shown by comparison. Upstream's ~720 API scenarios give a large head start.

## D7. Reuse upstream's dashboard

- **Decision:** vendor upstream's `ui/` with a small, listed patch set.
- **Why:** it is a pure API client, so it works unchanged against a compatible server, and it is about 35,000 lines that would otherwise be rewritten for no product gain.
- **Considered:** rewriting it in the style of iglo.email (server-rendered TSX) or iglo.monitor (Vue). Rejected: large cost, and it would lose the dashboard as a compatibility check.

## D8. SQLite access: main-thread writer, worker read pool

Provisional until the M0 spike.

- **Decision:** one write connection per database file on the main thread; reads that may be slow (lists, filters, expands, logs) run on a small pool of Bun workers with read-only connections. `--queryTimeout` terminates and replaces a worker.
- **Why:** `bun:sqlite` is synchronous. Upstream relies on many concurrent connections and context-cancelled queries; a single main-thread connection would let one slow filter block all requests, and could not honor `--queryTimeout`.
- **Considered:** everything on the main thread (simplest, fastest for small queries, no timeout); one worker per request (too much overhead). The spike measures both the pool and the main-thread option on the fixture and a 1-million-record dataset.

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
- **`pb_migrations` rows:** the data also records 58 `*.js` migrations. Upstream's dashboard wrote them automatically on every schema change (`--automigrate`); nobody wrote them by hand. They are not needed to run: the schema itself lives in `_collections` and the tables. iglo.base keeps the rows, ignores them ([Data compatibility](03-data-compatibility.md#migrations)) and does not write migration files when the schema changes (D5).
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

- **Decision:** release binaries for linux-x64, linux-arm64 and darwin-arm64 only.
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

## D22. Request paths are normalized by `Bun.serve`

Decided by agents on 2026-10-27, for owner review (M0.3, [PR #3](https://github.com/iglo-tech/iglo.base/pull/3)).

- **Context:** `Bun.serve` resolves `.` and `..` path segments, including percent-encoded `%2e%2e`, in `request.url` before the handler runs. Upstream's Go `ServeMux` answers such paths with a `307` redirect to the cleaned path, and does not treat `%2e%2e` as a dot segment (so `/x/%2e%2e/api/health` is a 404 upstream).
- **Decision:** keep `Bun.serve` (AGENTS.md stack) and accept the difference: iglo.base answers the resolved path directly. Recorded in [API compatibility](04-api-compatibility.md#deliberate-differences) and checked both ways in `test/differential/router.test.ts`.
- **Why:** the alternative, serving through Bun's `node:http` to see the raw request target, changes the HTTP stack for every request to match paths that SDKs and browsers never send (they normalize URLs themselves). The resolved path still goes through the same route matching, rules and auth, so no check is skipped; `pb_public` file serving (M5.7) already has to stay inside its root either way.
- **Revisit:** if a later `Bun.serve` exposes the raw request target, match upstream and remove the row.
