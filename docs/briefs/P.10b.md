# P.10b State fixes: server lifecycle

Written by the lead on 2026-11-06 (owner request) from a read-only audit of implicit state machines. Each item names where the state lives, the reported defect and the intended fix. The audit read the code but did not run it: **confirm each item on main first**, and compare with upstream v0.41.0. If an item does not reproduce, or the fix would change what upstream answers to a real client's request, leave it and say why in the PR (D26). Every fix gets a test through a public boundary (HTTP, the CLI, files on disk) where one exists; race tests hold a promise open, never sleep or loop. Latent items with no public boundary may go in without a dedicated test; say which.

Owns: `src/cli/`, `src/app/`, `src/server/`, `src/middlewares/`, `src/main.ts` and their tests. `src/server` is a shared contract (work plan): keep its public shape; this task is the lead-approved change to it.

## Items

1. **Restart promise never settles** (`src/cli/serve.ts:173-231`). A second `app.restart` overwrites the local `restart` (`:180-184`), so the first caller's promise never settles and its `revert` never runs. A restart during shutdown returns at `:218` without settling or reverting either. Fix: a single in-flight restart (a second call joins or is refused, match what upstream's `Restart` does), and every exit path settles the pending restart (shutdown → reject or resolve as upstream would, with `revert` run).
2. **Bootstrap teardown without try/finally** (`src/app/bootstrap.ts:313-321`). If `waitForRunning` (`:316`) rejects, the logger, thumbs and databases are never closed. Fix: each teardown step runs even if an earlier one fails; collect and rethrow the errors. Also check the failure path at `:283` (`databases.close()` instead of `shutdown()`): read workers must not survive a failed bootstrap.
3. **NotifyWatcher reload outlives close** (`src/app/notify-watcher.ts:174-193`). `#fire` starts `reload.settings()` without tracking it; `close()` cannot wait for it, and `clearBootstrap` then closes the databases under it. A second event during a slow reload starts a concurrent reload. Fix: track the in-flight reload, run at most one at a time (coalesce events that arrive during it into one follow-up), and make `close()` stop new reloads and await the running one before teardown continues.
4. **Size-limit error cleared by `reread()`** (`src/middlewares/body-limit.ts:174-179`, `src/server/rereadable-read-closer.ts:62-75`). `MaxBytesReader.reread()` resets `#remaining` and clears `#stickyErr`, so a reread after an over-limit read parses a truncated prefix as a valid body. Fix: an exceeded limit stays exceeded for the request. Also check `request.ts:93-176`: after a multipart parse error a second parse call skips `parseForm` and drops the original error; keep the first error.
5. **ResponseWriter and gzip** (`src/server/router.ts:147-216`, `src/middlewares/gzip.ts:21-114`). `writeBody(blob)` then `flush()` drops the body (`flush` sends only `#chunks`); a `flush()` from a fresh writer leaves `status()` at 0 while 200 is sent; writes after `finish()` are silently lost. The gzip wrapper overrides `write`/`writeHeader`/`flush` but not `writeBody` or `afterResponse`, so a `writeBody` under gzip sends an empty body and `afterResponse` cleanups (temp files) never run. Fix all four; keep upstream's observable headers and status codes.
6. **Unsettled request on a panic** (`src/server/serve.ts` `handleRequest` rejection path, around `:279-289`). If `rw.finish()` throws there (an invalid status makes `new Response` throw), `reject(err)` is skipped and the request never settles. Fix: settle on every path.

## Out of scope

Middleware chain second `next()` and the cached `RequestInfo` body (upstream behavior), the rate-limit store lifecycle.

## Verification

Targeted `bun test <files>` while working. The full `bun run check` and then `bun run test:reference` run once at the end, each wrapped in the host's heavy-check lock (three P.10 workers share the host): `flock /home/t3-code/.local/state/iglo-base-cos/heavy-check.lock bun run check`, and the same for `test:reference` (background Bash plus Monitor; it takes over 10 minutes).

Worker rules from `docs/design/12-work-plan.md` and the worker instructions in `docs/chief-of-staff.md` apply. Branch `task/P.10b-server-lifecycle-state`, one PR titled "P.10b: State fixes: server lifecycle" against `main`; do not merge.
