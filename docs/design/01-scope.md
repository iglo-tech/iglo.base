# Scope

## Goals

1. **Drop-in replacement for PocketBase v0.41.0.** Same REST API, realtime protocol, admin dashboard, CLI (except `update`, D19) and environment, so apps and SDKs do not change.
2. **Same data directory.** Open an existing `pb_data` without migration or conversion, and leave it readable by PocketBase v0.41.0, so going back is always possible ([Data compatibility](03-data-compatibility.md)).
3. **No extension surface, except migrations.** No Go framework mode, JavaScript hooks or dashboard extensions. JavaScript migrations in `pb_migrations` are supported, as upstream runs them ([D23](10-decisions.md#d23-javascript-migrations-are-supported)). Behavior is fixed and fully covered by tests.
4. **One stack:** Bun, TypeScript, SQLite, one executable, shared conventions with other iglo.\* projects.

## Non-goals

- New features in v1. Anything PocketBase v0.41.0 does not do is out of scope until 1.0 ships.
- Tracking upstream automatically. Upstream releases after v0.41.0 are reviewed by hand for security and bug fixes ([D16](10-decisions.md#d16-upstream-releases-after-v0410-fixes-only-by-hand)).
- Any database other than SQLite. Multi-node, replication or horizontal scaling.
- Byte-identical output where it does not affect clients (JSON key spacing, header order, thumbnail encoder bytes). Semantic equality is the bar; see [API compatibility](04-api-compatibility.md).
- A public community project: no support process, no release promise, no community governance files (same stance as iglo.monitor).

## Removed: the extension surface

Everything described under [Extending PocketBase](https://pocketbase.io/docs/use-as-framework/) is removed, except JavaScript migrations, which are kept ([D23](10-decisions.md#d23-javascript-migrations-are-supported)). The only other removal is the `update` command ([below](#removed-the-update-command)).

| Upstream mechanism | Where it lives upstream | In iglo.base |
|---|---|---|
| Go framework: `import "ganigeorgiev.com/pocketbase/pocketbase"`, `app.OnXxx()` hooks, `e.Router.GET(...)` custom routes, custom console commands, `app.Cron().Add`, Go migrations, record proxies, `RootCmd` flags | `core`, `apis`, `tools/hook`, `pocketbase.go` | No public package. Internal modules are not an API and are not versioned |
| JavaScript hooks in `pb_hooks/*.pb.js` (event hooks, `routerAdd`, `cronAdd`, `$app`, `$http`, `$template`, `$os`, …) | `plugins/jsvm` (goja), about 3,600 lines plus generated types | Removed. No JS VM is embedded |
| Flags `--hooksDir`, `--hooksWatch`, `--hooksPool` | `examples/base/main.go` | Rejected with an error that names this document |
| Dashboard extensions: `ServeEvent.UIExtensions`, `/_/extensions.js`, `/_/extensions/{name}/*` | `apis/extensions.go` | `/_/extensions.js` returns an empty script so the dashboard loads unchanged. No extension routes |
| User-defined cron jobs and their listing | `app.Cron().Add` from hooks | `/api/crons` lists and runs only the built-in jobs |

Not removed, because they are product features, not extension mechanisms:

- collections and fields edited in the dashboard or through `/api/collections` (including import and export of collection definitions);
- API rules and filters;
- `pb_public` static file serving (`--publicDir`, `--indexFallback`), which upstream's prebuilt binary includes;
- the superuser SQL console (`POST /api/sql`).

**Data from deployments that used hooks is still compatible.** The hooks simply stop running. Logic that lived in hooks must move into the app (usually a small service using the API and realtime). The [cutover checklist](03-data-compatibility.md#cutover-checklist) covers it.

### Exact CLI messages

These texts are what the executable prints (on stderr, after upstream's `log.Fatal` timestamp, exit code 1). Each removed flag is rejected in every form (`--flag`, `--flag=value`, `--flag value`), before or after the command, unless it follows `--`:

```text
flag --<name> is not supported: iglo.base has no JavaScript hooks. See https://github.com/iglo-tech/iglo.base/blob/main/docs/design/01-scope.md#removed-the-extension-surface
```

When `pb_hooks` exists next to `pb_data` (upstream's default, `pb_data/../pb_hooks`), `serve` logs one line on stderr and starts normally:

```text
<time> WARN <dir> is ignored: iglo.base does not run JavaScript hooks. See https://github.com/iglo-tech/iglo.base/blob/main/docs/design/01-scope.md#removed-the-extension-surface
```

## Kept: JavaScript migrations

Decided by the owner on 2026-10-28 ([D23](10-decisions.md#d23-javascript-migrations-are-supported)). Upstream's migration workflow from `plugins/migratecmd` and the migration part of `plugins/jsvm` works as in the upstream binary:

- `pb_migrations/*.js` (or `--migrationsDir`) are applied at startup in file-name order, before `serve` accepts requests, and each applied file is recorded in `_migrations` under its file name, as upstream does;
- the `migrate` command with `up`, `down [n]`, `create <name>`, `collections` and `history-sync`, with upstream's output;
- `--automigrate` (on by default in upstream's prebuilt binary): collection changes made in the dashboard or through `/api/collections` write a migration file from upstream's templates;
- migration files see the globals upstream gives them (below). Files run on Bun, not in an embedded VM: each file in its own `node:vm` context, so it sees only its bindings and nothing of the process. `up` and `down` are synchronous, inside the synchronous write transaction (D8): one that returns a promise fails the migration. A global that iglo.base does not provide fails the migration with an error that names it.

`pb_hooks` stays removed ([above](#removed-the-extension-surface)). Upstream's generated `pb_data/types.d.ts` (an editor aid that also documents the hooks API) is not written.

### Globals of a migration file

As upstream, `$app` is not a global there: a migration uses its `app` argument.

| Provided | Notes |
|---|---|
| `migrate`, `__hooks` | |
| `console`, `process` (`env`), `Buffer`, `require` | `require` resolves as upstream: relative to the working directory, then the requiring module; `node_modules`; `console`, `process`, `buffer`, `util` |
| `Collection`, `Record`, `FieldsList`, `Field`, the 14 named field constructors | |
| `DynamicModel`, `arrayOf`, `nullString`, `nullFloat`, `nullInt`, `nullBool`, `nullArray`, `nullObject` | |
| `unmarshal`, `toString`, `toBytes`, `readerToString`, `sleep`, `DateTime`, `ValidationError` | `DateTime` without its location argument |
| `$dbx`, `$security` | complete |
| `$os` | `args`, `exit`, `getenv`, `stat`, `readFile`, `writeFile`, `readDir`, `tempDir`, `truncate`, `getwd`, `mkdir`, `mkdirAll`, `rename`, `remove`, `removeAll` |
| `$filepath` | `base`, `clean`, `dir`, `ext`, `fromSlash`, `toSlash`, `isAbs`, `join`, `rel`, `split`, `splitList` |

The `app` argument has upstream's names for the app settings and databases (`settings`, `db`, `auxDB`, `dataDir`, ...), `runInTransaction`, `auxRunInTransaction`, `save`, `saveNoValidate`, `delete`, `validate`, the collection and record finders, `importCollections`, the table helpers and `expandRecord`. Another `core.App` method fails with an error that names it.

A migration file reaches an internal class only through its Go signature (`src/migrations/go-class.ts`, from upstream's `types.d.ts`): the class's Go fields and methods and nothing else of the internal object, arguments converted as goja converts them, a missing argument as its Go zero value.

| Missing | Reason |
|---|---|
| `$http`, `FormData` | network calls never run inside a write transaction |
| `$mails`, `MailerMessage` | a mail is a network call |
| `$template` | only hooks render templates |
| `$filesystem` | file and upload bindings are out of scope for migrations |
| `AppleClientSecretCreateForm`, `RecordUpsertForm`, `TestEmailSendForm`, `TestS3FilesystemForm` | upstream's internal forms, kept there for old hooks |
| `Context`, `Middleware`, `Cookie`, `SubscriptionMessage`, `RequestInfo` | they belong to request handling, which a migration does not have |
| `Command` | iglo.base has no custom console commands |
| `Timezone` and `DateTime`'s location argument | time zones are not bound; a stored date is UTC |
| `field.intercept`, the Go contexts and log hooks of a query (`context`, `withContext`, `fieldMapper`, `tableMapper`, `logFunc`, `perfFunc`, `queryLogFunc`, `execLogFunc`, `lastError`) | they are hook plumbing; a migration has no `Context` to pass and no request to intercept |
| `time.Time` beyond `unix`, `unixMilli`, `year`, `month`, `day`, `hour`, `minute`, `second` | the rest needs Go's layouts and locations; `DateTime` covers what a migration stores |
| `$os.exec`, `$os.cmd`, `$os.dirFS`, `$os.openRoot`, `$os.openInRoot`, `$filepath.glob`, `$filepath.match`, `$filepath.walk`, `$filepath.walkDir` | they need Go values (processes, file handles, callbacks) no migration pattern uses |

## Removed: the `update` command

Upstream's `update` command (`plugins/ghupdate`) replaces the executable with a newer release. iglo.base runs inside a container image that is rebuilt on every deploy, so the command is not ported ([D19](10-decisions.md#d19-drop-the-update-command)). `iglo.base update` fails with an error that names this document:

```text
command "update" is not supported: iglo.base does not replace its own executable; deploy a new release instead. See https://github.com/iglo-tech/iglo.base/blob/main/docs/design/01-scope.md#removed-the-update-command
```

## Kept: everything else

**v1** ships in the first usable release (1.0). Nothing is dropped beyond the extension surface and the `update` command.

| Area | v1 |
|---|---|
| Collections | `base`, `auth`, `view` types; system collections `_superusers`, `_externalAuths`, `_mfas`, `_otps`, `_authOrigins`; indexes; scaffolds; import/export; truncate; view dry-run |
| Fields | `text`, `editor`, `number`, `bool`, `email`, `url`, `date`, `autodate`, `select`, `file`, `relation`, `json`, `geoPoint`, `password`, with all options and validation messages |
| Records | list (pagination, `sort`, `filter`, `expand`, `fields`, `skipTotal`), view, create, update, delete, `+`/`-` modifiers, cascade delete, multipart and JSON bodies |
| Rules and filters | the full filter language with `@request.*`, `@collection.*`, macros, modifiers (`:isset`, `:changed`, `:length`, `:each`, `:lower`), `geoDistance()`, `strftime()` ([Rules and filters](05-rules-and-filters.md)) |
| Batch | `POST /api/batch`, transactional, with the settings limits |
| Realtime | SSE `GET/POST /api/realtime`, record and collection topics, per-subscription `options` (query and headers), auth-aware delivery, `PB_CONNECT` |
| Auth | password (identity fields), OTP, MFA, OAuth2 with the same provider list (30+, including OIDC and Apple), refresh, verification, password reset, email change, impersonation, auth origins and new-login alerts, superuser IP allow-list ([Auth](06-auth.md)) |
| Files | local storage and S3, upload limits and MIME checks, thumbnails (`WxH`, `WxHt`, `WxHb`, `WxHf`, `0xH`, `Wx0`), protected files with file tokens, `download` param |
| Mail | SMTP and `sendmail` fallback, auth email templates with placeholders, test email ([Files, mail, backups, jobs and logs](07-files-mail-backups-jobs.md)) |
| Backups | create, upload, download, delete, restore; local or S3; scheduled backups with retention |
| Logs | request and app logs in `auxiliary.db`, list, stats, retention settings |
| Jobs | built-in cron jobs (logs cleanup, DB optimize, MFA and OTP cleanup, rate-limiter cleanup, auto backups) and `/api/crons` |
| Settings | `meta`, `smtp`, `s3`, `backups`, `rateLimits`, `trustedProxy`, `batch`, `logs`, `superuserIPs`; optional encryption with `--encryptionEnv` |
| HTTP | CORS (`--origins`), gzip, body limits, rate limits, trusted proxy headers, HTTPS with automatic Let's Encrypt certificates (`serve example.com`), `/api/health` |
| CLI | `serve`, `superuser upsert/create/update/delete/otp/ips`, `migrate up/down/create/collections/history-sync`, `--dir`, `--dev`, `--encryptionEnv`, `--queryTimeout`, `--http`, `--https`, `--origins`, `--publicDir`, `--indexFallback`, `--migrationsDir`, `--automigrate` |
| Admin dashboard | upstream's `/_/` dashboard, including the installer link for the first superuser ([Admin UI](08-admin-ui.md)) |
| Platforms | linux-x64 release binary for the MVP; linux-arm64 and darwin-arm64 after 1.0 ([D18](10-decisions.md#d18-release-platforms), [D24](10-decisions.md#d24-mvp-targets-linux-x64-only)) |

## Compatibility promise

For 1.x:

- a `pb_data` directory written by PocketBase v0.41.0 opens in iglo.base, and one written by iglo.base opens in PocketBase v0.41.0;
- a client written against PocketBase v0.41.0 (official JS and Dart SDKs, community SDKs, raw HTTP) works against iglo.base without changes;
- the only API differences are the ones listed in [API compatibility](04-api-compatibility.md#deliberate-differences), all of which follow from removing extensions and the `update` command.
