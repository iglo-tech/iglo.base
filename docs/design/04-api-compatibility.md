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

Compared semantically: JSON is compared after parsing, except values from `json` fields, which must be byte-identical. Header order and JSON whitespace are not compared. Generated IDs, tokens and timestamps are compared by format, not value.

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

- `GET /api/realtime` opens an SSE stream. The first event is `PB_CONNECT` with `{"clientId":"…"}` and the client ID as the SSE `id`.
- `POST /api/realtime` with `{ clientId, subscriptions: [...] }` sets the topics. The request's auth becomes the client's auth; a different auth on a later call is rejected as upstream.
- Topics: `<collection>/*`, `<collection>/<recordId>`, each with an optional `?options={"query":{…},"headers":{…}}` suffix that is applied when checking `listRule`/`viewRule` and expanding the record.
- Messages: event name is the topic, data is `{ "action": "create" | "update" | "delete", "record": {…} }`, sent only to clients whose rule check passes for that record, with `expand` and `fields` from the subscription options.
- Idle timeout 5 minutes without subscriptions, maximum connection time 30 minutes, after which clients reconnect (the SDKs do this already). Broadcasting happens after the write transaction commits.
- OAuth2 popup flow: `/api/oauth2-redirect` sends the code to the `@oauth2` subscriber, as upstream.
- Bun detail: `Bun.serve` has a global `idleTimeout` limit of 255 seconds; realtime responses call `server.timeout(req, 0)` and send keep-alive comments as needed.

## Batch

`POST /api/batch` with `{ "requests": [{ "method", "url", "headers", "body" }] }` (JSON or multipart with `requests.N.field` file keys). Runs in one write transaction, only for record create, update, upsert (`PUT`) and delete routes, honoring `batch.enabled`, `maxRequests`, `timeout` and `maxBodySize`. The response is an array of `{ "status", "body" }`. A failure rolls back and returns upstream's error shape with the failing index.

## Files

- Download checks the record's `viewRule` only for `protected` files, which need `?token=` from `POST /api/files/token`.
- `thumb` values must be in the field's `thumbs` list (or the default `100x100`), otherwise the original is served, as upstream.
- `Content-Type` comes from the `.attrs` sidecar, then sniffing. Risky types (`text/html`, SVG and similar) are served with `Content-Disposition: attachment` and the upstream `Content-Security-Policy`, as upstream.
- Range requests and `If-Modified-Since` behave like Go's `http.ServeContent`.

## Deliberate differences

These are the only intended differences. Each one follows from removing extensions or the `update` command (D19), except the two request normalization rows, which follow from the HTTP runtime (D22). Each is marked in the differential test suite.

| Area | PocketBase v0.41.0 | iglo.base |
|---|---|---|
| Custom routes from hooks or Go | whatever the app registered | 404, like any unknown route |
| Hook side effects | hook-modified requests, responses and records | none |
| `GET /_/extensions.js` | concatenated `main.js` of registered UI extensions | empty `text/javascript` body |
| `GET /_/extensions/{name}/*` | extension static files | 404 |
| `GET /api/crons` | built-in and user jobs | built-in jobs only |
| Logs `data` | may include hook-written entries | iglo.base entries only, with upstream's shapes |
| `Server`-identifying output (`serve` banner, `--version`) | PocketBase | iglo.base, with the PocketBase compatibility version (`compatible with PocketBase v0.41.0`) |
| `update` command | downloads and installs a newer PocketBase release | not available; fails with an error ([D19](10-decisions.md#d19-drop-the-update-command)) |
| Request paths with `.` or `..` segments (also `%2e%2e`) or `\` | `307` redirect to the cleaned path; `%2e%2e` and `\` are not resolved | answered as the normalized path, without a redirect ([D22](10-decisions.md#d22-requests-are-normalized-by-bunserve)) |
| Repeated request header lines | `@request.headers.*` sees the first line | sees the lines joined with `, ` ([D22](10-decisions.md#d22-requests-are-normalized-by-bunserve)) |

The JavaScript SDK's `pb.send()` for custom routes keeps working against routes that exist; there just are none beyond upstream's.

## API documentation

The dashboard's built-in API preview (`ui/src/apiPreview`) documents every endpoint and stays accurate, because the API does not change. The dashboard's documentation links point to iglo.base's own user documentation ([D17](10-decisions.md#d17-dashboard-branding-iglobase-only)); where it lives is an [open question](11-open-questions.md). Upstream's [Web APIs reference](https://pocketbase.io/docs/api-records/) for v0.40 describes the same API.
