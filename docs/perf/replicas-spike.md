# R.1: read-only replicas, measurement spike

Part of [#82](https://github.com/iglo-tech/iglo.base/issues/82). The throwaway prototype is on branch `spike/replicas` (head `8a1fa62`, never merged). It holds the replica code, the harness changes, and the raw bench and check logs in `scripts/spikes/R.1/results/`.

## Verdict

**No-go** under the rule in #82. The read bar passes. The 1-client clause fails for writes that go through a replica.

- **Reads at 50 clients** (p50, median of 3 repetitions, same session as PocketBase v0.41.0): with 2 replicas, list 0.96×, expand author 1.11×, view 1.07× and filter + sort 0.61× PocketBase's p50. With 4 replicas, 0.59×, 0.61×, 0.53× and 0.32×. The 1.2× bar is met with 2 and with 4 replicas. Today's server (N = 0) is at 1.69×, 2.31×, 2.06× and 0.41× on the same workloads.
- **1-client latency:** reads get faster with replicas (list 1.01 → 0.69 ms, expand author 2.21 → 1.11 ms, view 0.55 → 0.33 ms, with 2 replicas). A create through a replica does not: 0.66 ms direct, against 1.04, 1.14 and 0.97 ms through 1, 2 and 4 replicas. That is +0.31 to +0.48 ms at the medians, against the +0.1 ms bar. It is above +0.1 ms in every repetition (+0.23 to +0.61 ms over the same repetition's direct create).
- **Bottleneck of the no-go:** each write takes a second HTTP hop, replica to primary over the Unix socket, with the request body streamed through `fetch`. That hop is the whole 1-client create cost. I did not profile it, so how the cost splits inside the hop is a hypothesis.

The brief's 1-client clause could be read as covering reads only. Under that reading the verdict is go for 2 replicas. The brief does not settle which reading was meant, so this report gives the no-go on the rule as written and leaves the reading to the owner.

Two results matter beyond the verdict:

- **Filter and sort is slower with 1 or 2 replicas than with today's server.** At 50 clients, p50 is 121 ms with 1 replica and 60 ms with 2, against 40 ms today. A replica runs its SQLite reads on the main thread (no read pool), while the primary runs them on a 4-worker read pool. Filter and sort passes the bar only because PocketBase is slower on it in this session (98 ms). With 4 replicas it is faster than today (32 ms). A replica with the read pool is untested.
- **Writes do not scale with replicas.** The primary's create work stays on one core (1.02 to 1.07 cores at 50 clients). Create p50 at 50 clients is 2.5 to 3.2× PocketBase's for every N.

## What was built

Throwaway code, on `spike/replicas` only:

- **Primary:** today's server. With replicas it listens on a Unix socket in a private `mktemp -d` directory (`--http unix:<path>`; the branch adds that listener to `src/server/serve.ts`). With N = 0 it listens on TCP as before.
- **Replicas** (`scripts/spikes/R.1/replica.ts`): N processes on the public port with `Bun.serve({ reusePort: true })`. Each opens `data.db` and `auxiliary.db` read-only (`openReadOnly`), has no read pool, and loads the collections and settings once at start. The router is the primary's own (`newServeRouter`), and requests go through the primary's `handleRequest`, so middlewares, auth and error bodies are the same code. Only `GET` and `HEAD` for `/api/collections/{c}/records[/{id}]` and `/api/files/` are answered locally. Everything else, including `/api/realtime` (streamed), goes to the primary over the socket.
- **Limits of the prototype:** a collection or setting changed after a replica starts is invisible to it. The check showed this: a collection created after start answers `Missing collection context`, so the check creates its collection before the replicas start. Replicas do not watch the `.notify` file. Replicas run from source under Bun, not as compiled executables. Replica reads run on the main thread (see the filter and sort result above).

## Correctness

`scripts/spikes/R.1/check.ts` sends the same 21 requests to N = 0, 1, 2 and 4, on identical copies of the bench data, and compares status, content type and body. The comparison normalizes timestamps, tokens, random file-name suffixes and the ids the server generates. The requests cover: health; list (plain, filter and sort, expand author, expand author.team, fields with a page, skipTotal); view; a missing record (404); an invalid filter (400); list and view as a superuser; the auth-with-password POST; a multipart file upload and its download through the replica, and the same file from the primary; a JSON create and a read back through the replica; a realtime subscription through the replica that receives the create event. All 21 match N = 0 for N = 1, 2 and 4 (`CHECK OK`, log in `scripts/spikes/R.1/results/check.log`). The check ran before any measurement and after the last change to the replica code.

## Method

- **Host:** AMD Ryzen 5 1600, 6 CPUs, Linux 6.12, bun 1.4.4. The host is shared with other agents, and the 1-minute load average before each configuration ran from about 2 to 8 (see the host table). MemAvailable before each configuration was never below 8.4 GiB, so no configuration was skipped and the N = 4 rule (skip below 3 GiB) did not apply.
- **Harness:** `test/perf/compare/bench.ts` from P.3, extended on `spike/replicas`. Targets: `iglo-base` (N = 0, the same start as P.3; the spike build differs from `main` only by the unused Unix-socket listener), `iglo-r1`, `iglo-r2`, `iglo-r4`, and `upstream`. Data: the P.3 benchmark data (3,000 posts, 200 members, 20 teams), built through PocketBase v0.41.0's API. Workloads: list (30 per page), list with filter and sort, list with expand author, view, and create (JSON). 1, 10 and 50 clients; 1.5 s warm-up and 4 s measured per cell; `nice -n 10`; one server configuration at a time; no check run during measurement.
- **Repetitions:** 3 per cell. Each repetition runs every configuration in turn, so host load reaches them alike. The tables give the median; the brackets give min to max.
- **Memory:** RSS of every process, primary first, 3 s after start and after the five workloads.
- **CPU:** per-process CPU time over each measured run (`/proc/<pid>/stat`), reported as cores busy. The load generator is the bench process on the same host, so its cores are in the CPU table too.
- **Start-up:** the time until the primary and all replicas answer `/api/health` on the public port (median of 3). It is not comparable with P.3's start-up, which measured the primary alone.
- **Cleanup:** every process was stopped, and the cluster helper fails if any survives its stop. No process or socket directory was left behind.

## Results

### Latency and throughput per workload

Each cell: median of the repetitions; spread in brackets (min–max). p50 and req/s at 1, 10 and 50 clients; p95 at 50 clients.

#### list 30

| Configuration | 1 client p50 ms | 1 client req/s | 10 clients p50 ms | 10 clients req/s | 50 clients p50 ms | 50 clients p95 ms | 50 clients req/s |
|---|---|---|---|---|---|---|---|
| iglo.base, N=0 (today) | 1.01 [0.7–1.1] | 870 | 3.47 [3.4–3.7] | 2486 | 20.17 [19.7–20.5] | 29.44 | 2383 [2339–2457] |
| N=1 replicas | 0.68 [0.6–0.7] | 1120 | 4.35 [4.3–4.4] | 1823 | 23.68 [23.7–23.8] | 44.66 | 1838 [1817–1842] |
| N=2 replicas | 0.69 [0.6–0.7] | 1155 | 2.27 [2.2–2.6] | 3787 | 11.41 [11.3–11.7] | 21.49 | 3981 [3812–4122] |
| N=4 replicas | 0.69 [0.7–0.8] | 1148 | 1.44 [1.4–2.3] | 5632 | 6.98 [6.2–7.6] | 15.08 | 6441 [5849–7604] |
| PocketBase v0.41.0 | 1.95 [1.3–2.0] | 500 | 3.39 [3.4–3.7] | 2567 | 11.90 [11.3–17.1] | 55.57 | 2747 [1989–2802] |

#### list 30, filter + sort

| Configuration | 1 client p50 ms | 1 client req/s | 10 clients p50 ms | 10 clients req/s | 50 clients p50 ms | 50 clients p95 ms | 50 clients req/s |
|---|---|---|---|---|---|---|---|
| iglo.base, N=0 (today) | 3.34 [2.8–3.4] | 266 | 7.54 [7.5–7.6] | 1244 | 40.09 [39.8–40.6] | 51.81 | 1213 [1198–1226] |
| N=1 replicas | 2.47 [2.4–2.6] | 329 | 21.18 [20.6–22.2] | 396 | 121.29 [115.8–122.7] | 150.24 | 398 [397–409] |
| N=2 replicas | 2.54 [2.5–2.6] | 319 | 10.45 [9.9–12.7] | 784 | 59.73 [56.7–62.2] | 87.69 | 798 [780–826] |
| N=4 replicas | 2.54 [2.5–2.8] | 319 | 5.97 [5.4–9.3] | 1385 | 31.52 [31.1–40.1] | 56.84 | 1492 [1237–1506] |
| PocketBase v0.41.0 | 9.86 [5.5–10.3] | 114 | 18.88 [15.4–19.3] | 498 | 98.12 [86.1–108.0] | 165.87 | 487 [446–569] |

#### list 30, expand author

| Configuration | 1 client p50 ms | 1 client req/s | 10 clients p50 ms | 10 clients req/s | 50 clients p50 ms | 50 clients p95 ms | 50 clients req/s |
|---|---|---|---|---|---|---|---|
| iglo.base, N=0 (today) | 2.21 [2.1–2.4] | 406 | 9.68 [9.4–9.8] | 929 | 53.40 [52.4–54.4] | 74.87 | 902 [898–917] |
| N=1 replicas | 1.18 [1.1–1.2] | 676 | 8.71 [8.7–8.9] | 941 | 50.30 [47.9–54.6] | 83.73 | 917 [861–950] |
| N=2 replicas | 1.11 [1.1–1.1] | 691 | 4.31 [4.3–4.5] | 1934 | 25.52 [22.6–25.7] | 45.69 | 1999 [1998–2186] |
| N=4 replicas | 1.18 [1.2–1.2] | 663 | 2.49 [2.5–3.3] | 3360 | 14.07 [11.1–20.9] | 31.01 | 3263 [1992–3679] |
| PocketBase v0.41.0 | 3.05 [2.4–4.3] | 296 | 5.89 [5.7–7.5] | 1551 | 23.09 [22.6–31.5] | 86.43 | 1592 [1233–1605] |

#### view

| Configuration | 1 client p50 ms | 1 client req/s | 10 clients p50 ms | 10 clients req/s | 50 clients p50 ms | 50 clients p95 ms | 50 clients req/s |
|---|---|---|---|---|---|---|---|
| iglo.base, N=0 (today) | 0.55 [0.5–0.6] | 1637 | 1.25 [1.2–1.3] | 6505 | 6.87 [6.7–7.1] | 12.82 | 6655 [6331–6895] |
| N=1 replicas | 0.34 [0.3–0.4] | 2515 | 1.16 [1.2–1.2] | 6894 | 6.26 [6.2–6.3] | 12.21 | 7125 [7019–7150] |
| N=2 replicas | 0.33 [0.3–0.4] | 2580 | 0.63 [0.5–0.7] | 13819 | 3.56 [3.4–3.7] | 6.38 | 14712 [14450–14818] |
| N=4 replicas | 0.33 [0.2–0.3] | 2562 | 0.44 [0.4–0.8] | 19762 | 1.77 [1.7–3.5] | 4.05 | 25264 [11976–26907] |
| PocketBase v0.41.0 | 0.36 [0.3–0.4] | 2497 | 0.73 [0.7–1.0] | 11521 | 3.33 [3.0–4.0] | 10.37 | 11802 [10203–13093] |

#### create (JSON)

| Configuration | 1 client p50 ms | 1 client req/s | 10 clients p50 ms | 10 clients req/s | 50 clients p50 ms | 50 clients p95 ms | 50 clients req/s |
|---|---|---|---|---|---|---|---|
| iglo.base, N=0 (today) | 0.66 [0.6–0.7] | 1127 | 4.40 [4.1–4.6] | 1868 | 25.80 [24.2–28.9] | 48.92 | 1714 [1613–1852] |
| N=1 replicas | 1.04 [1.0–1.2] | 793 | 4.07 [3.8–4.1] | 2025 | 22.61 [21.5–22.9] | 43.45 | 1979 [1928–1992] |
| N=2 replicas | 1.14 [0.9–1.3] | 810 | 3.83 [3.8–3.9] | 2124 | 20.65 [20.2–22.0] | 35.23 | 2119 [2060–2239] |
| N=4 replicas | 0.97 [0.9–1.3] | 824 | 3.95 [3.8–4.5] | 2134 | 21.15 [19.2–21.3] | 37.02 | 2133 [2094–2371] |
| PocketBase v0.41.0 | 0.55 [0.5–0.6] | 1397 | 1.80 [1.7–1.9] | 3992 | 8.20 [7.8–9.3] | 54.29 | 3523 [3427–3685] |

### Ratio to PocketBase (p50 at 50 clients; below 1.00 is faster)

| Configuration | list 30 | list 30, filter + sort | list 30, expand author | view | create (JSON) |
|---|---|---|---|---|---
| iglo.base, N=0 (today) | 1.69 | 0.41 | 2.31 | 2.06 | 3.15 |
| N=1 replicas | 1.99 | 1.24 | 2.18 | 1.88 | 2.76 |
| N=2 replicas | 0.96 | 0.61 | 1.11 | 1.07 | 2.52 |
| N=4 replicas | 0.59 | 0.32 | 0.61 | 0.53 | 2.58 |

### Memory (RSS, MiB): primary first, then each replica; median of the repetitions

| Configuration | idle | after the runs | host load (1 min) before, median |
|---|---|---|---|
| iglo.base, N=0 (today) | 75 | 197 | 5.82 |
| N=1 replicas | 75 + 59 | 135 + 87 | 4.28 |
| N=2 replicas | 76 + 58 + 57 | 135 + 83 + 83 | 2.92 |
| N=4 replicas | 76 + 57 + 57 + 57 + 59 | 134 + 80 + 82 + 79 + 78 | 3.06 |
| PocketBase v0.41.0 | 35 | 160 | 4.13 |

### CPU of the servers at 50 clients: cores busy per process, median (primary first)

| Configuration | workload | cores per process | bench client cores |
|---|---|---|---|
| iglo.base, N=0 (today) | list 30 | 2.12 | 0.26 |
| iglo.base, N=0 (today) | list 30, filter + sort | 3.65 | 0.14 |
| iglo.base, N=0 (today) | list 30, expand author | 1.89 | 0.27 |
| iglo.base, N=0 (today) | view | 1.61 | 0.54 |
| iglo.base, N=0 (today) | create (JSON) | 1.07 | 0.24 |
| N=1 replicas | list 30 | 0.01 / 1.04 | 0.28 |
| N=1 replicas | list 30, filter + sort | 0.00 / 1.06 | 0.09 |
| N=1 replicas | list 30, expand author | 0.00 / 1.06 | 0.18 |
| N=1 replicas | view | 0.00 / 1.02 | 0.68 |
| N=1 replicas | create (JSON) | 1.02 / 0.48 | 0.26 |
| N=2 replicas | list 30 | 0.01 / 1.01 / 1.02 | 0.39 |
| N=2 replicas | list 30, filter + sort | 0.00 / 1.08 / 1.03 | 0.14 |
| N=2 replicas | list 30, expand author | 0.00 / 1.06 / 1.04 | 0.25 |
| N=2 replicas | view | 0.00 / 1.00 / 0.99 | 0.82 |
| N=2 replicas | create (JSON) | 1.04 / 0.26 / 0.30 | 0.27 |
| N=4 replicas | list 30 | 0.00 / 0.92 / 0.86 / 0.87 / 0.80 | 0.42 |
| N=4 replicas | list 30, filter + sort | 0.00 / 0.99 / 0.98 / 0.98 / 0.99 | 0.17 |
| N=4 replicas | list 30, expand author | 0.00 / 0.94 / 0.89 / 0.95 / 0.92 | 0.28 |
| N=4 replicas | view | 0.00 / 0.81 / 0.77 / 0.84 / 0.87 | 0.78 |
| N=4 replicas | create (JSON) | 1.02 / 0.13 / 0.14 / 0.16 / 0.09 | 0.27 |

### Host

- bun 1.4.4, AMD Ryzen 5 1600 Six-Core Processor, MemTotal 15.6 GiB, MemAvailable 10.5 GiB; 6 CPUs (availableParallelism); 3 repetitions, 4 s measured per cell.
- Load average (1 min) before each configuration, by configuration: iglo.base, N=0 (today): 2.09, 5.82, 7.80; N=1 replicas: 3.58, 4.50, 4.28; N=2 replicas: 2.92, 3.36, 2.69; N=4 replicas: 2.83, 3.61, 3.06; PocketBase v0.41.0: 4.13, 7.32, 4.10.

### Create at 1 client, direct against through a replica (p50 ms per repetition)

| Configuration | Repetition 1 | Repetition 2 | Repetition 3 | Median | Difference from N = 0, same repetition (min to max) |
|---|---|---|---|---|---|
| iglo.base, N=0 (direct) | 0.69 | 0.66 | 0.64 | 0.66 | – |
| N=1 replica | 1.20 | 1.00 | 1.04 | 1.04 | +0.34 to +0.51 |
| N=2 replicas | 1.26 | 0.91 | 1.14 | 1.14 | +0.25 to +0.57 |
| N=4 replicas | 1.30 | 0.89 | 0.97 | 0.97 | +0.23 to +0.61 |

Start-up, median of 3 (primary plus replicas for N ≥ 1): N = 0 112 ms, N = 1 289 ms, N = 2 505 ms, N = 4 865 ms (the replicas start from source under Bun), PocketBase 53 ms.

## Interpretation

- **Read scaling:** each replica is one JavaScript thread, and at 50 clients each one is busy at 0.8 to 1.0 cores (CPU table). The primary does no read work once replicas exist (0.00 cores). So throughput grows roughly with the number of replicas, until the host's 6 CPUs fill up with servers and the load generator (about 4 cores at N = 4 for view).
- **Write path:** creates still go through the primary's single write thread, so create throughput does not grow with N (about 1,700 to 2,100 req/s at 50 clients). The extra hop adds the 1-client cost above and does not change this.
- **Memory:** replicas run at about 57 to 59 MiB idle and 78 to 87 MiB after the runs; the primary is 75 MiB idle and 134 to 135 MiB after the runs with replicas (197 MiB alone, because it served all reads). Total after the runs: 197 MiB for N = 0, 222 MiB for N = 1, 301 MiB for N = 2 and 453 MiB for N = 4 (PocketBase 160 MiB).

## What is not measured

- The read pool in replicas, which is the open question for filter and sort.
- Where the time of the proxied create goes. Not profiled.
- Realtime latency and fan-out through replicas: correctness only.
- Propagation of collection and settings changes to replicas. Their cache is loaded once, so there is none.
- Replicas as compiled executables, and their memory when compiled.
- Reads from replicas while the primary is down. Not tested.

## Reproduce

On `spike/replicas`: `bun run build`, then `bun scripts/spikes/R.1/check.ts`. For the bench, `nice -n 10 bun test/perf/compare/bench.ts --target iglo-base,iglo-r1,iglo-r2,iglo-r4,upstream --clients 1,10,50 --seconds 4 --warmup 1.5 --repeat 3 --workloads list,list-filter,list-expand1,view,create --keep <pb_data> --json out.json`, where `<pb_data>` is built by the same bench the first time it is missing, and then `bun scripts/spikes/R.1/summarize.ts out.json` prints these tables.
