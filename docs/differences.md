# Differences from PocketBase

iglo.base is a port of PocketBase v0.41.0. Your data, your SDKs and your API calls work the same. This page lists what is different, so you can decide whether iglo.base fits your project.

For the API itself (endpoints, filters, rules, realtime) use PocketBase's documentation at [pocketbase.io/docs](https://pocketbase.io/docs/). It applies to iglo.base. Every API response is compared with PocketBase v0.41.0 by a test suite; the differences below are the ones that are known and intended.

## What is not there

| In PocketBase | In iglo.base | What to use instead |
|---|---|---|
| JavaScript hooks (`pb_hooks`, `onRecordCreate` and the others) | Not supported. A `pb_hooks` directory next to `pb_data` is ignored, with a warning at start. | Run the logic in your own service that calls the API, or stay on PocketBase. |
| Custom routes (`routerAdd`) | Not supported. An unknown route answers 404. | Your own service next to iglo.base. |
| Go framework mode (extending PocketBase as a Go library) | Not supported. iglo.base is a program, not a library. | Stay on PocketBase. |
| Plugins and the embedded JavaScript VM | Not supported. | As for hooks. |
| `--hooksDir`, `--hooksWatch`, `--hooksPool` | Refused: the command exits with status 1. | Remove them from your command line. |
| Dashboard extensions | Not supported. `/_/extensions.js` is empty and `/_/extensions/{name}/…` answers 404. | |
| The `update` command | Not supported. The command fails with an error. | Download the new release, or pull the new image. See [Upgrade](operations.md#upgrade). |
| Built-in HTTPS (`serve example.com`, `--https`) | Not supported. The server refuses to start with them. It serves plain HTTP. | A reverse proxy such as Caddy or nginx. See [Reverse proxy with TLS](operations.md#reverse-proxy-with-tls). |

Still there: JavaScript migrations in `pb_migrations`, the `migrate` and `superuser` commands, all API endpoints, realtime, files with local or S3 storage, backups, mail and the admin dashboard. Migration files run with Bun instead of PocketBase's JavaScript VM, with the same bindings.

## Platforms

Release executables exist for Linux x64, Linux arm64 and macOS on Apple silicon, and the Docker image is built for linux/amd64 and linux/arm64. The arm64 and macOS executables and the arm64 image start with release 1.1.0; 1.0.0 has only Linux x64. Windows, FreeBSD, 32-bit ARM and Intel Macs are not supported.

## Version output

`./iglo-base --version` prints `iglo-base version <version>`. PocketBase prints `pocketbase version 0.41.0`. A build that did not come from a release prints `(untracked)`. The `serve` banner prints no version, in both.

## Differences you may notice in the API

Each row says what a client could see. "No client sends this" means only a hand-made request or an unusual tool can hit it.

### Behavior

| Area | PocketBase | iglo.base |
|---|---|---|
| Custom routes and hook side effects | Whatever your hooks or Go code registered or changed. | None. |
| `GET /api/crons` | Built-in and your own jobs. | Built-in jobs only. |
| Request logs | May include entries written by hooks. | Only iglo.base's own entries, in the same shape. |
| `migrate down` that reaches a system migration | Removes its row, runs its down if it has one, and the next start applies it again. | For most system migrations: the same output, and the row stays. For the three schema migrations with a down (`1640988000_init.go`, `1640988000_aux_init.go`, `1763020353_update_default_auth_alert_templates.go`) the command fails before anything changes. |
| Paths with `.` or `..` segments | `307` redirect to the cleaned path. | Answered as the cleaned path, without the redirect. No client sends this. `%2e%2e` and `\` are not resolved in either. |
| Repeated request header lines | `@request.headers.*` sees the first line. A trusted proxy header is read from its last line. | The lines are joined with `, `. With **Use leftmost IP** on, the leftmost IP of the first line is used. Only matters when a client or proxy sends the same header twice. |
| A realtime client that stops reading | The server keeps every unsent message and delivers all of them if the client reads again. | The server closes the stream once more than 8 MiB are unsent. SDKs reconnect and subscribe again. |

### Timing

In most cases iglo.base is faster than PocketBase; the cases where PocketBase leads, start time among them, are in the [README's performance section](../README.md#performance).

| Area | PocketBase | iglo.base |
|---|---|---|
| `--queryTimeout` on reads inside a transaction and other synchronous reads | The statement is stopped at the deadline. Other requests go on. | The query fails with the same error (`context deadline exceeded; failed query: …`), but only after the statement finishes, and the server handles nothing else meanwhile. Reads outside transactions fail at the deadline, as in PocketBase. Matters only for a very slow query. |
| `batch.timeout`, and a client that disconnects during a batch | A running request in the batch is abandoned at the deadline. A closed connection rolls the batch back. | The deadline is checked after each request of the batch, so a late batch is rolled back with the same response, but only once the running request ends. A closed connection is not noticed while the batch runs. |

### Files and S3

| Area | PocketBase | iglo.base |
|---|---|---|
| Downloading a backup or a file from S3 (`GET /api/backups/{key}` with S3 backups, `GET /api/files/…` with S3) | Streams from S3. A failure part way breaks the response off. | The bytes are copied to a temporary file in `pb_data/.pb_temp_to_delete` first, so the first byte arrives later and the file takes disk space meanwhile. A failure part way answers with the API's error (`400` for a backup, `404` for a file). |
| Batch requests and OAuth2 sign-ups with files, with S3 | The file is uploaded inside the database transaction. | The upload happens before the transaction opens, and files no committed record refers to are deleted afterwards. The responses and the stored objects are the same, but a request that is then refused can leave its files in the bucket for a moment, and the upload does not count against `batch.timeout`. |
| `$app.newFilesystem()` in a migration | Returns a filesystem for the configured storage. | With S3 enabled it fails with an error that says why: a migration runs inside a transaction and cannot make network calls. On local storage it is not bound either (`app.newFilesystem is not available in iglo.base migrations`), so a migration that uses it works on PocketBase and fails here. |
| `pb_public` files over 16 MiB, and multi-range responses over 16 MiB (zip, pdf and similar types) | No `Content-Disposition` header. | `Content-Disposition: filename="<name>"`. Browsers show or download these files as before. |
| GIF thumbnails (`?thumb=`) on arm64 | Exact pixels. | On linux/arm64 and macOS the pixels of some GIF thumbnails differ from PocketBase's (the average error is about 15 on a 0–255 scale per channel). The cause is most likely different floating-point code in PocketBase's Go build on arm64. On x64 they are the same. |

### Errors

| Area | PocketBase | iglo.base |
|---|---|---|
| Hand-made or malformed requests (unusual multipart encodings, chunked bodies at exactly the body limit, int64-overflow arguments) | Go's exact error, or Go accepts it. | Handled safely (no crash, no partial data, no rule bypass), but the status code and error text may differ. No normal client sends these. |
| Mail errors: the `Raw error` text of `POST /api/settings/test/email` and the logged login-alert error | Go's error texts. | The same text for a refused connection, an SMTP error reply, credentials sent over an unencrypted connection and a missing `sendmail`. Other failures (DNS, TLS handshake, timeouts) carry the text of `nodemailer`, the mail library. An SMTP username with an empty password (or the reverse) fails before login instead of being sent. |
| S3 network errors: the `Raw error` text of `GET /api/backups`, `DELETE /api/backups/{key}` and `POST /api/settings/test/s3` | Go's error texts. | The same text for a refused connection to an IP address and for a request past its deadline. For a host name, a refused connection names the host, and a DNS or TLS failure has its own text. A backup key with a scheme (`a:b.zip`) is kept as a plain path. |

### The server's own requests

| Area | PocketBase | iglo.base |
|---|---|---|
| OAuth2 avatar download with `HTTP_PROXY` or `HTTPS_PROXY` set on the server | Never uses a proxy. | Uses them. The address checks still apply to the target. |

## Platform notes

| Area | PocketBase | iglo.base |
|---|---|---|
| Settings and collections notify between a running iglo.base and a running PocketBase on macOS | PocketBase's file watcher (kqueue on macOS) often misses markers that are created and removed at once, even its own. | The same markers are written. The iglo.base to PocketBase direction is not verified on macOS; it is tested on Linux. Between iglo.base instances and the CLI the notify works on macOS. |

## Where the list comes from

The list is kept in [API compatibility, deliberate differences](design/04-api-compatibility.md#deliberate-differences), together with the design decisions behind each row. The decisions on [what was removed](design/01-scope.md) are in the design notes. Anything else that differs from PocketBase v0.41.0 is a bug.
