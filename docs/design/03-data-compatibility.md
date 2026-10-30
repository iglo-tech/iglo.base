# Data compatibility

The goal: stop PocketBase, start iglo.base on the same `pb_data`, and have everything work. Stop iglo.base, start PocketBase v0.41.0 on the same `pb_data`, and have everything work. No import, export, conversion or migration step in either direction.

This is a contract, not a best effort. It decides most storage questions in this project: when in doubt, do what upstream does, byte for byte.

## Compatibility target

| | |
|---|---|
| Format version | PocketBase **v0.41.0** (`f6baa0c`, 2026-10-26), the same as v0.40.x |
| Accepted on open | `pb_data` written by PocketBase v0.40.x or v0.41.0 with all system migrations applied |
| Written | the same format; PocketBase v0.41.0 and v0.40.x open it without running anything new |

Older PocketBase data (for example v0.22 or an early v0.3x) is upgraded first by running PocketBase v0.41.0 once on it. iglo.base does not port upstream's historical upgrade migrations (`1717233556_v0.23_migrate*.go` and older). See [Decisions](10-decisions.md) D12. The first data to be moved is already v0.40.x ([D15](10-decisions.md#d15-source-data-is-plain-v040x)).

## The `pb_data` directory

```text
pb_data/
  data.db                       collections, records, system tables, settings
  auxiliary.db                  _logs
  storage/<collectionId>/<recordId>/<filename>
  storage/<collectionId>/<recordId>/<filename>.attrs
  storage/<collectionId>/<recordId>/thumbs_<filename>/<thumbSize>_<filename>
  backups/<name>.zip
  .autocert_cache/
  .pb_temp_to_delete/           removed at startup
```

Other files in `pb_data` are left alone and included in backups, as upstream does. Real deployments have them: `types.d.ts` written by upstream's JS VM plugin, stale `logs.db-wal`/`-shm` files from before v0.23, or files a deploy tool keeps there.

- **File names** keep upstream's sanitized form (`<base>_<10 random chars>.<ext>`), generated the same way.
- **`.attrs` sidecar files** are written for every stored file, as upstream's file blob store does: JSON with `user.cache_control`, `user.content_disposition`, `user.content_encoding`, `user.content_language`, `user.content_type`, `user.metadata` and `md5` (base64). PocketBase reads `content_type` from them when serving files, so they are part of the format. iglo.base writes them byte for byte as upstream v0.41.0's `encoding/json/v2` does: the keys in that order, no spaces and no trailing newline, only `"`, `\` and control characters escaped, `user.metadata` as `{"original-filename":"<the first 255 bytes of the uploaded name>"}` (`{}` without metadata), `md5` as standard base64. A name whose 255-byte cut falls inside a multi-byte character is not valid UTF-8 and fails the upload, as upstream's does. `content_type` is the sniffed type (src/tools/mimetype), formatted as Go's `mime.FormatMediaType`.
- **Writes and deletes** follow upstream's local blob store: a file is written to `<path>.<hex nanoseconds>.tmp` next to its final path and renamed after its `.attrs` is written; nothing else is created in `storage/`. Deleting a record or a collection (with a file field) deletes its directory after the delete is committed, in the background (at most `PB_FILES_DELETE_MAX_WORKERS` at once, default 2000); a save deletes the files it removed from the record, with their `thumbs_<name>/` directories, after the commit, and removes the files it uploaded when the write or the commit fails.
- **Multipart uploads** past 16 MiB of file data per request are written to one temporary file in the OS temp directory (`$TMPDIR/multipart-<n>`), as Go's `ReadForm` does, and removed when the request ends (D27).
- **Thumbnails** use upstream's paths. Existing cached thumbnails are served as they are. New thumbnails may differ in encoded bytes, never in size, crop or format.
- **S3 storage** uses the same keys (`<collectionId>/<recordId>/<filename>`) and object metadata, so a bucket can be shared across a switch.

## SQLite settings

Both files are opened with upstream's pragmas, in upstream's order: `busy_timeout=10000`, `journal_mode=WAL`, `journal_size_limit=200000000`, `synchronous=NORMAL`, `foreign_keys=ON`, `temp_store=MEMORY`, `cache_size=-32000`. Upstream also enables `SQLITE_DBCONFIG_DEFENSIVE` (`_defensive=1`). `bun:sqlite` does not expose it (no `sqlite3_db_config` call, and the setting has no pragma; checked with Bun 1.4.4), so iglo.base cannot set it without a native addon. Instead the SQL console rejects the statements defensive mode blocks (writable `sqlite_schema`, `PRAGMA writable_schema`).

Bun bundles SQLite 3.53.4 (checked with Bun 1.4.4 on Linux), with math and JSON functions, which upstream's filters use (`acos`, `radians`, `json_extract`, `->>`). Every connection explicitly sets `legacy_alter_table=OFF`, matching SQLite’s default and upstream even when macOS system SQLite defaults it to ON. On macOS, `bun:sqlite` uses the system SQLite by default; macOS builds come after 1.0 (D24), and their release build will call `Database.setCustomSQLite` with a bundled library so behavior does not depend on the macOS version (task P.2).

No custom SQL functions or collations are needed: upstream registers none.

Bun's SQLite is built without `SQLITE_ENABLE_STAT4`. Upstream's `PRAGMA optimize` after a collection save creates both `sqlite_stat1` and `sqlite_stat4`; iglo.base's creates only `sqlite_stat1` (with the same rows). So a fresh iglo.base `data.db` has upstream's `sqlite_schema` without the `sqlite_stat4` row. Both are SQLite's own optional statistics tables: upstream creates `sqlite_stat4` again on its next `ANALYZE`, and Bun's SQLite ignores an existing one.

## Schema

### System tables

These are created on a fresh install and checked on open. Their DDL is copied from upstream's migrations, not rewritten, so `sqlite_schema` stays identical.

| Table | File | Notes |
|---|---|---|
| `_migrations` | `data.db` | `file VARCHAR(255) PRIMARY KEY NOT NULL, applied INTEGER NOT NULL` (microseconds) |
| `_collections` | `data.db` | `id`, `system`, `type`, `name`, `fields` (JSON), five rule columns, `options` (JSON), `indexes` (JSON), `created`, `updated` |
| `_params` | `data.db` | key-value; row `settings` holds the settings JSON, possibly encrypted |
| `_superusers` | `data.db` | auth collection table |
| `_externalAuths`, `_mfas`, `_otps`, `_authOrigins` | `data.db` | system base collections |
| `_logs` | `auxiliary.db` | with upstream's indexes |

### Collection tables

Each collection has a table named after it (a view for `view` collections), with columns from its `fields` and indexes from its `indexes`. iglo.base creates and alters them with the same SQL upstream generates (`collection_record_table_sync.go`), including rename handling, column drops, index recreation and view re-creation.

| Field type | Column type |
|---|---|
| `text` (non-id) , `editor`, `email`, `url`, `date`, `autodate`, `password` | `TEXT DEFAULT '' NOT NULL` |
| `text` (primary key `id`) | `TEXT PRIMARY KEY DEFAULT ('r'\|\|lower(hex(randomblob(7)))) NOT NULL` |
| `number` | `NUMERIC DEFAULT 0 NOT NULL` |
| `bool` | `BOOLEAN DEFAULT FALSE NOT NULL` |
| `select`, `file`, `relation` (single) | `TEXT DEFAULT '' NOT NULL` |
| `select`, `file`, `relation` (multiple) | `JSON DEFAULT '[]' NOT NULL` |
| `json` | `JSON DEFAULT NULL` |
| `geoPoint` | `JSON DEFAULT '{"lon":0,"lat":0}' NOT NULL` |

### Values

| What | Format |
|---|---|
| IDs | 15 characters from `a-z0-9` by default; the `id` field's pattern, length and autogenerate pattern are respected |
| Dates | `2006-01-02 15:04:05.000Z` in UTC (`YYYY-MM-DD HH:MM:SS.sssZ`), empty string when unset |
| Booleans | `0`/`1` |
| Multi-value fields | JSON arrays, normalized as upstream does when `maxSelect` changes |
| `json` fields | raw JSON text, stored as received after validation. Never parsed and re-serialized, because `JSON.parse` loses large-number precision and reorders integer-like keys |
| Passwords | bcrypt. New hashes are written as `$2a$` with the field's `cost` (default 10), computed by `Bun.password` (which writes `$2b$`; only the prefix differs). Stored hashes are parsed with Go's rules (`golang.org/x/crypto/bcrypt`: a version byte up to `2` with an optional minor byte, two cost digits, a 22-character salt, at least 31 hash characters with any bytes after them ignored). They are verified with `Bun.password` after normalization to the canonical `$2b$` form, or, for forms `Bun.password` cannot take (a salt with `\r` or `\n`, which Go's base64 decoder skips, so it decodes to fewer than 16 bytes), with the ported Go bcrypt in `src/tools/crypto/` and a constant-time comparison. The field's `max` is 71 characters (runes) by default and at most 71; hashing refuses passwords over 72 bytes (`ErrPasswordTooLong`), and verification uses only the first 72 bytes, as Go does |
| `tokenKey` | random string per auth record, part of every token signature |

## Migrations

User migrations in `pb_migrations` run as upstream runs them and are recorded in `_migrations` under their file names ([D23](10-decisions.md#d23-javascript-migrations-are-supported), task M3.7). The system migrations keep their upstream file names:

```text
1640988000_init.go
1640988000_aux_init.go          creates _logs in auxiliary.db
1717233556_v0.23_migrate.go … 1717233559_v0.23_migrate4.go
1763020353_update_default_auth_alert_templates.go
1778828400_normalize_indexes.go
```

All rows, including `1640988000_aux_init.go`, are in `data.db`'s `_migrations` table. `auxiliary.db` has no `_migrations` table (checked on real v0.40.x data). PocketBase v0.38.1 through v0.41.0 have the same eight system migrations, and a fresh v0.40.6 install has the same `sqlite_schema`, `_migrations` files and `_collections` rows (but the generated values) as a fresh v0.41.0 install (checked with the v0.40.6 release binary).

On open:

1. **Empty data directory** (no system migration recorded and none of the tables the baseline creates): create the v0.41.0 schema directly (the end state of all system migrations, taken from a fresh upstream v0.41.0 install), then insert the `_migrations` rows above, so PocketBase sees nothing pending. As upstream does, the `_migrations` table is created first and everything else runs in one `auxiliary.db` transaction around one `data.db` transaction; each row's `applied` is the clock's time in microseconds when it is recorded. The settings load that follows writes the default settings row in `_params`, as upstream's fresh install does (see Settings).
2. **Existing data:** check that every system migration above is recorded and that the five system collections (`_superusers`, `_externalAuths`, `_mfas`, `_otps`, `_authOrigins`) exist with their tables and types. If any is missing, refuse to start with: "This pb_data was written by an older PocketBase. Run PocketBase v0.41.0 on it once, then start iglo.base." The refusal writes nothing and exits with code 1. The check only reads `pb_data`: when `data.db` has a `-journal`, `-wal` or `-shm` file (a running or crashed writer), it inspects a copy of them in a temporary directory outside `pb_data`. If that copy cannot be made (the temporary directory is not writable or too small), it checks `data.db` in place as upstream opens it; then SQLite's own crash recovery may write to `pb_data` before a refusal, but compatible data still starts. A `data.db` that cannot be read stops the start with SQLite's error; it is never treated as an empty directory.
3. **Other rows** in `_migrations` (user `.js` or Go migrations, historical system migrations) are kept and ignored. If unknown rows look newer than the baseline (timestamp after `1778828400` with a `.go` suffix), start with one warning: the data may come from a newer PocketBase.
4. **`_logs` missing** from `auxiliary.db` (for example a deleted file): `1640988000_aux_init.go`'s reapply condition, as upstream: the table is created again and its row is recorded again with a new `applied`.

iglo.base never adds `_migrations` rows of its own. If iglo.base ever needs a format change, it needs a new decision record and a new major version, because it breaks going back to PocketBase.

## Settings

- Stored in `_params` row `settings`, with upstream's JSON field names (`meta`, `smtp`, `s3`, `backups`, `rateLimits`, `trustedProxy`, `batch`, `logs`, `superuserIPs`) and defaults.
- The value is written as upstream's `json.Marshal` of the settings struct writes it: members in struct order, `[]` for empty lists, the S3 `secret` only when set, Go's string escaping and integer text. Plain JSON is stored as a BLOB (Go's `[]byte`). A pb_data without the row gets the default settings on start; a row is written only by a save (`PATCH /api/settings`), never on load.
- **Encryption:** when `--encryptionEnv NAME` is set and `$NAME` holds a 32-character key, the value is AES-256-GCM: base64 of `nonce (12 bytes) || ciphertext || tag`, the nonce from a secure random source, as upstream's `security.Encrypt`, stored as TEXT. Reading accepts plain JSON too, as upstream does, so enabling encryption later works. A value that is not plain JSON fails the start with upstream's message: `invalid settings db data or missing encryption key "NAME"` without a key, the AES-GCM or key size error with one.
- Loading merges the stored JSON into the current settings (names match case-sensitively; missing keys keep their defaults, so rows from older versions load). Unknown keys in stored settings are ignored and, as upstream does, dropped by the next save.

## Tokens

Signed tokens survive a switch: a user logged in through PocketBase stays logged in through iglo.base, and back.

- JWT, HS256, signed with `record.tokenKey + collection.<tokenType>.secret` (upstream `core/record_tokens.go`).
- Types and claims: `auth` (`id`, `collectionId`, `refreshable`), `verification` and `passwordReset` (`email`), `emailChange` (`email`, `newEmail`), `file` (`id`, `collectionId`), with `exp`.
- Durations come from the collection's token options.

## Backups

- A backup is a zip of `pb_data` without `backups/` and `.pb_temp_to_delete/`, with `data.db` and `auxiliary.db` copied by `VACUUM INTO`, as upstream's `backup_create.go`.
- Backups made by PocketBase restore in iglo.base, and the reverse. Restore replaces `pb_data` the way upstream does (extract to temp, swap directories, restart).
- The restart after restore re-executes the iglo.base executable with the same arguments, as upstream.

## Verification

The [port plan](09-port-plan.md#data-round-trip-suite) has a round-trip suite (`test/differential/roundtrip/`) that runs on every change to storage code. Each run has three legs on one `pb_data`, and a control run does the same legs with upstream alone from a copy of the same start:

1. Upstream v0.41.0 starts on the fixture, runs a write-heavy scenario through the API and stops.
2. iglo.base starts on the result, reads everything through the API with responses equal to upstream's last read of the same data, runs the same scenario (under its own names, and changing what leg 1 wrote) and stops.
3. Upstream starts again, reads back everything iglo.base wrote with equal responses, and runs the scenario once more.

After the servers stop, a copy of each result is read and compared: `PRAGMA integrity_check`, `sqlite_schema` (without `rootpage`) byte for byte, the `quote()` text of every row of every table (`_migrations`, `_collections` and `_params` included), the top-level names in `pb_data`, and `storage/`: names, file bytes, `.attrs`, thumbnails. A token issued on one server must work on every later leg, and `auxiliary.db` must open, pass its integrity check and keep every `_logs` row upstream wrote.

Only values a server generates are normalized, each by a named rule with its exact format, in `test/differential/roundtrip/snapshot.ts`: timestamps from the run itself, `tokenKey`, the salt and hash of a bcrypt value (the `$2a$` and the cost stay), the random part of a stored file name, ids the scenario left to the server, new token secrets and view field ids, and the nonce of encrypted settings (the value is decrypted with the run's key, so plain and encrypted stay apart). A value carried over from the start is never normalized. `sqlite_stat4` is the one known difference, and a thumbnail iglo.base generated may differ in encoded bytes, not in format, size or `.attrs` (but its `md5`). Upstream runs with `--automigrate=false`: its default writes `pb_migrations` files and `_migrations` rows for every collection change, which iglo.base does from M3.7.

Fixtures: upstream's `tests/data` with plain settings, a fresh v0.41.0 install with encrypted settings, and a fresh install where encryption is turned on between the legs (settings only), in `bun run test:reference`; a generated dataset of 20,000 records in each of the first two legs and 2,000 in the last in `bun run test:roundtrip:large`. A self-test alters a copy of a result (an extra index, table, column, trigger or `_params` row, a changed row, `.attrs` or file) and the comparison must fail.

## Cutover checklist

For moving an existing PocketBase deployment:

1. Upgrade to PocketBase v0.40.x or v0.41.0 and let it run its migrations.
2. If you use `pb_migrations`, keep the directory next to `pb_data` (or pass the same `--migrationsDir`); iglo.base applies pending ones at startup as upstream does ([D23](10-decisions.md#d23-javascript-migrations-are-supported)).
3. If you use `pb_hooks` or a custom Go build, list what the hooks do. Each one moves into your app, a separate service, or a [rule](05-rules-and-filters.md). iglo.base starts without them.
4. Stop PocketBase and take a backup (copy `pb_data`, or use the dashboard backup).
5. Replace the executable and keep the same flags. Remove `--hooksDir`, `--hooksWatch` and `--hooksPool`. Replace any use of `pocketbase update` with rebuilding the image on a new iglo.base release ([D19](10-decisions.md#d19-drop-the-update-command)).
6. Start iglo.base. To roll back, stop it and start PocketBase v0.41.0 (or the v0.40.x you came from) on the same directory.
