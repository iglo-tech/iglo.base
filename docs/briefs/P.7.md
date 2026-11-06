# P.7 Backlog sweep

Written by the chief of staff on 2026-11-06, after P.6 (#75) merged. Small items from `docs/status.md` (Done rows and the hardening backlog) that a real client or operator can hit, or that are plain cleanups. Each item: confirm it still exists on main, fix it with a test through a public boundary (HTTP, CLI, files on disk, the S3 test server, `pb_data` read back by upstream), and remove or update its status row. If an item turns out to be wrong, larger than a day, or a deliberate difference, say so in the PR and leave it.

## Items

1. **`-wal`/`-shm` after a normal stop** (M5.9 backlog). Upstream leaves no `data.db-wal`/`-shm` (or `auxiliary.db-*`) after a clean shutdown; iglo.base does. Close every connection (main thread, read workers, log writer) so SQLite checkpoints and removes them on SIGINT/SIGTERM. Test: stop the executable cleanly, then the directory listing matches upstream's after the same steps.
2. **Restore marker after a failed rollback** (M5.9): a new restore after a failed rollback can drop the first one's marker in `.pb_temp_to_delete`. Make the second restore refuse or keep the first marker; test with the existing SIGKILL suite's helpers.
3. **`toApiError` no-rows** (M4.5): a bare no-rows error from the db layer answers 400 where upstream answers 404; fixed only in the OAuth2 handler. Fix it in `toApiError` itself, find every handler that relied on the local fix, and add differential cases for the handlers where a client can reach it.
4. **JS migration file clear on S3** (M5.4b): `app.save` that clears a file under `migrate up` on S3 leaves the object in the bucket because the delete is not awaited before the CLI exits. Await pending file deletes before exit.
5. **`Vary: Origin` on file responses** (CORS backlog row): check whether M5.7 fixed it; if not, match upstream.
6. **Log writer docs** (M7.1b): the docs say logs are "never dropped" but the writer gives up a batch after 12 retries. Make the docs true (do not change the retry policy).
7. **Dashboard Crons page text** (P.5): it still says jobs are registered with Go or JS. Add a vendored-UI patch (docs/design/08-admin-ui.md) with iglo.base wording, and check it with `agent-browser` (named session).
8. **Test harness**:
   - File-name normalization in `test/differential/files/files.test.ts` and `harness/compare.ts` accepts any equal-length lowercase alphanumeric difference; restrict it to upstream's generated 10-character suffix.
   - SDK OAuth2 token flake (P.6 backlog): two sign-ins in one second can give equal tokens on one server only; compare what upstream fixes, not the token bytes.
   - Stale comment in `test/browser/support.ts` (P.5).
9. **8 test-coverage gaps** from the M5.8 review comment on PR #56 (`gh pr view 56 --comments`): MFA `mfaId` as a query option, batch upsert-update path, unrecorded OAuth2 redirect and the rest. Add each as a differential or SDK case.

## Out of scope

The Migrations `DynamicModel`/Go-type rows, OAuth2 hand-made-token text rows, S3 malformed-XML rows, backups stall rows and the other D26 exotic-input rows stay in the backlog. macOS is gone (P.9).

## Verification

`bun run check` and `bun run test:reference` locally, one after the other (check `pgrep -f "bun test"` first; another agent may be running). No CI run needed. Changes to file handling (item 4) need before/after numbers under `docs/perf/` only if they touch a hot path; say which.

Worker rules from `docs/design/12-work-plan.md` apply. One PR against `main`; do not merge.
