# Dashboard checklist

The manual `agent-browser` checklist for the vendored dashboard (`docs/design/08-admin-ui.md`). Each run is recorded below with its date, commit and result. Screens whose APIs belong to unmerged tasks are expected gaps, not failures.

## Setup

Automated: `bun run test:browser` covers install, a collection-and-record round trip and the logs page (`test/browser/`, needs `agent-browser`). The rest is this checklist, run by hand before a release.

```sh
IGLO_VERSION=0.0.0-test bun run build
mkdir /tmp/dashboard-smoke && cp dist/iglo-base /tmp/dashboard-smoke/
cd /tmp/dashboard-smoke && ./iglo-base serve --http 127.0.0.1:18095
```

Open the printed `/_/#/pbinstall/<token>` link with `agent-browser` (its own session, see `agent-browser skills get core`). Test credentials (test data only): `admin@example.com` / `1234567890`.

## Checklist

| Area | Steps | Needs |
|---|---|---|
| Install | Open the installer link, create the first superuser, land on Collections logged in | M6.1 |
| Branding | Page title, header and login logo, footer ("Docs", "iglo.base <version>"), favicon show iglo.base only | M6.1 |
| Collections | List, open `users`, create a base collection with text, number, bool, file, json and date fields; rules; indexes; view collections | M2.5 |
| Records | Create a record with a file, edit it, filters, relations, file download and thumbnails | M3.1; files M5.2 |
| Auth options | Auth collection options, OAuth2 provider setup | M2.5; providers M4.5–M4.7 |
| Settings | Application (save the name), mail (test email), files storage (S3 test), backups (create, list, download, restore, delete), rate limits, trusted proxy, export and import collections | M1.3; mail M4.4, S3 M5.4, backups M5.3 |
| Logs | Logs list, chart, entry, filter, log settings | M5.5 |
| Crons | Crons list and run | M5.6 |
| SQL console | Run a query | its task |
| Realtime | The dashboard has no live records list (v0.41.0's `ui/` never subscribes); check the API preview's Realtime panel and an `EventSource` from the page: `PB_CONNECT`, `POST /api/realtime`, then `create` and `delete` events | M5.1 |

## Runs

### 2026-11-05, P.5 (commit `5bddb5a`, branch `task/P.5-dashboard-tests`), full checklist

Release build (`IGLO_VERSION=0.0.0-p5 bun run build`), fresh `pb_data`, Chromium through `agent-browser`. Mail went to the Mailpit and S3 to the versitygw of `test/support/` (never a real server); `admin@example.com` / `1234567890`. Screens were also compared with the same dashboard on `.upstream/bin/pocketbase` (fresh data, same superuser): the page text of Collections, Logs, and the Settings pages Application, Mail, Files storage, Backups, Crons, Export, Import and SQL console differs only in the listed D17 patches (product name, footer version, "Go or JS migrations" hint). `GET /api/collections` of the two fresh instances is identical apart from ids and timestamps.

| Row | Result |
|---|---|
| Install | Pass: the link opens "Setup your iglo.base instance"; superuser created, redirected to `#/collections?collection=users` |
| Branding | Pass: favicon `/_/images/favicon.png`, header and login logos, footer "Docs" and "iglo.base 0.0.0-p5", no "PocketBase" in the page text |
| Collections | Pass: `posts` with text, editor, number, bool, email, url, date, autodate, file, select (red, green), json, geoPoint and a relation to `users`; list rule `@request.auth.id != ""`; unique index on `text`; view collection `posts_view` (`select id, text, number from posts`). The API returns all of it |
| Records | Pass: a record with every field and an uploaded file; edit saved; filters `number>40` (1 row), `number<40` (0), `author.name="User One"` (1) from the URL; the relation shows the user's name; file served with `attachment` on download; on `photos` (`100x100` thumb) the list thumbnail loads at width 100 and the preview at 200; delete removes the row |
| Auth options | Pass: `users` Options tab; OAuth2 enabled, GitHub added with a test client id and secret, saved (no login); the API shows the provider |
| Settings → Application | Pass: name saved, page title changes |
| Settings → Rate limits, trusted proxy | Pass: rate limiting enabled with `*:auth` at 100, `X-Forwarded-For` trusted; the page shows "Resolved user IP: 127.0.0.1"; both read back through `GET /api/settings` |
| Settings → Mail | Pass: SMTP to the Mailpit; "Send test email" (Verification): "Successfully sent test email." and Mailpit holds it |
| Settings → Files storage | Pass: S3 settings saved, "S3 connected successfully" |
| Settings → Backups | Pass: create `chk.zip`, list, download (200, `application/zip`), restore (server restarted, page came back, data intact), delete; then S3 backups: "S3 connected successfully", create `s3chk.zip` (object in the bucket) and delete |
| Settings → Export, Import collections | Pass: export lists all collections; a JSON file with an added collection loaded, reviewed (side-by-side diff) and imported: "Successfully imported collections configuration." |
| Logs | Pass: list, chart, entry ("Log details", `logId` in the URL), filter `data.status=401` (1 row), logs settings saved (max days 7) |
| Crons | Pass: four built-in jobs listed; "Run" on `__pbOTPCleanup__`: "Successfully triggered" |
| SQL console | Pass: `select id, text, number from posts` shows the row, "Rows: 1" |
| Realtime | Pass: no live list in the dashboard (as upstream); from the page an `EventSource` got `PB_CONNECT`, `POST /api/realtime` answered 204 and `imported/*` delivered `create` and `delete` |

No defects found. Notes on the dashboard itself, the same as upstream: the import page needs an `id` on every collection; a JSON that leaves out system collections lists them as deleted; an unchanged export shows collections with `oauth2.providers: []` as "Changed" (the page strips providers of the current collections only); the editor and tag inputs need single key presses (`fill` does not reach them).

### 2026-10-31, M5.6 (branch `task/M5.6-cron`)

Fresh `pb_data`, Chromium through `agent-browser`, against the compiled executable.

| Step | Result |
|---|---|
| Settings → Crons | Pass: lists `__pbDBOptimize__`, `__pbMFACleanup__`, `__pbOTPCleanup__`, `__pbLogsCleanup__` with their expressions |
| Run `__pbOTPCleanup__` | Pass: toast `Successfully triggered "__pbOTPCleanup__".`; an expired `_otps` row written before the click was deleted; no page errors |

The screen's footer still says that jobs can be registered with Go or JavaScript. That is upstream's text in `ui/`; iglo.base has only the built-in jobs.

### 2026-10-29, M6.1 (branch `task/M6.1-dashboard`)

Fresh `pb_data`, Chromium through `agent-browser`.

| Step | Result |
|---|---|
| Install: the installer link opens "Setup your iglo.base instance"; "Create superuser and login" with `admin@example.com` | Pass: logged in, redirected to `#/collections?collection=users` |
| Branding: header logo, footer "Docs" and "iglo.base (untracked)", page titles | Pass |
| Collections: open `users`; "New collection" `posts` with Plain text (`title`), Number, Bool, File, JSON and Datetime fields; Create | Pass: `posts` listed, empty records list |
| Records: "New record" with title, number 42, bool on and a text file upload; Create | Pass: the row shows the values and `note_<random>.txt` |
| Records: open the record, change the title, "Save changes" | Pass: the list shows the new title |
| Settings → Application: change the application name, save | Pass: "Successfully saved application settings.", the page title shows the new name |
| Settings → Mail, Files storage, Export collections, Import collections, Auth providers, Tokens | Pass: open without errors |
| Settings → Backups | Expected gap: `GET /api/backups` 404 (M5.3; see the M5.3 run below) |
| Settings → Crons | Expected gap: `GET /api/crons` 404 (M5.6) |
| Logs | Expected gap at this run: `GET /api/logs` and `/api/logs/stats` 404 (see the M5.5 run below) |
| File download | Expected gap: `GET /api/files/...` 404 (M5.2) |

All dashboard assets (`/_/`, scripts, styles, fonts, images, libraries) loaded with 200; the only failing requests were the expected gaps above. The automated parts of this flow are in `test/ui/` (serving, installer) and `test/differential/ui/` (against upstream's binary).

## 2026-10-31, `task/M5.3-backups`, M5.3 backups screen

Run on a fixture copy (`test/fixtures/pocketbase`, `test@example.com` / `1234567890`), executable from this branch.

| Step | Result |
|---|---|
| Settings → Backups: open | Pass: empty list, "Upload backup", "Initialize new backup" and "Backup options" |
| "Initialize new backup", name `ui-test.zip`, "Start backup" | Pass: `ui-test.zip (70.76 KB)` listed; the button shows "Backup/restore operation is in process" until the next `/api/health`, then goes back |
| "Download" | Pass: `POST /api/files/token` 200; the same token request and `GET /api/backups/ui-test.zip?token=…` from the page answer 200, `attachment; filename="ui-test.zip"`, `application/zip`, 72,456 bytes |
| "Restore", type the name, "Restore backup" | Pass: the server restarted (the serve banner printed again), the page came back on the same screen, the backup still listed, `pb_data/.pb_temp_to_delete` gone |
| "Delete", "Yes" | Pass: "Successfully deleted ui-test.zip.", "No backups found.", `pb_data/backups` has no files |

## 2026-11-01, `task/M5.4a-s3-backups`, M5.4a backups screen with S3

Run on a fixture copy (`test/fixtures/pocketbase`, `test@example.com` / `1234567890`), executable from this branch, against versitygw from `test/support/versitygw.ts` (bucket `dash`, test credentials). The fixture stores `backups.cronMaxKeep` 0, and the screen's hidden input has a minimum of 1, so the browser blocks "Save changes" with no request sent, with any server; it was set to 3, a fresh install's value, through the API first.

| Step | Result |
|---|---|
| "Backup options", "Store backups in S3 storage", endpoint, bucket, region, keys, force path-style, "Save changes" | Pass: "Successfully saved backups settings." and "S3 connected successfully" (`POST /api/settings/test/s3`) |
| "Initialize new backup", name `ui-s3-test.zip`, "Start backup" | Pass: "Successfully generated new backup."; listed with 72,552 bytes; `pb_data/backups` stays empty |
| "Download" | Pass: `POST /api/files/token` 200; the same `GET /api/backups/ui-s3-test.zip?token=…` answers 200, `attachment; filename="ui-s3-test.zip"`, `application/zip`, `Content-Length: 72552` |
| "Restore", type the name, "Restore backup" | Pass: the server restarted (the serve banner printed again), the page came back, the backup still listed, no `pb_data/.pb_temp_to_delete` left |
| "Delete", "Yes" | Pass: "Successfully deleted ui-s3-test.zip.", "No backups found.", `GET /api/backups` answers `[]` |

## 2026-11-01, `task/M5.4b-s3-files`, M5.4b record files on S3

Fresh `pb_data`, executable from this branch, against versitygw (posix backend, bucket `dash`, dummy credentials), `s3` settings saved through the API, base collection `photos` with a `file` field and the `100x100` thumb.

| Step | Result |
|---|---|
| "New record", title, attach a PNG, "Create" | Pass: the record is listed; `<collectionId>/<recordId>/picture_6ll969o43x.png` is in the bucket, nothing in `pb_data/storage` |
| The list's thumbnail | Pass: the `?thumb=100x100` image loads at width 100, and `thumbs_picture_…/100x100_picture_…` is in the bucket |
| Click the thumbnail (preview) | Pass: the original loads at width 300 |
| Open the record, "Remove file", "Save changes" | Pass: "Successfully updated photos"; the `image` value is empty and the bucket holds no object, the thumb included |

## 2026-11-02, `task/M5.5-logs`, M5.5 logs screen

Fresh `pb_data`, executable from this branch, `agent-browser` in named sessions of this task, a few requests sent with `curl` (three successes, a 404, a failed login).

| Step | Result |
|---|---|
| Logs: the list | Pass: rows with level, message, `status`, `execTime`, `auth`, `userIP`, and `error` and `details` on the failures; the `[recordAuthResponse] Failed to send login alert` warning shows with its `error` |
| Logs: the chart | Pass: hourly bars with the time axis, "Total: 10" in the footer. The first try found a bug (the stats `date` was not a string, so the chart failed), fixed here and covered by the logs scenarios |
| Logs: open an entry | Pass: "Log details" lists `id`, `level`, `created` and the `data.*` rows, with "Download JSON"; the URL gets `logId` |
| Logs: the filter `data.status=404` from the URL | Pass: one row, "Total: 1". Typing in the search box was not confirmed: the tool's keystrokes did not land in the editor. The same request goes through `GET /api/logs` and `/api/logs/stats`, which the differential suite covers with filters |

