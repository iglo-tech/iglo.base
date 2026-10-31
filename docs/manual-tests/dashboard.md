# Dashboard checklist

The manual `agent-browser` checklist for the vendored dashboard (`docs/design/08-admin-ui.md`). Each run is recorded below with its date, commit and result. Screens whose APIs belong to unmerged tasks are expected gaps, not failures.

## Setup

```sh
bun run build
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
| Settings | Application (save the name), mail (test email), files storage (S3 test), backups, rate limits, trusted proxy, export and import collections | M1.3; mail M4.4, S3 M5.4, backups M5.3 |
| Logs | Logs list and chart, log settings | M5.5 |
| Crons | Crons list and run | M5.6 |
| SQL console | Run a query | its task |
| Realtime | Records list live updates | M5.1 |

## Runs

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
| Settings → Backups | Expected gap: `GET /api/backups` 404 (M5.3) |
| Settings → Crons | Expected gap: `GET /api/crons` 404 (M5.6) |
| Logs | Expected gap: `GET /api/logs` and `/api/logs/stats` 404 (M5.5) |
| File download | Expected gap: `GET /api/files/...` 404 (M5.2) |

All dashboard assets (`/_/`, scripts, styles, fonts, images, libraries) loaded with 200; the only failing requests were the expected gaps above. The automated parts of this flow are in `test/ui/` (serving, installer) and `test/differential/ui/` (against upstream's binary).
