# Scope

## Goals

1. **Drop-in replacement for PocketBase v0.41.0.** Same REST API, realtime protocol, admin dashboard, CLI (except `update`, D19) and environment, so apps and SDKs do not change.
2. **Same data directory.** Open an existing `pb_data` without migration or conversion, and leave it readable by PocketBase v0.41.0, so going back is always possible ([Data compatibility](03-data-compatibility.md)).
3. **No extension surface.** No Go framework mode, JavaScript hooks, user migrations or dashboard extensions. Behavior is fixed and fully covered by tests.
4. **One stack:** Bun, TypeScript, SQLite, one executable, shared conventions with other iglo.\* projects.

## Non-goals

- New features in v1. Anything PocketBase v0.41.0 does not do is out of scope until 1.0 ships.
- Tracking upstream automatically. Upstream releases after v0.41.0 are reviewed by hand for security and bug fixes ([D16](10-decisions.md#d16-upstream-releases-after-v0410-fixes-only-by-hand)).
- Any database other than SQLite. Multi-node, replication or horizontal scaling.
- Byte-identical output where it does not affect clients (JSON key spacing, header order, thumbnail encoder bytes). Semantic equality is the bar; see [API compatibility](04-api-compatibility.md).
- A public community project: no support process, no release promise, no community governance files (same stance as iglo.monitor).

## Removed: the extension surface

Everything described under [Extending PocketBase](https://pocketbase.io/docs/use-as-framework/) is removed. The only other removal is the `update` command ([below](#removed-the-update-command)).

| Upstream mechanism | Where it lives upstream | In iglo.base |
|---|---|---|
| Go framework: `import "ganigeorgiev.com/pocketbase/pocketbase"`, `app.OnXxx()` hooks, `e.Router.GET(...)` custom routes, custom console commands, `app.Cron().Add`, Go migrations, record proxies, `RootCmd` flags | `core`, `apis`, `tools/hook`, `pocketbase.go` | No public package. Internal modules are not an API and are not versioned |
| JavaScript hooks in `pb_hooks/*.pb.js` (event hooks, `routerAdd`, `cronAdd`, `$app`, `$http`, `$template`, `$os`, …) | `plugins/jsvm` (goja), about 3,600 lines plus generated types | Removed. No JS VM is embedded |
| JavaScript migrations in `pb_migrations/*.js` | `plugins/jsvm`, `plugins/migratecmd` | Removed. Only built-in system migrations exist |
| `migrate` command (`up`, `down`, `create`, `collections`, `history-sync`) and `--automigrate` (the dashboard writing migration files on schema change) | `plugins/migratecmd` | Removed. System migrations run automatically at startup, as upstream |
| Flags `--hooksDir`, `--hooksWatch`, `--hooksPool`, `--migrationsDir`, `--automigrate` | `examples/base/main.go` | Rejected with an error that names this document |
| Dashboard extensions: `ServeEvent.UIExtensions`, `/_/extensions.js`, `/_/extensions/{name}/*` | `apis/extensions.go` | `/_/extensions.js` returns an empty script so the dashboard loads unchanged. No extension routes |
| User-defined cron jobs and their listing | `app.Cron().Add` from hooks | `/api/crons` lists and runs only the built-in jobs |

Not removed, because they are product features, not extension mechanisms:

- collections and fields edited in the dashboard or through `/api/collections` (including import and export of collection definitions);
- API rules and filters;
- `pb_public` static file serving (`--publicDir`, `--indexFallback`), which upstream's prebuilt binary includes;
- the superuser SQL console (`POST /api/sql`).

**Data from deployments that used hooks or migrations is still compatible.** The hooks simply stop running. Logic that lived in hooks must move into the app (usually a small service using the API and realtime). The [cutover checklist](03-data-compatibility.md#cutover-checklist) covers it.

### Exact CLI messages

These texts are what the executable prints (on stderr, after upstream's `log.Fatal` timestamp, exit code 1). Each removed flag is rejected in every form (`--flag`, `--flag=value`, `--flag value`), before or after the command, unless it follows `--`:

```text
flag --<name> is not supported: iglo.base has no JavaScript hooks or user migrations. See https://github.com/iglo-tech/iglo.base/blob/main/docs/design/01-scope.md#removed-the-extension-surface
command "migrate" is not supported: iglo.base has no user migrations; system migrations run automatically at startup. See https://github.com/iglo-tech/iglo.base/blob/main/docs/design/01-scope.md#removed-the-extension-surface
```

When `pb_hooks` or `pb_migrations` exists next to `pb_data` (upstream's defaults, `pb_data/../pb_hooks` and `pb_data/../pb_migrations`), `serve` logs one line on stderr and starts normally:

```text
<time> WARN <dir> [and <dir>] is|are ignored: iglo.base does not run JavaScript hooks or user migrations. See https://github.com/iglo-tech/iglo.base/blob/main/docs/design/01-scope.md#removed-the-extension-surface
```

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
| CLI | `serve`, `superuser upsert/create/update/delete/otp/ips`, `--dir`, `--dev`, `--encryptionEnv`, `--queryTimeout`, `--http`, `--https`, `--origins`, `--publicDir`, `--indexFallback` |
| Admin dashboard | upstream's `/_/` dashboard, including the installer link for the first superuser ([Admin UI](08-admin-ui.md)) |
| Platforms | linux-x64, linux-arm64, darwin-arm64 release binaries ([D18](10-decisions.md#d18-release-platforms)) |

## Compatibility promise

For 1.x:

- a `pb_data` directory written by PocketBase v0.41.0 opens in iglo.base, and one written by iglo.base opens in PocketBase v0.41.0;
- a client written against PocketBase v0.41.0 (official JS and Dart SDKs, community SDKs, raw HTTP) works against iglo.base without changes;
- the only API differences are the ones listed in [API compatibility](04-api-compatibility.md#deliberate-differences), all of which follow from removing extensions and the `update` command.
