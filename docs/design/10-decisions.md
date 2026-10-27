# Decisions

Short records. Each one says what was decided, why, and what was considered instead. Change a decision by editing its record and noting the date.

## D1. Port of PocketBase v0.40.6, not a tracking fork

Decided 2026-10-27.

- **Decision:** port PocketBase v0.40.6 to TypeScript and own the result. Do not track upstream automatically; review later upstream releases by hand ([Open questions](11-open-questions.md)).
- **Why:** the stack differs (Go upstream, Bun here), so a tracking fork is impossible anyway. v0.40.6 is a natural baseline: it is the last release on GitHub before upstream moved hosts, and its data format is stable within v0.40.x.
- **Considered:**
  - a Go fork with the extension code deleted, which keeps a second language and toolchain;
  - a clean-room reimplementation from the docs, which would miss the undocumented behavior that compatibility depends on.

## D2. MIT

- **Decision:** license iglo.base under MIT and keep PocketBase's copyright notice next to iglo.base's.
- **Why:** PocketBase is MIT; keeping the same license is the simplest correct option. fexpr (BSD-3-Clause) and Shablon (0BSD) keep their notices where they are vendored.

## D3. Bun, TypeScript, one executable

- **Decision:** Bun ≥ 1.4 and TypeScript, shipped as one compiled executable with the dashboard embedded. No Docker image.
- **Why:** the same stack and release model as iglo.monitor and iglo.email. Bun's server, SQLite, S3 client, password hashing and bundler cover most of what upstream needs third-party Go modules for. PocketBase is also one executable, so the deployment model does not change.

## D4. PocketBase's data format, unchanged and two-way

- **Decision:** read and write `pb_data` exactly as PocketBase v0.40.6 does. No iglo-specific tables, columns, `_params` rows or `_migrations` rows.
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

- **Decision:** API behavior is defined by what upstream v0.40.6 does, checked by the differential suite, not by the docs or by reading code.
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

- **Decision:** refuse to open data that has not run all v0.40.6 system migrations; tell the user to run PocketBase v0.40.6 on it once.
- **Why:** upstream's historical upgrade migrations (v0.22 → v0.23 and later) are large, one-off and well tested upstream. Porting them adds risk for no lasting value.

## D13. No Effect, plain TypeScript

- **Decision:** plain async TypeScript with small explicit helpers, as in iglo.email.
- **Why:** the port translates Go code, which maps directly to plain TypeScript. A second paradigm would make the port and its review slower.

## D14. `json` values are raw text

- **Decision:** values of `json` fields, `_params.value` and collection `fields`/`options` JSON are kept as raw text and only re-serialized when changed.
- **Why:** upstream keeps raw JSON (`types.JSONRaw`). `JSON.parse` loses precision above 2^53 and moves integer-like keys first, which would silently change user data and API output.
