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
- Upload, record save and old-file deletion order follows upstream: new files are written before the record commits; files replaced or removed in a save are deleted by the file field after commit; a failed save removes the files it wrote. After a record or collection delete, its storage directory is removed by a bounded background worker (`PB_FILES_DELETE_MAX_WORKERS`).
- Multipart bodies are read by a port of Go's `mime/multipart` (`src/server/multipart.ts`, M3.1), which streams the body with Go's part, header and memory limits and quoted-printable decoding. As in Go's `ReadForm`, file part bytes past 16 MiB per request go to a temporary file in the OS temp directory, and the temporary files are removed when the request ends (D27, M3.2; [measurements](../perf/M3.2-files.md)).

### Serving

`GET /api/files/{collection}/{recordId}/{filename}` (M5.2) as upstream's `apis/file.go` and `System.Serve`: protected files need a file token (`?token=`, from `POST /api/files/token`) whose record passes the collection's view rule, superuser file tokens obey `superuserIPs`; `Content-Disposition` is `inline` only for upstream's inline-safe types and `attachment` with `download=1`; `.svg`, `.css`, `.js`, `.mjs`, `.xlsx`, `.docx` and `.pptx` get upstream's fixed content types; `Content-Security-Policy` and `Cache-Control` as upstream, `X-Frame-Options` removed. Ranges, `If-*` preconditions and `Last-Modified` follow Go's `http.ServeContent`. The file is streamed from storage, not read into memory; a multipart/byteranges body is put together in memory up to 16 MiB, and a longer one is copied in pieces to a file in `pb_data/.pb_temp_to_delete` and sent from it, so that it keeps upstream's `Content-Length` (Bun sends a streamed body chunked); the file is unlinked once the response has opened it.

### Thumbnails

Behavior copied from upstream's `CreateThumb`:

| Size | Meaning |
|---|---|
| `WxH` | fill and crop from the center |
| `WxHt` | fill and crop from the top |
| `WxHb` | fill and crop from the bottom |
| `WxHf` | fit inside without cropping |
| `0xH`, `Wx0` | resize keeping the aspect ratio |

- Linear resampling: imaging v1.6.2's `Linear` filter, whose support grows with the reduction. `Fill` crops before it resizes for sources of at least 100×100 px and after it for smaller ones, as imaging does.
- Input: only originals stored as `image/png`, `image/jpg`, `image/jpeg`, `image/gif` (first frame) or `image/webp` are thumbed (upstream's `imageContentTypes`); others, TIFF and BMP included, serve the original. The JPEG EXIF orientation is applied as imaging v1.6.2 reads it: from the first APP1 segment only, so an Exif segment after an XMP one is ignored.
- Output format by the original's content type: JPEG (quality 95) and GIF (Plan 9 palette, Floyd–Steinberg dithering) stay in their format; everything else, including WebP, becomes PNG with `Content-Type: image/png`. (`createThumb` also keeps TIFF and BMP, which the API never reaches.)
- Only sizes listed in the field's `thumbs` option, plus the default `100x100`, are generated; others serve the original.
- Generated once, stored under `thumbs_<filename>/<size>_<filename>` with the content type above and no metadata (the same `.attrs` as upstream's), then served from storage. A thumb either server stored is served by the other (`test/differential/files/serve.test.ts`).
- Limits from upstream: `PB_THUMBS_MAX_SOURCE_PIXELS` (default 104,857,600 pixels, `100 << 20`, since v0.41.0), checked before the decode on the size Go's `image.DecodeConfig` reads (for a GIF the logical screen, not the first frame), read from the stored file through a bounded buffer before the original is read whole; `PB_THUMBS_MAX_WORKERS` (default NumCPU + 2) thumbs at once, one per thumb path; `PB_THUMBS_MAX_WAIT` (default 60 s) to start. Over the limit, on a damaged image or any other error, the original is served.
- Library ([D10](10-decisions.md#d10-thumbnails-without-native-addons-bunimage-and-upstreams-geometry), [measurements](../perf/M0.7-thumbnails.md)): `Bun.Image` decodes and encodes JPEG and PNG. The header is read by a port of `image.DecodeConfig` (JPEG, PNG, GIF, WebP), not by `Bun.Image`'s `metadata()`. `Bun.Image` decodes with `autoOrient: false`, and the port of imaging's `readOrientation` picks the `rotate`/`flip`/`flop` it applies; the geometry is planned on that turned size, and for a GIF on the first frame's size. The resize and crop are a port of imaging's, and GIF output a port of Go's `gif.Encode`. A walk to the JPEG EOI marker makes cut JPEGs fail as upstream's decoder does. Originals over 16 megapixels are first reduced by `Bun.Image` to at least 4 source pixels per thumb pixel; smaller ones take the exact path. The work runs in the app's thumb pool (`src/files/thumb-pool.ts`): Bun Workers started lazily, at most `PB_THUMBS_MAX_WORKERS`, an idle one stopped after 30 s, so a large image cannot stall requests. The original is read and the thumb stored on the main thread through the storage `System`, outside any database transaction ([measurements](../perf/M5.2-files.md)).
- The failed-thumb warning upstream writes to the app logs waits for the logs writer (M5.5); until then it is not printed.
- The acceptance test compares output dimensions, format and the mean absolute error per channel against upstream's thumbnails, not bytes. The decoders differ: about 1/255 for JPEG and up to about 8/255 for lossy WebP (libwebp against x/image/webp).

## Mail

- **Transport:** `nodemailer`'s SMTP transport when `smtp.enabled` (`host`, `port`, `username`, `password`, `authMethod` `PLAIN` (default) or `LOGIN`, `tls`, `localName`), sending the message as upstream's mailyak writes it (`src/mail/mailyak.ts`), so headers, MIME structure and encodings match upstream's apart from the random boundaries and `Message-ID`. `tls` means implicit TLS; otherwise STARTTLS is used when the server offers it. Credentials are only sent over TLS or to `localhost`, `127.0.0.1` or `::1`, as Go's `net/smtp`. Otherwise the `sendmail` binary (`/usr/sbin/sendmail`, `/usr/bin/sendmail`, then `PATH`) with `-i -t`, as upstream. Since v0.41.0 an empty HTML body is not sent as an HTML part; `sendmail` messages without HTML are `text/plain`, carry custom headers and get a random `Message-ID`.
- **Client:** a new client per send from the current settings (`app.newMailClient()`), as upstream's `NewMailClient`. Upstream's dev-mode console print of each sent mail is an `OnMailerSend` hook default and is not ported (D5, no informational output).
- **Sender:** `meta.senderName` and `meta.senderAddress`.
- **Messages:** verification, password reset, email change confirmation, OTP, login alert, and the settings test email (all five templates for a test record), with upstream's subjects, bodies and placeholders ([Auth](06-auth.md#email-templates)). The login alert is sent before the auth response, with upstream's 15 s wait; a failure is logged and the new origin is not stored. The OTP email's `sentTo` update comes with the OTP storage (M4.2).
- **Tests** read messages from Mailpit and compare the raw messages to upstream's (`test/differential/mail/`).

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
