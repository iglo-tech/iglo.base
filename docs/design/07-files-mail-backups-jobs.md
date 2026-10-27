# Files, mail, backups, jobs and logs

## Files

Ported from upstream `tools/filesystem` (about 5,100 lines, which include a vendored S3 client and a gocloud-derived local blob store) and `core/field_file.go`.

### Storage backends

| Backend | Upstream | iglo.base |
|---|---|---|
| Local | `fileblob` under `pb_data/storage`, with `.attrs` sidecars and bucket-escape checks | Same layout and sidecars ([Data compatibility](03-data-compatibility.md#the-pb_data-directory)), written atomically (temp file in the same directory, then rename) |
| S3 | in-house S3 client, settings `s3.enabled`, `bucket`, `region`, `endpoint`, `accessKey`, `secret`, `forcePathStyle` | `Bun.S3Client` with the same settings, keys and object metadata (`Content-Type`, `Content-Disposition`, user metadata) |

`POST /api/settings/test/s3` tests storage or backups S3 the same way.

### Uploads

- Multipart field names and the `+`/`-` modifiers for multi-file fields, `maxSelect`, `maxSize`, `mimeTypes` (sniffed, not trusted from the client), and `protected`.
- File names: sanitized base name, `_`, 10 random characters, original extension, as upstream.
- Upload, record save and old-file deletion order follows upstream: new files are written before the record commits; replaced and deleted files are removed after commit by a bounded worker (`PB_FILES_DELETE_MAX_WORKERS`); a failed save removes the files it wrote.
- Bun's `request.formData()` buffers the whole body. The M0 spike measures memory for uploads near the 32 MiB default and larger per-field limits; if it is too high, uploads use a streaming multipart parser that writes parts to `pb_data/.pb_temp_to_delete`.

### Thumbnails

Behavior copied from upstream's `CreateThumb`:

| Size | Meaning |
|---|---|
| `WxH` | fill and crop from the center |
| `WxHt` | fill and crop from the top |
| `WxHb` | fill and crop from the bottom |
| `WxHf` | fit inside without cropping |
| `0xH`, `Wx0` | resize keeping the aspect ratio |

- Linear (bilinear) resampling.
- Output format: JPEG, GIF (first frame), TIFF and BMP stay in their format; everything else, including WebP, becomes PNG with `Content-Type: image/png`.
- Only sizes listed in the field's `thumbs` option, plus the default `100x100`, are generated; others serve the original.
- Generated once, stored under `thumbs_<filename>/`, then served from storage.
- Limits from upstream: `PB_THUMBS_MAX_SOURCE_PIXELS` (default 262,144,000 pixels), `PB_THUMBS_MAX_WORKERS`, `PB_THUMBS_MAX_WAIT`. Over the limit, the original is served.
- Decoding and encoding run in a worker so a large image cannot stall requests. The library is chosen in M0 (D10). The acceptance test compares output dimensions, format and a perceptual difference against upstream's thumbnails, not bytes.

## Mail

- **Transport:** `nodemailer`. SMTP when `smtp.enabled` (`host`, `port`, `username`, `password`, `authMethod` `PLAIN` or `LOGIN`, `tls`, `localName`); otherwise the `sendmail` binary with `-i -t`, as upstream.
- **Sender:** `meta.senderName` and `meta.senderAddress`.
- **Messages:** verification, password reset, email change confirmation, OTP, login alert, and the settings test email, with upstream's subjects, bodies and placeholders ([Auth](06-auth.md#email-templates)).
- **Tests** read messages from Mailpit and compare headers, recipients and bodies to upstream's output.

## Backups

- `POST /api/backups` creates `<name>.zip` (default name generated from the `pb_backup_` prefix as upstream) with upstream's procedure: copy `data.db` and `auxiliary.db` with `VACUUM INTO`, then the rest of `pb_data`, excluding `backups/`, `.pb_temp_to_delete/` and files created after the backup started.
- One backup or restore at a time, as upstream (409-style error otherwise).
- Storage: `pb_data/backups` or S3 (`backups.s3`).
- Scheduled backups: `backups.cron` and `backups.cronMaxKeep`, as a built-in job.
- Restore: download or open the zip, extract into a temp directory, check it contains `data.db`, swap it with `pb_data` (keeping the old one until the restart succeeds, as upstream), then re-execute the process.
- Download uses a superuser file token, as upstream.
- Zip writing and reading are in-house (store and deflate only), unless a small dependency is justified in [Decisions](10-decisions.md).

## Jobs

Built-in jobs only, with upstream IDs and schedules, because `/api/crons` exposes them and the dashboard can run them:

| ID | Schedule | Work |
|---|---|---|
| `__pbLogsCleanup__` | `0 */6 * * *` | delete logs older than `logs.maxDays` |
| `__pbDBOptimize__` | `0 0 * * *` | `PRAGMA wal_checkpoint(TRUNCATE)` on both files, `PRAGMA optimize` |
| `__pbMFACleanup__` | `0 * * * *` | delete expired `_mfas` rows |
| `__pbOTPCleanup__` | `0 * * * *` | delete expired `_otps` rows |
| `__pbRateLimitersCleanup__` | `2 * * * *` | prune in-memory rate-limit buckets |
| `__pbAutoBackup__` | `backups.cron` | scheduled backup named `@auto_pb_backup_…`, keeping `cronMaxKeep` auto backups |

The cron expression parser and scheduler are ported from upstream `tools/cron` (about 500 lines), with an injected clock.

## Logs

- Request and app logs are rows in `auxiliary.db` `_logs`, with upstream's `level`, `message` and `data` shapes (`type`, `url`, `method`, `status`, `execTime`, `remoteIP`, `userIP`, `referer`, `userAgent`, `auth`, `error`, `details`).
- Settings: `logs.maxDays`, `minLevel`, `logIP`, `logAuthId`, `maxDataSize`.
- Writes are buffered and flushed in batches, as upstream's batch handler, and on shutdown.
- `GET /api/logs`, `/api/logs/stats` (hourly buckets) and `/api/logs/{id}` use the same filter language as records, over the log fields.
- `--dev` prints logs and SQL statements to the console, as upstream. Otherwise the console only shows errors and the `serve` banner.
