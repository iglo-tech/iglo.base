# U.1 Server: baseline v0.42.3

Written by the chief of staff on 2026-11-20. Decision record: [D43](../design/10-decisions.md#d43-baseline-moved-from-v0410-to-v0423); read it first, it lists every upstream change and what is not ported. **Base branch: `main`.** Ships in v1.3.0 with U.2.

## 1. Pin v0.42.3

- `test/differential/upstream.lock`: tag `v0.42.3`, commit `c5003ce63deee71cc6821f338f0d4e1994b3db40`, download base `https://ganigeorgiev.com/meta/pocketbase/pocketbase/download/v0.42.3`, the `pocketbase_0.42.3_*` archives. Download each archive from the forge, compute its SHA-256 yourself and pin it (linux-x64, linux-arm64, darwin-arm64 as today). Nothing else in the lock changes.
- `bun run upstream:prepare` then gives the v0.42.3 binary and source in `.upstream/`. Read upstream from there; `/home/t3-code/upstream/pocketbase` stays at v0.41.0 and is useful only for `git diff`-style comparison by eye. The upstream diff for this task: `apis/base.go`, `apis/middlewares.go`, `apis/realtime.go`, `apis/record_auth_with_oauth2_redirect.go`, `core/base.go` (logger init and `__pbLogsCleanup__`), `core/log_query.go` (`CountLogs`), `tools/filesystem/filesystem.go`.

## 2. Port the server changes

Each needs a test through a public boundary that fails on `main`; the differential suite against v0.42.3 is the reference.

1. **401 on unknown tokens** (`rejectUnknownToken`): a request whose `Authorization` header (with or without `Bearer `) is non-empty but loads no auth record gets upstream's 401 body. It applies after the token is loaded and before route handlers, on every route the router serves. Check against upstream which routes and methods it reaches (API, `/api/files/`, `/api/realtime`, `/_/`, `pb_public` static, CORS preflight, the health endpoint, batch), and the error body and headers. Fix any of our own tests or harness code that sends a stale token and expects guest results.
2. **Realtime IP checks:** remove the IP check from setting subscriptions; store the IP of the first lone `@oauth2` subscription; the OAuth2 redirect accepts the connection IP or that subscription IP; failures in that handler log at WARN with upstream's messages and attributes.
3. **Logs cleanup cron:** count, delete old logs, count; run `VACUUM` on `auxiliary.db` once 50,000 or more logs were deleted since the last one (a counter in the app instance, not process-global), then `PRAGMA wal_checkpoint(TRUNCATE)` after every run. Failures log at WARN. Test with the injected clock. Settings-save logs cleanup failures log at WARN as upstream now does.
4. **Request log entries:** `logRequest`'s new attribute order and the "OK state" rule: status 200–399 with no error or a benign error logs at INFO (with the `(often benign, see #8361)` suffix on the error), everything else at ERROR, and the skip-success-log flag applies only in the OK state. Bun's errors are not Go's: find what Bun gives us when a client disconnects mid-response and treat that as the benign case, if iglo.base logs it at all. Compare stored `_logs` rows with upstream's for the same requests.
5. **Files:** `image/jxl` in the inline-serve content types; the thumbnail "too large" error text adds `(you can set the env 'PB_THUMBS_MAX_SOURCE_PIXELS=max' to change the limit)`.

Not ported: see D43. The S3 multipart body check is already in `src/tools/filesystem/internal/s3blob/s3/uploader.ts`.

## 3. Baseline references

- Update every place that names the reference version as the current baseline to v0.42.3: `AGENTS.md` (not "Current state", U.2 does that), `docs/design/` (README, 03, 04 and others; history in decision records stays as written), `scripts/upstream/prepare.ts`, header comments of differential tests, and `src/` comments that say "v0.41.0" about current behavior. Leave history (decision records, perf docs, briefs, status) alone.
- `docs/design/04-api-compatibility.md`: check every deliberate difference still holds against v0.42.3; drop or rewrite ones that changed.

## 4. The dashboard

The vendored `ui/` stays at v0.41.0 in this task; U.2 re-copies it. If a dashboard differential test (`test/differential/ui/`) fails only because upstream's v0.42.3 dashboard differs from ours, skip that case with a comment starting `// U.2:` saying why, and list each in the PR body. Nothing else may be skipped.

## Verification

- `bun run check`, then `bun run test:reference`, one after the other. Report each exit code and counts.
- The worker instructions in `docs/chief-of-staff.md` apply.
- Open a PR titled "U.1: baseline v0.42.3 (server)" against `main`. Do not merge.
