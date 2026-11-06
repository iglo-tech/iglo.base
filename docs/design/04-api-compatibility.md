# API compatibility

Every client written for PocketBase v0.41.0 must work against iglo.base unchanged: the official JavaScript and Dart SDKs, community SDKs, the dashboard, and raw HTTP. The reference is the upstream binary, not the documentation. Where the docs and the binary disagree, the binary wins.

## What "compatible" means

For every endpoint below, iglo.base matches upstream on:

- path, method and route matching (including trailing-slash and `{path...}` behavior);
- query parameters, JSON and multipart body fields, and their parsing rules (for example, `@jsonPayload` in multipart, `field+` and `+field` / `field-` modifiers);
- status codes, including the order in which checks fail (404 before 403 where upstream does that, 400 validation before rule checks where upstream does that);
- response bodies: field names, types, presence and absence, `null` versus empty, and record field order (the order of the collection's `fields`, then `expand`);
- error bodies `{ "status": …, "message": "…", "data": { "<field>": { "code": "validation_…", "message": "…" } } }` with upstream's codes and messages;
- headers that clients or browsers act on: `Content-Type`, CORS headers, `Cache-Control`, `Content-Disposition`, `Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options`, `X-Accel-Buffering`, rate-limit `429` responses;
- realtime event names, payloads and timing rules.

Compared as bytes after normalization: generated IDs and timestamps are compared by format, not value, and are replaced by the same placeholder on both sides; auth and file tokens are decoded and their header and claims compared (only `exp`, within 3 s, and the signature differ). The bodies must then be byte-identical, including member order, escaping, number text and the bytes of `json` field values. Objects that upstream writes in random member order (Go maps with no fixed order, such as `fields`-projected records and the superuser `/api/health` data) are compared with their members sorted by name. Header order is not compared. The exact rules are in `test/differential/harness/compare.ts`.

## Endpoints

Grouped as upstream's `apis/` files. Each file becomes one handler module in `src/apis/`.

| Area | Endpoints |
|---|---|
| Health | `GET /api/health` |
| Records | `GET /api/collections/{collection}/records`, `GET …/records/{id}`, `POST …/records`, `PATCH …/records/{id}`, `DELETE …/records/{id}` |
| Auth | under `/api/collections/{collection}/`: `GET auth-methods`, `POST auth-refresh`, `POST auth-with-password`, `POST auth-with-oauth2`, `POST request-otp`, `POST auth-with-otp`, `POST request-password-reset`, `POST confirm-password-reset`, `POST request-verification`, `POST confirm-verification`, `POST request-email-change`, `POST confirm-email-change`, `POST impersonate/{id}`; plus `GET` and `POST /api/oauth2-redirect` |
| Realtime | `GET /api/realtime` (SSE), `POST /api/realtime` (set subscriptions) |
| Batch | `POST /api/batch` |
| Files | `POST /api/files/token`, `GET /api/files/{collection}/{recordId}/{filename}` with `thumb`, `token`, `download` |
| Collections | `GET/POST /api/collections`, `GET/PATCH/DELETE /api/collections/{collection}`, `DELETE /api/collections/{collection}/truncate`, `PUT /api/collections/import`, `GET /api/collections/meta/scaffolds`, `GET /api/collections/meta/oauth2-providers`, `POST /api/collections/meta/dry-run-view` |
| Settings | `GET/PATCH /api/settings`, `POST /api/settings/test/s3`, `POST /api/settings/test/email` |
| Logs | `GET /api/logs`, `GET /api/logs/stats`, `GET /api/logs/{id}`, `DELETE /api/logs` |
| Backups | `GET/POST /api/backups`, `POST /api/backups/upload`, `GET/DELETE /api/backups/{key}`, `POST /api/backups/{key}/restore` |
| Crons | `GET /api/crons`, `POST /api/crons/{id}` |
| SQL console | `POST /api/sql` (superusers only) |
| Dashboard | `GET /_/{path...}`, `GET /_/extensions.js` (see differences) |
| Static | `GET /{path...}` from `pb_public`, when the directory exists, with `--indexFallback` |

Everything that applies to all routes is ported as middleware with upstream's order and IDs: panic recovery, activity logger, `trustedProxy` client IP resolution, CORS (`--origins`), the default body limit (32 MiB, overridden per collection where upstream does), the rate limiter (rules from settings, labels like `*:auth`, `users:create`, `/api/`), gzip, superuser IP allow-list, and auth token loading from `Authorization` (with or without `Bearer `).

## Records list

| Parameter | Behavior |
|---|---|
| `page`, `perPage` | defaults 1 and 30, max 1000 |
| `sort` | comma list, `-` for descending, `@random`, `@rowid`; max expressions as upstream |
| `filter` | [Rules and filters](05-rules-and-filters.md); max 3,500 characters and upstream's expression limit |
| `expand` | dot paths and back-relations `collection_via_field`, max 6 levels, rules applied at every level |
| `fields` | field picker with `*`, `expand.*` and the `:excerpt(maxLength, withEllipsis)` modifier |
| `skipTotal` | when true, `totalItems` and `totalPages` are `-1` and the `COUNT` query is skipped |

Response: `{ "page", "perPage", "totalItems", "totalPages", "items": [...] }`. Hidden fields, `password`, `tokenKey`, and `email` when `emailVisibility` is false and the requester is not the owner or a manager, are omitted exactly as upstream.

## Realtime

- `GET /api/realtime` opens an SSE stream (`text/event-stream`, `Cache-Control: no-store`, `X-Accel-Buffering: no`). The first event is `PB_CONNECT` with `{"clientId":"…"}` (40 characters) and the client ID as the SSE `id`; every event is written as `id:<clientId>\nevent:<name>\ndata:<data>\n\n`.
- `POST /api/realtime` with `{ clientId, subscriptions: [...] }` replaces the topics (at most 1,000, each at most 2,500 characters) and answers `204`. An unknown client is `404`, a request from another IP than the connection's is `400`. The request's auth becomes the client's auth; only a guest client may gain an auth, any other change is `403`, as upstream.
- Topics: `<collection>/*`, `<collection>/<recordId>` (by collection name or id; `<collection>` alone is upstream's deprecated form of `/*`), each with an optional `?options={"query":{…},"headers":{…}}` suffix. The query and headers are applied when checking `listRule` (`/*`) or `viewRule` (`/<id>`), the `filter` query value as an extra filter (with `@request.*` and `@collection.*` for superusers only), and `expand` and `fields` shape the record.
- Messages: event name is the topic as subscribed, data is `{"record":{…},"action":"create"|"update"|"delete"}` (in that key order), sent only to clients whose rule check passes for that record. Superuser subscribers get hidden fields; the auth record's owner, superusers and clients passing the `manageRule` get the email. A delete message carries the record as it was, checked before the delete. View collections get no record events.
- An auth record's update refreshes the auth of its clients (and unsets it when the token key changed); its delete, its collection's delete or a change of the collection's auth token secret unsets it.
- A connection is closed after 5 minutes without a delivered message and after 30 minutes in all; the SDKs reconnect and subscribe again. Broadcasting happens after the write transaction commits, never for a write that rolls back. As upstream, the API response comes after the broadcast's rule checks, subscription filters, email visibility checks and expands, which see the database as that write left it (a delete's as it was right before the row delete, with the expand read inside its transaction); only the sending to the streams follows the response.
- OAuth2 popup flow: `/api/oauth2-redirect` sends the code to the `@oauth2` subscriber, as upstream (M4.5).
- Bun detail: `Bun.serve`'s idle timeout (10 s by default, at most 255 s) would close an idle stream, so the realtime request calls `server.timeout(req, 0)`; no keep-alive comments are sent, as upstream sends none. A client with more than 8 MiB unsent is closed (see the table below).

## Batch

`POST /api/batch` with `{ "requests": [{ "method", "url", "headers", "body" }] }` (JSON or multipart with `requests.N.field` file keys). Runs in one write transaction, only for record create, update, upsert (`PUT`) and delete routes, honoring `batch.enabled`, `maxRequests`, `timeout` and `maxBodySize`. The response is an array of `{ "status", "body" }`. A failure rolls back and returns upstream's error shape with the failing index. Items run synchronously on the transaction ([D28](10-decisions.md#d28-a-batch-runs-synchronously-in-one-write-transaction)); broadcasts and file deletes wait for the commit. Each item goes through what upstream's internal multipart request gives: its URL's query values are form values next to the body, and an uploaded file's stored name holds two random parts.

## Files

- Download checks the record's `viewRule` only for `protected` files, which need `?token=` from `POST /api/files/token`.
- `thumb` values must be in the field's `thumbs` list (or the default `100x100`), otherwise the original is served, as upstream.
- `Content-Type` comes from the `.attrs` sidecar, then sniffing. Risky types (`text/html`, SVG and similar) are served with `Content-Disposition: attachment` and the upstream `Content-Security-Policy`, as upstream.
- Range requests and `If-Modified-Since` behave like Go's `http.ServeContent`.

## Deliberate differences

These are the only intended differences. Each one follows from removing extensions, the `update` command (D19) or automatic HTTPS (D30), or from not porting the system migrations (D15), except the two request normalization rows, which follow from the HTTP runtime (D22), the batch row, which follows from D28, the malformed-input row, which follows from D26, the mail error row, which follows from the SMTP client (`nodemailer`, [Architecture](02-architecture.md)) and D26, the query timeout row, which follows from `bun:sqlite` (D8), the realtime unsent-queue row, which follows from D27 (bounded memory, D26), and the arm64 GIF thumb row, which follows from the platform's floating-point code generation in upstream (D34). Each is marked in the differential test suite; the repeated-header row's case is in `test/differential/records-read/` (M2.4). The query timeout row is about timing, not response content: `test/db/read-pool.test.ts` checks it.

| Area | PocketBase v0.41.0 | iglo.base |
|---|---|---|
| Custom routes from hooks or Go | whatever the app registered | 404, like any unknown route |
| `serve example.com`, `--https` | Let's Encrypt certificates and HTTPS, HTTP redirected to HTTPS | refused at start (D30); TLS belongs to the reverse proxy |
| Hook side effects | hook-modified requests, responses and records | none |
| `GET /_/extensions.js` | concatenated `main.js` of registered UI extensions | empty `text/javascript` body |
| `GET /_/extensions/{name}/*` | extension static files | 404 |
| `GET /api/crons` | built-in and user jobs | built-in jobs only |
| Logs `data` | may include hook-written entries | iglo.base entries only, with upstream's shapes |
| `Server`-identifying output (`--version`) | `pocketbase version 0.41.0` | `iglo-base version <version>` (`(untracked)` for local builds; set by the release build, [releasing](../releasing.md)). The `serve` banner prints no version, as upstream's |
| `migrate down` reaching a system migration | removes its row and runs its down, if any; the next start applies it again | a system migration without a down keeps its row, with the same output: the next start would leave the data as it is. One with a down (`1640988000_init.go`, `1640988000_aux_init.go`, `1763020353_update_default_auth_alert_templates.go`) fails the command before anything changes, because iglo.base has no port of those schema migrations |
| `update` command | downloads and installs a newer PocketBase release | not available; fails with an error ([D19](10-decisions.md#d19-drop-the-update-command)) |
| GIF thumbs on arm64 (`?thumb=` of a GIF original) | exact pixels of the Go resampling and GIF encoder | on linux-arm64 the thumbs of `photo.gif` (mean error 14.6 and 15.6) and of the GIFs with a 600x400 first frame (`gif-subframe.gif`, `limit-gif-screen-at.gif`; 15.554 at 100x100) differ from upstream's (0-255 per channel, measured on GitHub arm64 runners; exact on x64): Go most likely fuses multiplications and additions on arm64, which shifts upstream's resampling in the last bits, and the GIF encoder's error-diffusion dithering turns that into pixels of another palette color ([D34](10-decisions.md#d34-macos-sqlite-built-embedded-and-loaded), [D35](10-decisions.md#d35-linux-only)) |
| Request paths with `.` or `..` segments (also `%2e%2e`) or `\` | `307` redirect to the cleaned path; `%2e%2e` and `\` are not resolved | answered as the normalized path, without a redirect ([D22](10-decisions.md#d22-requests-are-normalized-by-bunserve)) |
| `--queryTimeout` on synchronous reads and reads in a transaction | the statement is interrupted (`sqlite3_interrupt`) at the deadline; other requests go on | the query fails with the same error, `context deadline exceeded; failed query: <SQL>`, but only after its statement returns, and the event loop is blocked meanwhile. Bun 1.4.4's `bun:sqlite` cannot interrupt a statement: no interrupt or progress handler, no `sqlite3*` pointer, and on Linux the embedded SQLite exports no symbols for `bun:ffi` ([D8](10-decisions.md#d8-sqlite-access-main-thread-connection-read-worker-pool-for-timed-reads)). Reads outside transactions through the async resolvers run on the read pool and fail at the deadline, as upstream |
| Malformed or hand-crafted transport input no normal client sends (unusual multipart encodings, chunked bodies at the exact body limit, escapes split at read-buffer boundaries, int64-overflow arguments) | Go's exact error or acceptance | handled safely (no crash, no partial data, no rule bypass, bounded memory); the status code and error text may differ ([D26](10-decisions.md#d26-compatible-results-not-ported-implementations)) |
| Repeated request header lines | `@request.headers.*` sees the first line; a trusted proxy header (`trustedProxy.headers`) is read from its last line | `@request.headers.*` sees the lines joined with `, `; a trusted proxy header is read as the joined list, so with `useLeftmostIP` the leftmost IP of the first line is used, not of the last ([D22](10-decisions.md#d22-requests-are-normalized-by-bunserve)) |
| A realtime client that stops reading its stream | keeps every unsent message for it (a blocked goroutine per message) and delivers them all if it reads again | closes the client's stream once more than 8 MiB are unsent, dropping them; the SDKs reconnect and subscribe again ([D27](10-decisions.md#d27-follow-ups-from-the-m08-spikes)). Covered by `test/realtime/connection.test.ts` |
| `batch.timeout` and a client that goes away during a batch | a running item is abandoned at the deadline (the batch answers `400 Batch transaction failed.` at once), and a closed connection rolls the batch back | the deadline is checked after each item, so a batch past it rolls back with the same response, but only once the running item ends; the event loop is blocked meanwhile, and a closed connection is not noticed while the batch runs ([D28](10-decisions.md#d28-a-batch-runs-synchronously-in-one-write-transaction)). Covered by `test/batch/batch.test.ts` |
| Mail send failures: the `Raw error` text of `POST /api/settings/test/email` (and the logged login alert error) | Go's `net/smtp`, `crypto/tls` and `net` error texts | the same text for a refused connection, an SMTP error reply (`<code> "<text>"`), credentials refused over an unencrypted connection (`unencrypted connection`), a missing `sendmail` and its exit status; other failures (DNS, TLS handshake, timeouts) carry `nodemailer`'s text. An SMTP username with an empty password (or the reverse) fails before AUTH instead of being sent; the send fails either way for a server that checks credentials ([D26](10-decisions.md#d26-compatible-results-not-ported-implementations)). Covered by `test/differential/mail/` |
| `GET /api/backups/{key}` with `backups.s3` enabled, and `GET /api/files/...` with `s3.enabled` | streams from S3 as it reads; an S3 failure part way breaks the `200` response off | the requested bytes reach a temporary file in `.pb_temp_to_delete` first, as Bun drops `Content-Length` on a stream, so the first byte waits for them and takes that disk space; a failure part way answers the API's error (`400` for a backup, `404` for a file) before any byte |
| `POST /api/batch` and an OAuth2 sign-up with files, with `s3.enabled` | a file is uploaded inside the transaction, once its record passed its rules and validation; the upload counts against `batch.timeout` | no network call runs in a transaction, so the files upload before it opens and those no committed record refers to are deleted once it ended. The responses and the objects left are the same, but a request that is then refused has its files in the bucket for a moment (an item only superusers may run, a new record's unusable id and a file over its size limit are not sent), and the upload does not count against `batch.timeout` |
| `$app.newFilesystem()` in a migration with `s3.enabled` | an S3 filesystem | fails with an error that says why: a migration runs synchronously in a transaction and cannot make network calls. On the local storage it is not bound either, as the other file bindings are not |
| S3 network failures: the `Raw error` text of `GET /api/backups`, `DELETE /api/backups/{key}` and `POST /api/settings/test/s3` | Go's `net` and `crypto/tls` error texts | the same text for a refused connection to an IP address and for a request past its deadline; with a host name endpoint a refused connection names the host, not the dialed address, and a DNS or TLS failure has its own text after Go's `Get "<url>": ` prefix. A key with a scheme (`a:b.zip`) stays a plain path, where Go's parser drops it |
| `pb_public` files over 16 MiB (and multi-range responses over 16 MiB) whose type is not text, image, font, audio, video, JSON or WASM (zip, pdf and similar) | no `Content-Disposition` header | `Content-Disposition: filename="<name>"`, which Bun adds to a file it streams from disk; browsers still show or download such files as they would without it. Smaller files are read into memory and match upstream (decided by agents on 2026-11-02, for owner review) |
| The OAuth2 avatar download with `HTTP_PROXY`/`HTTPS_PROXY` set on the server | never uses a proxy | Bun's `fetch` honours them; the address checks still apply to the target |

The JavaScript SDK's `pb.send()` for custom routes keeps working against routes that exist; there just are none beyond upstream's.

## API documentation

The dashboard's built-in API preview (`ui/src/apiPreview`) documents every endpoint and stays accurate, because the API does not change. The dashboard's documentation links point to iglo.base's own user documentation ([D17](10-decisions.md#d17-dashboard-branding-iglobase-only)); where it lives is an [open question](11-open-questions.md). Upstream's [Web APIs reference](https://pocketbase.io/docs/api-records/) for v0.40 describes the same API.
