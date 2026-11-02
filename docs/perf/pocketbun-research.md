> **Owner decision, 2026-11-02:** multi-process and multi-thread serving (items 6 and 7 below) are dropped. M7.1 profiles first and fixes what the profile shows (items 1–5).

# Research: pocketbun, and "more threads" for iglo.base (input to M7.1)

Date 2026-11-02. Research only: no source changed. Host: Ryzen 5 1600, 6 cores, Bun 1.4.4, other work running (large spread).

## 1. pekeler/pocketbun

Read as untrusted data from a shallow clone in a temp directory. Nothing of it was installed or run.

### Facts

| | |
|---|---|
| License | MIT (`LICENSE.md`), "Copyright (c) 2026 - present, Christian Pekeler". Borrowing is allowed with that notice kept. Caveat: the root `LICENSE.md` carries no PocketBase (Gani Georgiev) notice; only the `vendor/*` copies and the README credit PocketBase. Our `LICENSE` already has PocketBase's. Any file we copy should say "adapted from pocketbun (MIT, C. Pekeler)". |
| Target | PocketBase v0.41.1 (`pocketbase_tag.txt`), package `0.41.0-pocketbun.0`/`0.41.1-pocketbun.0`; the README's numbers are for v0.40.0. |
| Size | 583 `.ts` files, 176 k lines, one commit in the clone (history squashed). Claims all upstream tests ported except 2 (self-update). |
| Shape | A library, not an executable-only port. Keeps hooks, `pb_hooks`, custom routes, `app.store()`, JS VM bindings (`src/plugins/jsvm`), async API extensions. All of that is out of scope for us (D5). It is installed with `bun add pocketbun`; there is no `bun build --compile` artifact (`build` script is `bun build --target bun --packages external`). |
| Maturity | README says "NOT recommended for production". Differences to upstream are documented (`docs/users/differences.md`): "async API extensions", thumbnails, logs, templates, SQL helpers. We cannot assume results match v0.41.0 byte for byte; our differential suite would be the judge. |

### Performance architecture

| Area | pocketbun | Reading for us |
|---|---|---|
| HTTP | Plain `Bun.serve({ hostname, port, reusePort: clusterReusePort(), idleTimeout: 255, maxRequestBodySize, fetch })` (`src/apis/serve.ts:227-285`). One `fetch` handler, no `routes` table, no other tuning. | Nothing to borrow in single-process serving. |
| SQLite, in one process | No worker pool. Two `bun:sqlite` connections on the main thread: a "concurrent" one for SELECT/WITH and a "nonconcurrent" one for writes (`src/core/db_builder.ts`, `DualDbBuilder`), all reads synchronous. Pragmas as upstream (`src/tools/dbx/connect_pragmas.ts`: busy_timeout 10000, WAL, journal_size_limit 200000000, synchronous NORMAL, foreign_keys ON, temp_store MEMORY, cache_size -32000; same as our `src/db/connect.ts`). Statements through `db.query()` (Bun's statement cache). | This is the main-thread model D8 rejected for slow-read isolation (M0.6). It has no `--queryTimeout`. Not borrowable; it shows how little they depend on workers for speed. |
| Write contention | Lock-retry helpers with immediate intervals `[0,1,2,4,8,16,32,64]` ms up to 10 s, plus an async variant that yields the event loop (`src/core/db_retry.ts`, `execLockRetry`). Same as upstream `core/db_retry.go` and our `src/db/retry.ts`. | Same as ours. |
| Scaling | `node:cluster` fork of N full app processes (`src/internal/cluster/primary.ts:236`), sharing the port with `reusePort` on Linux, consecutive loopback ports on macOS and Windows. The primary does not serve HTTP or open databases. Each worker has its own SQLite connections, collection cache and settings; one worker is "leader" and runs migrations, cron and temp cleanup. 6.6 k lines (`src/internal/cluster/*`), 1,363 + 1,793 test lines. | The only technique that moves HTTP/JSON/rules off a single event loop. See sections 2 and 3. |
| Cross-process state | A coordinator in the primary over `process.send` (`protocol.ts`, `coordinator.ts`, `expiring.ts`) with these operations: `rate-limit.consume-batch` and `check`, `expiring.claim/release/put/take` (one-time tokens, OAuth2 state), `realtime.publish/prepare/presence/subscribe`, `oauth2.deliver`, `backup.acquire/release/phase/file-write/file-delete`, `lifecycle.restart`, `restore.begin/complete/abort`. Settings and collection changes use upstream's notify mechanism to reload caches in the other workers. | A complete checklist of what breaks when the app is split into processes. Worth reading as a design, not copying (it is built on its hook system). |
| Realtime | Each worker holds its own SSE clients. The writer worker sends the record JSON to the primary (`realtime.publish`; for deletes a `prepare` then `delete.commit/abort`, so the pre-delete state can be matched), the primary delivers it to every other worker, which matches its subscriptions and applies the rule checks with its own cache. | Fan-out cost moves to the primary plus a JSON copy per worker. Relevant to our 1,000-connection bar. |
| JSON | `JSON.stringify(this.publicExport())` (`src/core/record_model.ts:843`); keys sorted by `deterministicJSONStringify` (`src/internal/compat/deterministic_json.ts`: a recursive copy and sort, then `JSON.stringify`). | Slower than our approach (we write JSON from the record's own encoding, M2.4). Nothing to borrow. |
| bcrypt | `Bun.password.hash`/`verify` (async, Bun's thread pool) in the async paths (`src/core/field_password.ts:283,317`); `hashSync`/`verifySync` kept for sync paths. | Confirms the cheap fix for our bcrypt gap: use the async forms (M0.8 proposal), no worker needed. Our `src/tools/crypto/bcrypt.ts` also rewrites the `$2b$`→`$2a$` prefix, which they may not. |
| Multipart | `src/internal/compat/request_form_data.ts`: Bun's `Request.formData()` plus a request-scoped parser that spools file parts to a temp directory (`StoredMultipartFormData`, 64 KiB high-water mark), to bound memory. | Same aim as our D27 spill. Our Go-port parser (`src/server/multipart.ts`) is chosen for byte-for-byte results; their approach is the `formData()` path we dropped for correctness. |
| Log writes | `LogWriter` offloads log inserts to a Bun `Worker` (`src/tools/logger/log_writer.ts`, `log_writer_worker.ts`). | Possible small win for our logs buffer (writes to `auxiliary.db` happen on the main thread today); low priority. |

### Published numbers (README, `benchmarks/results/pb_compare_20260827T213751Z_external_scaling/summary.md`)

Method: the 150-scenario PocketBase benchmark project suite (`vendor/pocketbase-benchmarks`, create/auth/search/custom/delete); 3 runs per configuration; each value is the sum of per-scenario medians; an external Bun load generator; a 1,000-request warm-up that they say PocketBun needs and PocketBase does not; PocketBase with `GOMAXPROCS=N`, PocketBun with `--workers=N`; Hetzner CCX13/23/33 hosts for 1–2/3–4/5–8 lanes; PocketBase v0.40.0, Bun 1.4.0. Only their own reported numbers; we did not reproduce them.

| Lanes | Whole suite, PocketBase / PocketBun | High-concurrency subset | Read phase |
|---|---|---|---|
| 1 | 1,204 s / 529 s (2.28×) | 51.9 s / 14.6 s (3.6×) | 898 / 395 s |
| 4 | 624 s / 284 s (2.20×) | 14.2 s / 5.9 s (2.4×) | 495 / 193 s |
| 8 | 485 s / 189 s (2.56×) | 15.5 s / 2.8 s (5.5×) | 370 / 116 s |

Caveats: this is a lane sum (latency of serial scenario sets, high concurrency in a few), not our p50/p95 at 50 clients; a different upstream version; the benchmark suite has "known fluctuations" (their words). The 1-worker win over upstream comes from workload shape (hooks/JS routes are Go-VM against native Bun; the `custom` phase is 120 s vs 32 s) rather than a faster core. Their own README admits that single-process warm-up matters.

## 2. "More threads" for iglo.base

### Measurements (this host, not a baseline for the bar)

Setup: `bun run build` from this branch (nodemailer stubbed locally because the sandbox has no npm; mail unused), a copy of `test/fixtures/pocketbase` with 200 extra `demo2` rows inserted into the copy; the load tool is a 3-line Bun `fetch` loop (keep-alive, 2 s warm-up, 8 s run) on the same machine. Guest list `GET /api/collections/demo2/records?perPage=30`. The multi-process rows run 3 independent executables on ports 28431–28433 on the same `pb_data` copy, with the client spreading connections across the ports. That is what `reusePort` would give, minus coordination (reads only).

| Workload | 1 process | 3 processes |
|---|---|---|
| list 30, 8 clients | 719 req/s, p50 8.9 ms, p99 51 ms | (not run) |
| list 30, 32 clients | 574 req/s, p50 42 ms, p99 193 ms | 1,465 req/s (2.55×), p50 17 ms, p99 88 ms |
| `/api/health`, 32 clients | 9,712 req/s, p50 2.1 ms | 7,861 req/s (client-bound; the load tool shares the 6 cores) |
| RSS | about 160–190 MiB under load | about 117–129 MiB each, about 370 MiB for 3 |

A `top -H` sample during the single-process list load shows the main thread at 45 % in the snapshot, with 4.4 s of CPU time after about 5 s of load (nearly one full core), against 0.25 s for a read worker and 0.06 s for a GC helper thread. The workers do almost nothing: the SQLite statements are cheap, and the main thread is saturated by everything else (routing, rule resolution, record hydration, JSON, response). That agrees with M2.4 ("everything except the SQLite statements runs on one event loop"). More read workers cannot help this workload. Idle: 4 workers at about 12 MiB each already exist.

The single-process list number here (574–719/s) is lower than M2.4's 958–1,090/s because of the shared client, different rows and host noise; use ratios only.

### (a) Several processes sharing the port (`reusePort`)

What it fixes: everything that is CPU on the main thread, as measured: about 2.5× on list at 3 processes, near-linear until the SQLite writer or the 6 cores bound it. It is also the only option that also helps expand JSON, rule evaluation, multipart intake and bcrypt at the same time (they spread over processes).

Costs and what is per-process today (all of it breaks silently if two processes run):

| State | Today | With N processes |
|---|---|---|
| SQLite writer | One write connection per file on the main thread; writes and transactions are synchronous (D8, D28). | N writers on one WAL file: SQLite allows one at a time. Writers wait in `busy_timeout(10000)` plus the lock-retry (`src/db/retry.ts`); no deadlock for plain `BEGIN`, but `BEGIN` that upgrades to write after a read can return `SQLITE_BUSY` immediately (WAL snapshot conflict) and is not retried by busy_timeout. Batch (D28) runs reads inside the transaction; those need `BEGIN IMMEDIATE` (check `src/db/tx.ts`). Write throughput per file does not scale; fairness is lost (busy-wait with sleeps). |
| Realtime broker | In-memory clients and subscriptions (`src/realtime/*`); the writer fans out after commit. | Needs cross-process publish, a delete-prepare/commit protocol, and presence (pocketbun: `realtime.*`). SSE connections stay on one process each, so fan-out of 1,000 connections splits across workers. |
| Collections cache, settings | Loaded at bootstrap, reloaded by the same process's saves. | A save in process A must reload B (upstream has no multi-process case; pocketbun's "notify"). A version counter row would break the data contract (no iglo tables or `_params` rows, AGENTS.md); it must be a socket or `PRAGMA data_version`-style polling. `PRAGMA data_version` polling does not break the contract. |
| Rate limiter | Fixed-window maps in the app store (`src/middlewares/rate-limit.ts`). | Per-process counts multiply the allowance by N; needs a central counter (pocketbun batches through the primary). |
| Cron, auto-backup, temp cleanup, log cleanup | Started in the one app (`src/app/crons.ts`, `src/backups/autobackup.ts`). | Must run in one process only (leader). |
| Backup / restore lock | An app-store key (`active backup`). A restore replaces `data.db` and restarts the app. | Cluster-wide lease and drain; restore must stop every process (pocketbun: `backup.*`, `restore.*`, `lifecycle.restart`). |
| Logs buffer | In-memory batch flush into `auxiliary.db` (`src/logs/batch-handler.ts`). | Per process, harmless but N more writers on the same file. |
| One-time state | OTP, OAuth2 redirect/state, verification, file tokens | Stateless signed tokens are fine; the OAuth2 realtime-delivery (`oauth2.deliver`) and any in-memory claim need a shared place. |
| CLI / dashboard / `--dir` | One process. | A supervisor process, signals, SIGTERM drain, crash loop handling; `bun build --compile` + `node:cluster` is untested here (pocketbun ships `scripts/repro/bun_issues/cluster_runtime_probe.ts`, which hints at runtime quirks). |

Memory: about 120–130 MiB RSS per process here plus 4 read workers each (up to about 12 MiB idle, 40 MiB warm); on a 2 GiB VM minimum 2–4 processes is a real cost; default must stay 1.

Size of work: pocketbun's coordinator and worker/primary alone are about 2.3 k lines (state, protocol, primary, worker) plus 3 k lines of tests, built on their hook system. Ours would be smaller (no hooks) but touches realtime, rate limit, collections cache, backups and the lifecycle. It is the largest item here and the only one that changes D8's premise.

Expected gain: list/view/expand/create at 50 clients, roughly ×N up to the core count minus load generator; writes (create/update) only until the writer saturates (upstream is also serialized by SQLite, and M3.1 shows us at 40 % of upstream at 8 clients mostly because of main-thread CPU, which this would relieve). Health bursts: bound by connection handling in Bun, would scale.

### (b) More read workers, or moving request handling into workers

- More read workers: no effect on the measured gap (workers are idle, see top). Raising `defaultReadWorkers` only helps slow queries (D8's reason) and costs 12–40 MiB each.
- Moving JSON/expand/rule checks into workers: the work is not in `bun:sqlite` calls but in JS that builds Records from rows, resolves relations and formats. To do it in a worker the worker needs the collections cache, settings (secret keys), the record model and the field code, plus a copy of the auth context per request. Structured clone of rows costs 0.06–0.11 ms per hop (D8 measurement) against 0.2 ms for the JSON of a 30-row list: the hop eats most of the saving for lists and wins only for large expands. A "read-only app clone per worker" is effectively (a) inside one process: the same cache coherence problem (collections, settings reload) but without a port sharing, process supervision or a second writer. It gives parallelism for GET handlers only, while writes stay on the main thread (as the owner suggested) and the single-process model (realtime, rate limiter, cron, backups) survives. Costs: handler code needs a worker-safe entry (rule resolution without the live app), auth loading (token verify needs secrets), and every GET route that reads data would need to be routed there. `Bun.serve` cannot hand a connection to a worker, so the main thread still parses HTTP and posts requests and responses (copy of body bytes): the main thread still pays HTTP and the clone cost; the gain is limited to the work between those. No measurement made; estimate: 1.5–2× on list/expand at most, with high complexity and risk of divergent results. Not recommended before the cheap items below.
- A middle option is what Bun itself offers: `Bun.serve` in several Workers with `reusePort` in the same process. Not verified here whether Bun lets Workers share a port with `reusePort`; if it does, the workers would each own a copy of the app (same state problems as (a), but a shared address space, with `SharedArrayBuffer` possible for counters). It saves the supervisor and IPC (`postMessage` instead of `process.send`) and a shared executable image, but not the per-worker app memory, and a Bun worker crash can take the process down. Untested here. Treat as (a) with a different carrier; the design is the same.

### (c) Offloading bcrypt and multipart

- **bcrypt**: cheapest and decided already (D27). `Bun.password.hash/verify` run on Bun's thread pool, so no JS worker is needed; verified in pocketbun and in M0.8's proposal. Expected: 8 concurrent cost-12 sign-ins go from 1.9 s of blocked event loop to about the 0.4 s of upstream (6 cores), and `/api/health` during them from 1.9 s to ms. Constraint: our hashing happens in the `PasswordField` setter (synchronous like upstream's), so the async form needs the hash computed before the save (an async step in the record-upsert/save chain, which is already generator-based and can yield on a promise: `src/records/record-save.ts` "run synchronously until a field interceptor returns a promise"). That is the seam to use; it keeps results identical. Risk low, no design record needed beyond D27.
- **multipart**: the cost is the JavaScript port of Go's `mime/multipart` (`src/server/multipart.ts`): 15 µs per part, 16 ms for 1,000 small values, 20 ms for a 10 MiB file (M3.1). A worker would need the body bytes copied or transferred (`ArrayBuffer` transfer is zero-copy) and results sent back (small values copy; file parts that spill to temp files are cheap). For typical forms (a few parts, 0.1–0.3 ms) the hop costs as much as the parse; for many small values or big files a worker pays. Better first: a fast path in the parser for the common case (CRLF lines, no continuation headers, boundaries found with `indexOf` on bytes), as M3.1 already notes; same results. Worker offload only for bodies above a size threshold (say 1 MiB), not for typical requests.

## 3. Recommendation for M7.1

Ranked by expected effect over risk. "D" marks items needing a decision record.

| # | Change | Expected effect | Risk | Decision |
|---|---|---|---|---|
| 1 | bcrypt off the event loop: async `Bun.password.hash/verify`, hash before save via the generator seam (M0.8 proposal, D27) | Sign-in/create-with-password no longer blocks other requests (1.9 s → ms of loop lag at 8 concurrent cost-12) | Low; results unchanged (158 cross-checks exist) | No (D27 covers it) |
| 2 | Profile the main thread on the list path and cut CPU per request: one `bun --cpu-prof` of the compiled build under `records-read/bench.ts` at 8 and 50 clients, then fix the top items (nested expand re-formatting `Record.marshalJSON` at each level, `src/tools/types/go-json.ts`; rule/filter parse and resolver caches; per-request allocations in the event/middleware chain; header copying) | The gap is main-thread CPU, so every percent here is throughput; nested expand JSON 1 ms → about 0.3 ms is plausible; `/api/health` 7–9.5 k → closer to 13 k by trimming the per-request middleware chain | Low to medium; contract-neutral, covered by the differential suite | No |
| 3 | Multipart fast path for the common case, size-gated worker only for large bodies | Small forms back to about 0.05–0.1 ms; large uploads unblock the loop | Medium (byte-exact semantics of Go's reader; fuzz against upstream) | No (D27) |
| 4 | Backup speed on incompressible data: check compression level and whether the worker uses `level 0`/store for incompressible entries, compare with Go's `archive/zip` default | About 2× → 1× if the cost is deflate | Low | No (check D-record for backups first) |
| 5 | Logs: move the `_logs` batch insert to a worker | Fewer main-thread stalls under write load (pocketbun does this) | Low-medium (ordering, flush on shutdown, `--queryTimeout` on logs reads) | No |
| 6 | Multi-process serving (`reusePort`) as an opt-in, default 1: supervisor, leader election for cron/backups/migrations, cross-process realtime, rate limiter, collections/settings reload by `PRAGMA data_version` polling, restore drain | About 2.5× at 3 processes on list (measured, no coordination), near-linear until cores; the only way to meet the 1.5×-at-50-clients bar on a read-heavy mix if item 2 is not enough; costs about 120 MiB per process | High: changes the single-process model, adds a coordinator (pocketbun needed about 2.3 k lines plus 3 k test lines), a second class of bugs (stale caches, lost realtime events, rate limits multiplied), `BEGIN` upgrade `SQLITE_BUSY` risk, restore and backup lease; the compiled executable under `node:cluster` is unverified | **Yes: a new D-record** that amends D8 ("the one write connection on the main thread" becomes "one write connection per process, serialized by SQLite") and the "single process" assumption (and the `workers` flag must be a documented option in `docs/design/04` / 02). Do a spike first (below) |
| 7 | In-process request handling in workers (read-only app clones) | Uncertain, at most 1.5–2× on GET lists; main thread still pays HTTP + hops | High, a parallel code path for each GET route; same cache-coherence work as 6 | **Yes** (changes D8's "synchronous reads on main thread" for requests); not recommended; if parallelism is wanted, 6 is better value |
| 8 | More read workers by default | None on the measured gap; worse idle RSS | Low | No |

Suggested order for M7.1: do 1 and 2 first, re-run `test/perf/records-read/bench.ts` at 8 and 50 clients against upstream, and only then decide on 6. Two cheap spikes to settle 6 before writing its D-record: (i) `Bun.serve({ reusePort: true })` in two processes of the compiled executable on Linux (does `bun build --compile` work with `node:cluster` fork or with the executable re-launching itself, `Bun.spawn(process.execPath, …)`?); (ii) two writers on one `data.db`: `bench.ts` creates at 8 clients through two ports, counting `SQLITE_BUSY`/"lock retry timeout" outcomes and p99.

Honest answer to the owner's idea: "just use more threads" is right in direction, but threads inside the process do not help (the cost is JS on the main thread, and `bun:sqlite` calls are a small share); the gain comes from separate event loops, i.e. processes, and that brings back the state problems in section 2. Items 1 and 2 first, because they are also needed under any multi-process design.

## Cleanup note

The benchmark used a temp copy of the fixture and a local build with a stubbed `nodemailer` in this worktree's untracked `node_modules/` and `dist/`; both were removed with the temp directories. No tracked file changed except this report.
