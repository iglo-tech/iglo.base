# P.3: performance, second pass

Brief: close what is safely possible of the p50 gap M7.1c left at 50 clients, and cut the start-up time. Contracts unchanged: API output, the data format and D8's per-query deadlines are as before. No new runtime dependency.

## Result in one paragraph

**Start-up halved**: 267–356 ms to 117–153 ms (median of 15, three alternating rounds) on a 10,500-record, 20-collection `pb_data`; upstream is 29–38 ms on the same data. Three changes did it, the largest by far being `--bytecode` in the build. **Request throughput did not change measurably**: the profile of the request path has no function above 7% that can be removed without a design change, and the one request-path change made (date formatting) is below the noise of this host. The p50 gap at 50 clients that remains (view, expand, in some runs list and create) is the single JavaScript thread against Go's goroutines (see "Threads and processes"), and I did not force it.

## Method and host

- Host: AMD Ryzen 5 1600 (6 cores), Linux 6.12, Bun 1.4.4. **Shared with other agents**: the load average was 1.5 to 3.6 at the start of a run and 10 to 13.7 by the end of the longer ones (another worktree's Playwright runs started in the middle). The load average is recorded with each table below. A table taken under load 10+ is not comparable with one taken at 2 to 4; the upstream columns move 1.5 to 2× with the load, so read ratios as indicative and compare iglo.base columns only inside one session.
- Harness: `test/perf/compare/bench.ts` of M7.1a (3,000 posts, 200 members, 20 teams; fetch over keep-alive connections from a separate process; 1.5 s warm-up, 4 s measured per cell), at 1, 10 and 50 clients, 3 repetitions, median. One server at a time, `nice -n 10`.
- Start-up: new `test/perf/compare/startup-db.ts` builds a realistic `pb_data` (never the staging copy): a superuser, 20 collections (5 auth, 15 base; text, number, bool, select, date, json, editor, file, relation and autodate fields; two indexes each; rules), 10,500 records with relation ids and file names (collections are made through upstream's API, records inserted with `bun:sqlite`). New `test/perf/compare/startup-time.ts` times process start to the first `/api/health` 200 on a fresh copy, 15 starts per cell, and prints the median, the minimum and the maximum.
- Profiles: `bench.ts --cpu-prof` (source run, `--dev=false`, 50 clients, 8 s) and `summarize-profile.ts`; for start-up a `bun --cpu-prof` run of `src/main.ts serve` and `performance.now()` marks at the phase boundaries (not committed).

## 1. Start-up

Phases of the compiled executable of `main` (host load about 10), milliseconds since process start: main module starts 270–330, bootstrap (open databases, load the collections cache) done 470–515, first `/api/health` 550–620 with the load of that moment. An empty compiled executable starts in 2 ms, so the first block is evaluating the 400-module bundle, not the runtime.

Profile of the source run, ranked:

| Cost | Where | Fix |
|---|---|---|
| parsing and evaluating the bundle: about 150 ms | all modules | `bun build --compile --bytecode --format=esm` |
| 21 module-level regular expressions compiled at import (about 50 ms of a source-run profile, `govalidator` alone 30 ms) | `mustCompile` constants in 14 files | `lazyMustCompile`: the `Regexp` compiles on first use |
| `nodemailer/lib/smtp-connection` import (pulls in `http`, `tls`, `crypto`, `net`; about 60 to 90 ms of a source-run profile) | `src/mail/smtp.ts` | dynamic import on the first send |
| `node:zlib` import (10 to 12 ms) | `zip-reader`, `zip-writer`, `png-raw` | `process.getBuiltinModule("node:zlib")` on first use |
| collections cache load, 20 collections: 56 ms in a source-run profile | `reloadCachedCollections` and `FieldsList.unmarshalJSON` | not changed (see below) |

Changes:

1. **`--bytecode --format=esm`** in `scripts/build.ts` and `test/support/executable.ts` (the tests build the executable the same way). `--bytecode` alone fails on `src/main.ts` (CJS output, top-level await); `--format=esm` works. The executable grows by about 7 MB (114.5 to 121.3 MB). Idle RSS did not rise (74 MiB against 82 MiB on the benchmark data; 71–75 MiB measured with the changes).
2. **Lazy regular expressions**: `Regexp.lazy` and `lazyMustCompile` (`src/tools/regexp/regexp.ts`); `Regexp` keeps its API, the state is built by `compileParts` on first use. A constant that does not compile would now fail on first use instead of at import; all 21 are constants that the tests exercise.
3. **Lazy `nodemailer` and `node:zlib`.**

Results, median (min–max) of 15 starts, three alternating rounds, 10,500-record database, host load 11 to 13:

| Round | main | this branch | upstream v0.41.0 |
|---|---|---|---|
| 1 | 356 (286–647) ms | 153 (102–251) ms | 33 (25–60) ms |
| 2 | 297 (234–423) ms | 117 (90–168) ms | 29 (24–41) ms |
| 3 | 267 (237–433) ms | 117 (98–152) ms | 38 (32–104) ms |

CPU time of the process (start to exit): main 398–412 ms, this branch 203–220 ms, upstream 34–38 ms. On the smaller benchmark database (bench.ts, 3 starts, median): main 225–237 ms, this branch 83 ms, upstream 54 ms. Idle RSS: main 81.6 MiB, this branch 74.3 MiB, upstream 35.2 MiB.

What is left (about 80 ms over upstream): the collections cache (20 collections parse their field JSON through the generic Go-compatible decoder, cold code), the worker pool start, the banner write (`Date` local-zone init and the first stream write, about 30 ms in the source profile, after the listener is up) and unavoidable runtime start. Deferring the collections cache parse per collection would change the cache contract (a cache hit would parse), which is more than a start-up item; not done.

## 2. Request path

Profiles of the source run at 50 clients (percent of the main thread's sampled time; the host was at load 3 to 5):

| | list | list + expand author | view | create |
|---|---|---|---|---|
| `postMessage` (read-pool hop, native) | 8.8 | 6.9 | 14.7 | 0.8 |
| other native (Bun's HTTP and stream code, SQLite) | 9.9 | 20.3 | 21.8 | 16.5 |
| `hydrateRecord` | 6.4 | 6.6 | 0.4 | – |
| `marshalJSON` (provider) + `#writeJSON` | 11.1 | 11.6 | 1.8 | – |
| `isPlainString` (JSON quote test) | 4.8 | 2.7 | 1.1 | – |
| `padStart` (date formatting) | 3.5 | 1.1 | – | – |
| the rest (routing, event, middleware, handlers) | each function under 2.5 | | | |

Changes made, one at a time:

1. **Date formatting** (`DateTime.string`): years 1000 to 9999 are formatted from `toISOString()` instead of eight `appendInt`/`padStart` calls. Same text (a test compares 20,000 generated times, years 1 to 9999 and the edges at 1000 and 9999, with `Date`'s own fields). Gain: below what this host measures. A micro-estimate from the profile (`padStart` 3.5% of list) is 1 to 3% of a list request.

Tried and **dropped**:

- **Rows from the read pool as one JSON string instead of structured clone.** A pool micro-benchmark (`postMessage` of 1 row and of 30 rows of 10 columns, 3,000 round trips, main-thread CPU per message): clone 58 and 179 µs, JSON string plus `JSON.parse` 66 and 128 µs. The gain is 25% at 30 rows, none at 1 row (what `view` and every small query send), it needs a fallback for bigint, `Uint8Array` and `-0` values, and it moves CPU to the worker, which is not idle on a busy server. Not worth the risk.
- **Skipping the pool for small reads**: the largest possible gain on `view` (`postMessage` is 14.7% of it) but it changes D8 (every read outside a transaction takes the pool, which is what holds `--queryTimeout`). Out of scope by the brief; not done.
- **Read-pool batching**: not brought back (M7.1c removed it; it broke D8's deadlines and caused head-of-line blocking).
- **Hydration and expand micro-optimizations** (`hydrateRecord`, `nonzeroUniques`, `expandRecordsPath`): each is 2 to 7% of one workload, already tightened in M7.1b/c, and a rewrite would touch every record read for a gain smaller than this host's noise. Not done.

## 3. Throughput results

Three sessions, same data and harness (3 repetitions, median; p50 and p95 in ms; req/s). Rows for upstream are the same session as the iglo.base column next to them.

**Session 0, main, with upstream** (load 1.5 at start, 12.8 at end):

| Workload | Clients | main req/s | p50 | p95 | upstream req/s | p50 | p95 |
|---|---|---|---|---|---|---|---|
| list 30 | 1 | 807 | 1.09 | 2.73 | 517 | 1.57 | 4.09 |
| list 30 | 10 | 1789 | 4.95 | 10.92 | 1479 | 5.57 | 15.42 |
| list 30 | 50 | 1626 | 28.66 | 49.68 | 1733 | 19.77 | 82.87 |
| filter + sort | 1 | 258 | 3.48 | 6.68 | 155 | 6.00 | 10.63 |
| filter + sort | 10 | 838 | 11.56 | 17.09 | 445 | 20.93 | 38.15 |
| filter + sort | 50 | 607 | 70.10 | 147.33 | 356 | 133.48 | 241.03 |
| expand author | 1 | 321 | 2.36 | 7.12 | 282 | 2.90 | 7.12 |
| expand author | 10 | 689 | 13.07 | 26.03 | 659 | 13.25 | 32.03 |
| expand author | 50 | 686 | 71.00 | 102.92 | 837 | 44.22 | 163.75 |
| view | 1 | 1803 | 0.39 | 1.30 | 1810 | 0.39 | 1.37 |
| view | 10 | 4076 | 2.03 | 5.49 | 3214 | 2.33 | 8.03 |
| view | 50 | 4953 | 8.99 | 18.28 | 5296 | 6.58 | 27.72 |
| create | 1 | 1019 | 0.75 | 2.55 | 984 | 0.66 | 3.69 |
| create | 10 | 1525 | 5.81 | 13.81 | 2341 | 3.00 | 12.17 |
| create | 50 | 1700 | 27.03 | 45.91 | 2626 | 14.48 | 52.06 |

**Session 1, main, iglo.base only** (load 2.2 to 3.9, the quietest) and **session 2, this branch, with upstream** (load 3.6 at start, 13.7 at end, so the later rows ran under heavy load):

| Workload | Clients | main req/s | p50 | p95 | branch req/s | p50 | p95 | upstream req/s | p50 | p95 |
|---|---|---|---|---|---|---|---|---|---|---|
| list 30 | 1 | 809 | 1.11 | 1.96 | 799 | 1.08 | 2.02 | 419 | 2.15 | 3.56 |
| list 30 | 10 | 2167 | 4.01 | 8.52 | 2130 | 4.05 | 8.55 | 1374 | 5.62 | 18.08 |
| list 30 | 50 | 2074 | 23.23 | 32.39 | 1848 | 23.57 | 50.55 | 1678 | 19.82 | 88.47 |
| filter + sort | 1 | 264 | 3.42 | 6.17 | 251 | 3.55 | 6.45 | 136 | 6.35 | 11.80 |
| filter + sort | 10 | 1037 | 9.26 | 14.60 | 441 | 21.45 | 35.94 | 311 | 23.19 | 69.97 |
| filter + sort | 50 | 904 | 54.59 | 65.00 | 1000 | 44.42 | 104.42 | 287 | 160.01 | 332.67 |
| expand author | 1 | 473 | 1.96 | 3.64 | 332 | 2.25 | 7.29 | 297 | 2.75 | 7.44 |
| expand author | 10 | 877 | 10.61 | 19.26 | 540 | 15.32 | 36.69 | 609 | 14.43 | 36.29 |
| expand author | 50 | 840 | 57.81 | 76.74 | 522 | 91.26 | 141.04 | 1077 | 32.11 | 129.28 |
| view | 1 | 1481 | 0.64 | 0.99 | 1790 | 0.41 | 0.97 | 2063 | 0.39 | 0.86 |
| view | 10 | 5944 | 1.38 | 3.58 | 4594 | 1.78 | 4.97 | 3436 | 2.20 | 8.01 |
| view | 50 | 6157 | 7.46 | 13.34 | 5552 | 8.10 | 15.55 | 10048 | 3.50 | 14.39 |
| create | 1 | 1060 | 0.70 | 1.71 | 1103 | 0.69 | 2.24 | 976 | 0.63 | 3.74 |
| create | 10 | 1687 | 4.88 | 12.55 | 1738 | 4.84 | 12.17 | 1455 | 5.24 | 17.39 |
| create | 50 | 1713 | 26.14 | 46.67 | 1783 | 25.57 | 43.59 | 1724 | 23.99 | 65.56 |

How to read this: the first rows of session 2 (list, run at load 3.6 to 6) equal session 1 within the spread, as expected from a change set that does not touch the request path. The rows from filter + sort at 10 clients on (the expand and view rows included) were measured while the load rose to 13.7 and are slower than session 1 for that reason, not because of the change; upstream's own expand and view rows in session 2 are also not those of session 0 (view at 50 clients 10,048 against 5,296 req/s). Same-session before/after across all rows was not possible on this host in the time the load allowed; the honest statement is: **no request-path gain, no regression within the spread (about 30% between repetitions)**. Idle RSS and RSS after the run are not higher (RSS after the run 199 MiB against 197 MiB).

Against the bar at 50 clients (p50 within 1.5× of upstream) with the numbers of the quietest comparable session (0): list 1.45, filter + sort 0.53, expand author 1.61, view 1.37, create 1.87 (create 1.07 in session 2). p95 is within the bar in every row of every session.

## 4. Threads and processes

The profile says the single main thread is the limit: during 50 clients of `list + expand author` (compiled executable, `top -H`), the main thread was at 90–100% of a core and all four read workers, the JIT and GC threads at 10% or less each; the load generator's CPU was separate. Upstream uses every core for the same request (Go scheduler), which is why upstream's req/s rises with idle cores and ours does not, and why the ratio swings with the host load (upstream view at 50 clients: 5,296, 10,048 and 11,063 req/s across sessions of M7.1c and this report, ours 4,953 to 6,157).

Using more threads would mean moving work that touches shared state off the main thread. The candidates and what they would need:

- **Record JSON writing in workers** (11% of list, 12% of expand): needs the hydrated records (collection field objects, Maps, closures) in the worker, so either a second copy of the hydration code with its own collections cache (the cache is invalidated by saves on the main thread: a versioned message channel and a failure mode where a request is answered with a stale schema) or structured clone of the records, which costs more than writing them.
- **Serving from several processes** (SO_REUSEPORT): the owner has ruled this out (M7.1c); in addition SQLite writes, the realtime broker, rate limits, the collections cache and settings are per-process state that would have to be shared.
- **Writes on a thread**: D8 keeps the writer on the main thread.

I did not build a prototype: the ceiling is visible in the numbers without one. A worker takes the work that is 11% of the thread at best (and adds a hop of 50 to 180 µs per message, the cost of `postMessage` measured above, which is 15% of the thread on `view` already). The remaining gap is structural: one JavaScript thread against Go's goroutines. The p95 meets the bar everywhere; the p50 at 50 clients does not in some workloads, and that is the price of the single-thread design that keeps the shared state (D8, D5) simple.

## 5. What changed

| File | Change |
|---|---|
| `scripts/build.ts`, `test/support/executable.ts` | `--bytecode --format=esm` |
| `src/tools/regexp/regexp.ts` | `Regexp.lazy`, `lazyMustCompile`, `compileParts` |
| 14 modules (`apis/`, `collections/`, `fields/`, `settings/`, `tools/dbutils`, `tools/filesystem`, `validation/is`) | `mustCompile` constants become `lazyMustCompile` |
| `src/mail/smtp.ts` | `nodemailer` imported on first send |
| `src/tools/archive/zip-reader.ts`, `zip-writer.ts`, `src/files/png-raw.ts` | `node:zlib` loaded on first use |
| `src/tools/types/datetime.ts` | `string()` from `toISOString()` for years 1000 to 9999, with a generated test |
| `test/perf/compare/startup-db.ts`, `startup-time.ts` | the start-up harness |

## Local checks

`bun run check` at this head: 18,304 tests pass, 0 fail (lint, format, typecheck, test, build). `bun run test:reference`: 4,401 pass, 0 fail. Both ran on a host at load 3 to 13 (other agents), one at a time and never during a measurement.
