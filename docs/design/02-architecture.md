# Architecture

## Platform

- **Runtime:** Bun ≥ 1.4, TypeScript, native ESM.
- **HTTP:** `Bun.serve` with a small router that matches upstream's route patterns (`/api/collections/{collection}/records/{id}`). No Express or other framework.
- **Database:** `bun:sqlite`, the two upstream files `pb_data/data.db` and `pb_data/auxiliary.db`, with upstream's pragmas ([Data compatibility](03-data-compatibility.md#sqlite-settings)).
- **Distribution:** one executable from `bun build --compile`, with the admin dashboard, system migrations and email templates embedded. linux-x64 for the MVP; linux-arm64 and darwin-arm64 after 1.0 (D24).
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

`bun:sqlite` is synchronous and cannot interrupt a statement: it has no `sqlite3_interrupt` or progress handler, it exposes no `sqlite3*` pointer for `bun:ffi` (and on Linux the embedded SQLite exports no symbols), and terminating a worker does not stop a running statement. Upstream uses up to 120 concurrent read connections to `data.db`, 20 to `auxiliary.db` and a 30-second default query timeout. The M0.6 spike ([report](../perf/M0.6-read-path.md)) measured a worker hop of about 0.1 ms. That is ten times a main-thread lookup by id, but a long filter on a large table run on the main thread stalls every request. So the db API stays synchronous on the main-thread connection, and request-path reads that may be slow use the async resolvers, which run on the read pool. At `--queryTimeout`, a pooled query fails with upstream's error and its worker is replaced. The terminated thread finishes its statement in the background; at most 2 × size such threads run at once. A synchronous query that runs past the timeout fails after it returns, which is a [deliberate difference](04-api-compatibility.md#deliberate-differences). Upstream code that reads through the root app while a transaction runs (its concurrent pool never sees the transaction's writes) uses `Databases.committedReads()`: a separate read-only main-thread connection to `data.db`, opened on first use, so those reads stay synchronous and see only committed data.

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
  app/                app context passed to every module (data dir, flags, clock, error logger, the databases and the runtime store holding the collections cache, so the app is a CollectionsApp) and the request event, whose auth is a Record (upstream core/app.go, core/event_request.go); bootstrap.ts is Bootstrap and ClearBootstrap (upstream core/base.go): create pb_data, open data.db and auxiliary.db with the read worker pool, the system migrations check, the collections cache load and the `.pb_temp_to_delete` cleanup (M1.2)
  cli/                serve, superuser; flag parsing (upstream cmd/, pocketbase.go); serve bootstraps the app before it listens and clears the bootstrap on shutdown
  server/             Bun.serve setup, router (upstream tools/router on Go's ServeMux), request event, API errors, request body helpers, static pb_public, HTTPS and autocert
  middlewares/        CORS, gzip, body limit, rate limit, activity log, panic recovery, superuser IP check, auth loading and guards: load-auth-token.ts is loadAuthToken (the Authorization header with or without a case-insensitive "Bearer " prefix, auth tokens only, through FindAuthRecordByToken on e.app), require-auth.ts is RequireGuestOnly, RequireAuth, RequireSuperuserAuth, RequireSuperuserOrOwnerAuth and RequireSameCollectionContextAuth (the path collection looked up in e.app) with their ids (M2.3)
  db/                 connections and pragmas, the read worker pool and query deadlines (D8), query cancellation with a cause (a cancelled dbx context), transactions, busy retry, tables, model save/delete (upstream core/db*.go); db/dbx/ is the ported pocketbase/dbx subset (SQLite and standard builders)
  migrations/         system migrations with upstream file names (upstream migrations/, core/migrations_*.go): system-migrations.ts is the system list and the open-time check (fresh install, refusal of older data, the newer-migrations warning, the `_logs` reapply); baseline.ts builds the v0.41.0 end state of a fresh install with upstream's DDL and the collection save path; migrations-runner.ts is the `_migrations` table part of the runner (M1.2; user JS migrations and the `migrate` command extend it in M3.7)
  collections/        model, options, validation, table sync, view collections, import, scaffolds (upstream core/collection*.go, core/fields_list.go): collection-model.ts is the Collection model with its factories, default system fields and id, JSON, dbx scan and DBExport, and implements fields/'s collection interface; the base, view and auth options and the default auth email templates have one file each (the options are Collection properties, as Go's promoted fields); fields-list.ts is FieldsList; go-json-struct.ts decodes JSON into the nested option structs with json v2's rules; collection-validate.ts is the collection validator (onCollectionValidate), with the options' Validate methods in their option files and the rule check (M2.2) as a small function that task completes; collection-query.ts is the find, cache (the app store), references and unique-name queries, normalizeViewQueryId and resaveViewsWithChangedFields over a narrow CollectionsApp (databases, store, clock, error logger), with runInAppTransaction, and gives fields/ its FieldApp; collection-save.ts is app.Save, SaveNoValidate and Delete for collections (onCollectionSave, the validator, onCollectionSaveExecute and onCollectionDeleteExecute called in upstream's hook order, the cache reloads, and the bootstrap cache load for serve), writing the `_collections` row through db/ with DBExport's values converted to their driver values; collection-record-table-sync.ts is SyncRecordTableSchema with the single/multiple value conversion and the index sync; view.ts is SaveView, CreateViewFields, DryRunView and the view query parser; collection-import.ts is ImportCollections; driver-error.ts formats bun:sqlite errors as upstream's Go SQLite driver does, for the error texts the save path returns; go-strings.ts is Go's strings.ToLower, EqualFold, TrimSpace and Trim (the model, options and FieldsList from M1.6; validation and queries with M1.6a; save, delete, table sync, views and import with M1.7)
  fields/             the 14 field types (upstream core/field*.go): field.ts is the Field contract, the optional interfaces (setters, getters, driver values, interceptors) and the narrow record, collection and app interfaces the fields call, which collections/ and records/ implement; fields.ts is the fixed type → constructor table; one file per type with its column type, value normalization, value and settings validation and stored JSON (the simple types from M1.4; relation and password with M1.5; file with M1.5b, whose upload and delete side comes with M3.2)
  records/            CRUD, expand, fields picker, cascade, record response shaping (upstream core/record*.go): record-model.ts is the Record model (newRecord, newRecordFromNullStringMap with nullStringMapFromRow, Original/Fresh/Clone, expand getters and setters, Set/Get/Load and the typed getters, file getters, DBExport with upstream's typed values, Hide/Unhide, PublicExport and MarshalJSON, ReplaceModifiers) and implements fields/'s record interface; record-model-auth.ts and record-model-superusers.ts hold the auth accessors and IsSuperuser, which the Record exposes as methods, and record-model-superusers.ts the superusers' save and delete checks; cast.ts is spf13/cast's ToInt64 and ToStringMap for the getters; record-query.ts is RecordQuery (execLockRetry with the query timeout, rows read withExactIntegers and hydrated into Records through the One/All hooks; a missing collection fails the query as a cancelled context) and the plain finders by id, ids, data, expressions, count, auth email and auth token (FindAuthRecordByToken, which checks exp, nbf and iat with the app clock), on a narrow RecordsApp (the collections' CollectionsApp); record-tokens.ts is the token types and claim names and the auth, static auth, verification, password reset, email change and file tokens (HS256, signed with the record's tokenKey + the collection's secret for the type, exp from the clock passed in) (M2.3); record-query-filter.ts is FindRecordsByFilter, FindFirstRecordByFilter and CanAccessRecord with the record field resolver, each also as an async form that reads through the read pool; record-save.ts is Validate, Save, SaveNoValidate and Delete for records: upstream's record hook chain as direct calls in its priority order (field interceptors, validation, the auth token key refresh and cross-collection id check, cascade delete), written as generators that run synchronously until a field interceptor returns a promise, so the parts inside a write transaction stay synchronous; record-auth-refs.ts holds the record handlers of the _externalAuths, _mfas, _otps and _authOrigins collections (ref checks and the cleanups on delete, password, token key and verified changes) (the model from M1.8a; queries with M1.8b; save, validate and delete with M1.8c; record-query-expand.ts is ExpandRecord and ExpandRecords with back-relations and the depth limit, read through the async resolvers (M2.4))
  search/             the filter language and list queries (upstream tools/search and fexpr v0.7.0, M2.1): fexpr/ is fexpr's scanner and parser (Go's rune and byte semantics, its error texts); filter.ts is FilterData's BuildExpr (placeholder replacement, the null fallback rules, `~` escaping, the multi-match many-vs-one and many-vs-many expressions), with the clock for the date macros and an optional parse cache (ParsedFilterCache) passed in, never package state; sort.ts, identifier-macros.ts, token-functions.ts (geoDistance, strftime; a read-only table), multi-match-subquery.ts and simple-field-resolver.ts (ResolverResult, the FieldResolver contract the record resolver implements in M2.2) follow their upstream files; provider.ts is the Provider (page, perPage, sort, filter and skipTotal parsing with strconv's errors, the limits, the count and page queries run together through dbx's async reads)
  resolver/           record field resolver for rules and filters (upstream core/record_field_resolver*.go, M2.2): record-field-resolver.ts is RecordFieldResolver (the FieldResolver of search/: the static @request.* values, collection loading through the cached collection finders, the joins and list-rule joins it adds in UpdateQuery with DISTINCT, the modifiers), record-field-resolver-runner.ts resolves one field path (collection fields, relations, back-relations, @collection.*, @request.auth/body relations, the multi-match subqueries, hidden fields and the email visibility check), record-field-resolver-replace-expr.ts is the :changed placeholder expression; the date macros of the filters it builds itself read the app clock
  auth/               passwords, OTP, MFA, auth origins, alerts, impersonation (the record tokens are in records/record-tokens.ts, as upstream core/record_tokens.go)
  oauth2/             provider implementations (upstream tools/auth); until M4.5, provider-names.ts holds the names upstream registers, which collection validation checks (M1.6a)
  realtime/           SSE broker, subscriptions, permission-aware broadcast
  batch/              batch request handling
  files/              local and S3 filesystems, uploads, thumbnails, file tokens
  mail/               SMTP and sendmail transports, templates, placeholders
  settings/           model, defaults, validation, encryption
  backups/            create, restore, upload, scheduled backups
  cron/               scheduler and built-in jobs
  logs/               logger, buffered writer, queries, stats
  apis/               HTTP handlers, one file per upstream apis/*.go file: record-crud.ts is the records list and view (M2.4; create, update and delete with M3.1), record-helpers.ts the record enrich (email visibility, hidden fields, expand with the view rules), the superuser-only filter check and firstApiError
  validation/         the ozzo-validation v4.4.1 subset upstream uses (Error, Errors, Validate, ValidateStruct, the rules); is/ holds the is rules upstream uses (Domain, EmailFormat, HexColor, Host, JSON, URL) with the govalidator functions behind them and the Go net/url and net/netip parsing they need
  validators/         upstream core/validators: UniqueId, NormalizeUniqueIndexError, Equal, IsRegex, IPOrSubnet, JoinValidationErrors, UploadedFileSize, UploadedFileMimeType
  tools/              upstream's small tools/ packages, one directory each: types (DateTime with nanoseconds, JSONRaw, JSONArray, JSONMap, GeoPoint, and the Go JSON, time.Parse and spf13/cast behavior they inherit), security (hashes, AES-GCM, HS256 JWT with golang-jwt's rules, random strings, RandomStringByRegex), list, inflector, store; regexp (Go's regexp: the regexp/syntax parser with Go's trees and error texts, Simplify, the compiler to Go's Prog, and Go's NFA and one-pass matchers, so patterns match as upstream's do, in linear time) and unicode (the parts of Go's unicode and unicode/utf8 it uses, with tables generated from Go's tables.go); crypto (golang.org/x/crypto's bcrypt and blowfish, for the stored hashes `Bun.password` cannot verify); mimetype (gabriel-vasile/mimetype v1.4.15, the MIME sniffing upstream uses for upload `mimeTypes` checks, stored and served content types, mail attachments and file name extensions: the whole detection tree with its 4096-byte read limit, and the Go `mime.ParseMediaType` its comparisons use); filesystem (the `File` model of an upload: a Blob reader, its size and its original and generated names, with upstream's name normalization; `ThumbSizeRegex`. The storage itself, local and S3, is in files/); tokenizer (splits text on separators outside quotes and parentheses); dbutils (CREATE INDEX parsing and building, the unique index lookup, the JSON_EACH, JSON_ARRAY_LENGTH and JSON_EXTRACT expressions, AliasOrIdentifier); picker (the `fields` response picker and its `:excerpt` modifier, wired into the router event's JSON); html (golang.org/x/net/html v0.61.0: the HTML5 tokenizer and tree builder the excerpt modifier parses with)
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
- Removed extension flags fail fast with a message ([Scope](01-scope.md#removed-the-extension-surface)). If a `pb_hooks` directory exists next to `pb_data`, `serve` logs one warning that it is ignored. `pb_migrations` is applied at startup (D23, task M3.7).

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
