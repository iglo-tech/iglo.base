# Architecture

## Platform

- **Runtime:** Bun ≥ 1.4, TypeScript, native ESM.
- **HTTP:** `Bun.serve` with a small router that matches upstream's route patterns (`/api/collections/{collection}/records/{id}`). No Express or other framework.
- **Database:** `bun:sqlite`, the two upstream files `pb_data/data.db` and `pb_data/auxiliary.db`, with upstream's pragmas ([Data compatibility](03-data-compatibility.md#sqlite-settings)).
- **Distribution:** one executable from `bun build --compile`, with the admin dashboard, system migrations and email templates embedded. linux-x64, linux-arm64 and darwin-arm64.
- **No external services** apart from the optional SMTP server, S3 bucket, OAuth2 providers and Let's Encrypt.

## Shared ground with other iglo.\* projects

These conventions are the same as [iglo.monitor](https://github.com/iglo-tech/iglo.monitor) and [iglo.email](https://github.com/iglo-tech/iglo.email), so tooling and agent rules can be shared:

- Bun as runtime and package manager (`bun.lock`), with no npm or Node fallback paths. (The vendored dashboard keeps its own Vite build, run with Bun.)
- SQLite as the only database.
- One compiled executable as the only release artifact. Releases are built on `v*` tags.
- `oxlint` and `oxfmt`, plus a pre-commit format hook.
- Renovate for dependency updates.
- `@/` path aliases and no relative imports. Import from the module that owns a symbol, with no barrel files.
- No process-global state. Modules receive the database, settings and clock they use.

Where these conventions conflict with PocketBase compatibility (directory names, flag names, environment variables), compatibility wins. See [Decisions](10-decisions.md) D11.

## Process model

One process. Upstream runs everything in goroutines; iglo.base runs it on Bun's event loop plus a few workers.

| Part | Runs on | Notes |
|---|---|---|
| HTTP and realtime | main thread | `Bun.serve`. SSE streams are `ReadableStream`s with the per-request timeout disabled |
| Database writes and synchronous reads | main thread, one connection per database file | All writes, write transactions (and the reads in them), and small internal reads, as upstream's "nonconcurrent" DB |
| Database reads that may be slow | a pool of read workers (default 4), each with read-only connections to both files | The concurrent builders' async resolvers outside a transaction: lists, views, counts, expands, logs, rule checks outside write transactions. A query past `--queryTimeout` fails at the deadline and its worker is replaced; the pool always keeps its live workers and at most 2 × size abandoned threads ([D8](10-decisions.md#d8-sqlite-access-main-thread-connection-read-worker-pool-for-timed-reads)) |
| Thumbnails | worker pool | Bounded by `PB_THUMBS_MAX_WORKERS`, `PB_THUMBS_MAX_WAIT` and `PB_THUMBS_MAX_SOURCE_PIXELS`, as upstream |
| Cron jobs | main thread timers | Built-in jobs only ([Files, mail, backups, jobs and logs](07-files-mail-backups-jobs.md#jobs)) |
| Request log writer | main thread, batched | Writes to `auxiliary.db` in batches, as upstream's buffered logger |

`bun:sqlite` is synchronous and cannot interrupt a statement: it has no `sqlite3_interrupt` or progress handler, it exposes no `sqlite3*` pointer for `bun:ffi` (and on Linux the embedded SQLite exports no symbols), and terminating a worker does not stop a running statement. Upstream uses up to 120 concurrent read connections to `data.db`, 20 to `auxiliary.db` and a 30-second default query timeout. The M0.6 spike ([report](../perf/M0.6-read-path.md)) measured a worker hop of about 0.1 ms. That is ten times a main-thread lookup by id, but a long filter on a large table run on the main thread stalls every request. So the db API stays synchronous on the main-thread connection, and request-path reads that may be slow use the async resolvers, which run on the read pool. At `--queryTimeout`, a pooled query fails with upstream's error and its worker is replaced. The terminated thread finishes its statement in the background; at most 2 × size such threads run at once. A synchronous query that runs past the timeout fails after it returns, which is a [deliberate difference](04-api-compatibility.md#deliberate-differences).

Graceful shutdown: on SIGTERM/SIGINT, stop accepting requests, close realtime streams, flush the log buffer, run `PRAGMA wal_checkpoint(TRUNCATE)` on both files and close connections, as upstream's terminate path does.

## Performance bar

Measured against upstream PocketBase v0.41.0 on the same machine and data:

- records list, view and create p50/p95 latency within 1.5× of upstream at 50 concurrent clients;
- 1,000 open realtime connections with fan-out of record changes;
- startup time and idle RSS recorded and published.

Measurements live in `docs/perf/`. Changes to the database layer, filters, realtime or file handling include before/after numbers (same rule as iglo.monitor).

## Module layout (initial)

Names follow upstream packages so each file can be reviewed side by side with its Go source.

```text
src/
  app/                app context passed to every module (data dir, flags, clock, error logger) and the request event (upstream core/app.go, core/event_request.go)
  cli/                serve, superuser; flag parsing (upstream cmd/, pocketbase.go)
  server/             Bun.serve setup, router (upstream tools/router on Go's ServeMux), request event, API errors, request body helpers, static pb_public, HTTPS and autocert
  middlewares/        CORS, gzip, body limit, rate limit, activity log, panic recovery, superuser IP check
  db/                 connections and pragmas, the read worker pool and query deadlines (D8), transactions, busy retry, tables, model save/delete (upstream core/db*.go); db/dbx/ is the ported pocketbase/dbx subset (SQLite and standard builders)
  migrations/         system migrations with upstream file names (upstream migrations/)
  collections/        model, options, validation, table sync, view collections, import, scaffolds
  fields/             the 14 field types (upstream core/field*.go): field.ts is the Field contract, the optional interfaces (setters, getters, driver values, interceptors) and the narrow record, collection and app interfaces the fields call, which collections/ and records/ implement; fields.ts is the fixed type → constructor table; one file per type with its column type, value normalization, value and settings validation and stored JSON (the simple types from M1.4; file, relation and password with M1.5)
  records/            CRUD, expand, fields picker, cascade, record response shaping
  search/             fexpr tokenizer and parser, filter-to-SQL, sort, pagination (upstream tools/search, fexpr)
  resolver/           record field resolver for rules and filters (upstream core/record_field_resolver*)
  auth/               tokens, passwords, OTP, MFA, auth origins, alerts, impersonation
  oauth2/             provider implementations (upstream tools/auth)
  realtime/           SSE broker, subscriptions, permission-aware broadcast
  batch/              batch request handling
  files/              local and S3 filesystems, uploads, thumbnails, file tokens
  mail/               SMTP and sendmail transports, templates, placeholders
  settings/           model, defaults, validation, encryption
  backups/            create, restore, upload, scheduled backups
  cron/               scheduler and built-in jobs
  logs/               logger, buffered writer, queries, stats
  apis/               HTTP handlers, one file per upstream apis/*.go file
  validation/         the ozzo-validation v4.4.1 subset upstream uses (Error, Errors, Validate, ValidateStruct, the rules); is/ holds the is rules upstream uses (Domain, EmailFormat, HexColor, Host, JSON, URL) with the govalidator functions behind them and the Go net/url and net/netip parsing they need
  validators/         upstream core/validators without file.go: UniqueId, NormalizeUniqueIndexError, Equal, IsRegex, IPOrSubnet, JoinValidationErrors
  tools/              upstream's small tools/ packages, one directory each: types (DateTime with nanoseconds, JSONRaw, JSONArray, JSONMap, GeoPoint, and the Go JSON, time.Parse and spf13/cast behavior they inherit), security (hashes, AES-GCM, HS256 JWT with golang-jwt's rules, random strings, RandomStringByRegex), list, inflector, store; regexp (Go's regexp: the regexp/syntax parser with Go's trees and error texts, Simplify, the compiler to Go's Prog, and Go's NFA and one-pass matchers, so patterns match as upstream's do, in linear time) and unicode (the parts of Go's unicode and unicode/utf8 it uses, with tables generated from Go's tables.go); crypto (golang.org/x/crypto's bcrypt and blowfish, for the stored hashes `Bun.password` cannot verify); mimetype (gabriel-vasile/mimetype v1.4.15, the MIME sniffing upstream uses for upload `mimeTypes` checks, stored and served content types, mail attachments and file name extensions: the whole detection tree with its 4096-byte read limit, and the Go `mime.ParseMediaType` its comparisons use)
ui/                   vendored upstream dashboard (see 08-admin-ui.md)
test/
  differential/       runs the same scenarios against upstream and iglo.base
  scenarios/          ported upstream API scenarios
  fixtures/           upstream tests/data pb_data and others
```

Each module owns its tables. Other modules call its functions; they do not query its tables directly. There is no event bus: where upstream fires a hook that its own core listens to (for example, realtime broadcasting after a record save), iglo.base calls the module directly.

## Configuration

Identical to upstream, so service files and scripts keep working:

- **Flags:** `--dir` (default `pb_data` next to the executable), `--dev`, `--encryptionEnv`, `--queryTimeout`, and for `serve`: `--http`, `--https`, `--origins`, `--publicDir`, `--indexFallback`, plus positional domains for automatic HTTPS.
- **Environment:** the `PB_*` variables upstream reads (`PB_THUMBS_MAX_SOURCE_PIXELS`, `PB_THUMBS_MAX_WORKERS`, `PB_THUMBS_MAX_WAIT`, `PB_FILES_DELETE_MAX_WORKERS`, `PB_ID_TOKEN_LEEWAY`) and the variable named by `--encryptionEnv`.
- **Everything else** lives in `_params` settings and is edited in the dashboard, as upstream.
- Removed extension flags fail fast with a message ([Scope](01-scope.md#removed-the-extension-surface)). If `pb_hooks` or `pb_migrations` directories exist next to `pb_data`, `serve` logs one warning that they are ignored.

## Data directory

Exactly upstream's layout ([Data compatibility](03-data-compatibility.md#the-pb_data-directory)):

```text
pb_data/
  data.db              (+ -wal, -shm)
  auxiliary.db         (+ -wal, -shm)   logs
  storage/             local files, one directory per collection id, then record id
  backups/             local backups (zip)
  .autocert_cache/     Let's Encrypt certificates
  .pb_temp_to_delete/  temporary files, removed at startup
```

## Dependencies

Small and justified. v1 runtime dependencies:

| Package | Why |
|---|---|
| `nodemailer` | SMTP with STARTTLS, auth methods, MIME and attachments, plus a `sendmail` transport. Same choice as iglo.email |
| `acme-client` | Let's Encrypt for `serve example.com`. Bun has TLS but no ACME client |
| image library (chosen in M0) | Thumbnails for JPEG, PNG, GIF and WebP input. Must work inside a compiled executable without native addons, so WebAssembly-based (D10) |

Built-in Bun or Web APIs cover the rest: bcrypt (`Bun.password`, with the ported Go bcrypt in tools/crypto only for stored hashes it cannot verify), HMAC-SHA256 JWTs and AES-GCM (Web Crypto), S3 (`Bun.S3Client`), gzip (`Bun.gzipSync` and streams), zip for backups (in-house, store or deflate via `Bun.deflateSync`, or a small dependency if justified), MIME sniffing (upstream's `gabriel-vasile/mimetype` v1.4.15 is ported whole in tools/mimetype, because a `mimeTypes` list may name any type and the accept or reject result depends on the whole detection tree), cron expressions (ported, about 500 lines upstream).

The admin dashboard has its own build-time dependencies (Vite, Leaflet, TinyMCE, the PocketBase JS SDK), kept in `ui/` as upstream has them.
