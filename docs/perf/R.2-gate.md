# R.2 write-hop gate: no-go

Part of [#83](https://github.com/iglo-tech/iglo.base/issues/83) (R.2, `serve --mode prod --schema … --replicas N`). Phase 1 of the R.2 brief: build the cheaper write hop and measure a 1-client create through a replica against today's server. The lead's rule: the median through a replica must be within **+0.1 ms** of today's server (same session, at least 3 repetitions). **It is not. Phase 2 was not started.**

Host: AMD Ryzen 5 1600, 6 CPUs, Linux 6.12, bun 1.4.4, shared with other agents (1-minute load average 2 to 4 during the runs, MemAvailable above 9 GiB). Harness and method: the R.1 spike's `test/perf/compare/bench.ts` and `scripts/spikes/R.1/cluster.ts`, unchanged except for the replica. One client, keep-alive, 1.5 s warm-up and 4 s measured per cell, `nice -n 10`, 3 repetitions. Each repetition runs `iglo-base` (today's server, N = 0) and `iglo-r2` (the primary with 2 replicas) in turn.

## Verdict

| Hop | 1-client create p50, ms (median of 3; N = 0 → 2 replicas) | Difference | Gate (+0.1 ms) |
|---|---|---|---|
| A: replica serves on the public port; non-local requests go through a pooled HTTP/1.1 client on the primary's Unix socket (`src/replicas/primary-hop.ts`) | 0.65 → 1.15 | **+0.50** | fails |
| B: raw front on the public port, pinned by the first request; bytes relayed to the primary's Unix socket | 0.67 → 0.85 | **+0.18** | fails |

Hop B is the cheapest hop I could build (a relay that parses only the first request line). It is over the bar in the median, and in two of the three repetitions (+0.31 and +0.23 ms; the third was +0.08 ms). A relay that also injects the client IP into each request, or routes each request separately, adds work on top of hop B, so no design I could build here passes this gate. The measurements below show why.

## Measurements

### 1-client p50 (ms), per repetition and median

| Workload | Today's server (N = 0), reps | Hop A, 2 replicas | Hop B, 2 replicas |
|---|---|---|---|
| create (JSON) | 0.60, 0.65, 0.67 → **0.65** | 1.15, 1.03, 1.17 → **1.15** (+0.50) | 0.98, 0.85, 0.76 → **0.85** (+0.18) |
| list 30 | 0.90, 0.89, 0.86 → **0.89** | 0.69, 0.69, 0.69 → **0.69** (−0.20) | 1.43, 1.27, 1.19 → **1.27** (+0.24) |
| view | 0.43, 0.45, 0.46 → **0.45** | 0.31, 0.31, 0.28 → **0.31** (−0.14) | 0.62, 0.65, 0.69 → **0.65** (+0.08) |

Hop B's N = 0 numbers come from the same session, with their own medians: create 0.67, list 1.03, view 0.57. Today's server differs between the two sessions by 0.02 ms for create and 0.14 ms for list (host load), which is why each hop is compared with its own session.

Raw rows: `scripts/spikes/R.2/results/gate-hop-a.log` and `gate-hop-b.log` (JSON next to them) on branch `spike/R.2-gate`.

### Where a write through a replica spends its time

These are single runs of the experiments in `scripts/spikes/R.2/experiments/` (same host, same session as the gate, n ≥ 3,000 requests each, p50):

| Experiment | p50, ms |
|---|---|
| Raw bytes: TCP echo, round trip from a client process | 0.064 to 0.072 |
| Raw bytes: the same echo through one relay process to a Unix socket | 0.130 to 0.150 |
| Create by a client process to a primary on TCP, alternating with the Unix-socket primary | 0.63 to 0.66 (TCP), 0.70 to 0.71 (Unix socket) |
| Create to a replica-like server process: no-op handler | 0.20 |
| Create to the same server, handler = spike's `fetch` proxy to the primary | 0.99 |
| Create to the same server, handler = hop A | 1.17 |
| Create to the same server, handler = hop B, alternating with the direct TCP primary (3 rounds each) | 0.76 (B) vs 0.65 (direct): +0.11 |
| Hop A alone in one process, against a Unix-socket primary (no replica process) | 0.55 to 0.56 |

Reading the table:

- **One more process on the path costs about 0.07 ms per round trip on this host**, before any HTTP work (raw echo rows). A write through a replica adds one such process, so the floor for any relay is about +0.07 ms, and the gate allows +0.1 ms in total.
- **The HTTP work in the replica is the rest.** In the server-process test, the spike's `fetch` proxy (0.99 ms) and hop A (1.17 ms) are both well above the no-op server (0.20 ms). Hop B, a raw relay with no HTTP work in the replica, measured +0.11 ms over direct in the alternation test and +0.18 ms in the gate's session.
- **The primary's own create is roughly 0.45 ms** of the 0.65 ms direct create (0.65 minus the 0.20 ms no-op floor, an estimate). The write path has little room for anything else.

### Reads

The gate asks for a re-check of view and list at one client. They move in opposite directions by hop:

- **Hop A** serves local reads from the replica's own server on the public port: list 0.89 → 0.69 ms and view 0.45 → 0.31 ms, faster than today's server.
- **Hop B** pins each connection by its first request, so a local read goes through a second relay, and reads get slower: list +0.24 ms and view +0.08 ms.

Hop B's reads are slower than hop A's because of the relay, not the replica's work. Read scaling at 50 clients was measured in R.1 with the spike replica (Bun.serve on the public port, no relay); it was not re-measured here, so it does not carry over to hop B.

## Correctness

The R.1 check (`scripts/spikes/R.1/check.ts`, 21 requests compared with N = 0 for N = 1, 2 and 4: reads, expand, a missing record, an invalid filter, superuser reads, password auth, multipart upload and download, a JSON create and a read back through the replica, and a realtime subscription that gets the create event) passes for both hops:

- hop A: `CHECK OK`, 21 of 21 for each N (`scripts/spikes/R.2/results/check-hop-a.log`);
- hop B: `CHECK OK`, 21 of 21 for each N (`scripts/spikes/R.2/results/check-hop-b.log`).

So the hops are correct, and the gate is about cost.

## What this means for #83

- The gate fails under the rule as written, so the R.2 brief says to stop and the lead closes #83. Phase 2 (the `--replicas` feature, D42, the read pools, thumbnails, logs, crash and shutdown tests) was not started.
- R.1's read results stand. Writes through replicas do not scale either (R.1: create p50 at 50 clients is 2.5 to 3.2 times PocketBase's, and one primary write thread is the bottleneck), so a replica design only helps reads.
- The write penalty is structural: one replica-to-primary hop on this host, +0.18 ms at best for a create and +0.50 ms for the simple hop. Options for the lead and the owner, in order of how much they change the design:
  1. Close #83 under the gate rule (the recommendation here).
  2. Keep replicas for reads, and send writes to the primary's own address, so the write path has no hop. That changes how clients and the deployment reach the server, which is beyond #83's text; it needs an owner decision.
  3. Accept a write penalty of about +0.2 to +0.5 ms on a 1-client create, as an owner decision that changes the gate.

## Limits

- One host, shared with other agents. Repetitions are three per configuration, as the gate requires; the spread within a configuration is up to 0.22 ms for hop B's replica creates (0.76 to 0.98 ms) and 0.06 ms for today's server.
- Only N = 2 is measured for the gate. The write hop's cost does not depend on N: each write takes one hop on whichever replica it reaches.
- Hop B has no client-IP injection and no per-request routing. Both would add work on the write path, so the +0.18 ms is a lower bound for a design that has them.
- Hop A's replica (the Bun.serve front) was run from an earlier version of `scripts/spikes/R.1/replica.ts`; that version is not committed separately (the branch has hop B's replica only). The hop module itself is committed.

## Reproduce

On branch `spike/R.2-gate` (throwaway, not merged): `bun run build`, then `bun scripts/spikes/R.1/check.ts` for the correctness check, then `nice -n 10 bun test/perf/compare/bench.ts --target iglo-base,iglo-r2 --clients 1 --workloads create,list,view --seconds 4 --warmup 1.5 --repeat 3 --keep <absolute path of a built pb_data>`. The pb_data is built on the first run; pass an absolute path to `--keep`, since the bench resolves a relative one against its temporary directory.
