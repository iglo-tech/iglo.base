# R.2 Read-only replicas (`serve --mode prod --schema … --replicas N`)

Written by the chief of staff on 2026-11-14. The spec is GitHub issue [#83](https://github.com/iglo-tech/iglo.base/issues/83) (`gh issue view 83 --comments`), including the lead's decision comment of 2026-11-14 ("go with conditions"). The spike is `docs/perf/replicas-spike.md` (R.1), and its prototype is on branch `spike/replicas`. **Base branch: `main`.**

## Phase 1: the write-hop gate (do this first, and stop if it fails)

- **Why:** in the spike, a 1-client create through a replica costs +0.3–0.5 ms. The reviewer measured where it goes: a second HTTP layer in JavaScript, where the replica parses the request and builds a new `fetch`. The socket and the body copy cost nothing measurable. A plain byte relay added about 0.03 ms.
- **Build the cheaper hop.** For example:
  - the replica decides "mine or primary's" from the request line and headers it already has, then relays the raw request bytes to the primary over the Unix socket and streams the raw response back;
  - or it hands over the connection;
  - or anything else that avoids building a second request.

  Keep-alive connections that carry both reads and writes must still work. `/api/realtime` must stream.
- **Measure:** 1-client create with the spike's harness and method, in one session, with at least 3 repetitions. Compare today's server and 2 replicas.
- **Gate:** the median through a replica is within **+0.1 ms** of today's server. Also re-check 1-client view and list.
- **If the gate fails:** stop. Write the numbers into `docs/perf/R.2-gate.md`, open a PR with only that file, titled "R.2: replicas write-hop gate (no-go)", and report. The lead then closes #83.
- **If it passes:** write `docs/perf/R.2-gate.md` and continue with phase 2 on the same branch.

## Phase 2: the feature (only after the gate passes)

- **What #83 says:**
  - **Primary:** today's server on an internal Unix socket in a private directory. It starts, restarts and stops the replicas, and runs crons, backups and restore. A restore restarts everything.
  - **Replicas:** they listen on the public address with `reusePort` and answer the fixed list of read routes. Every other route goes to the primary, including OAuth2 redirects, other `GET`s that write, and rate-limited routes when rate limits are on. The client IP and headers go with each request, and the primary trusts only its socket.
  - **Logs:** replicas send their request logs to the primary's log writer (D31).
- **The lead's conditions:**
  - **Requires the schema lock:** `--replicas` needs `--mode prod --schema`. It is refused at start otherwise, with a clear message.
  - **Read pool:** each replica has its own D8 read pool. Measure filter + sort at 50 clients for N = 1, 2 and 4. If N = 1 is still worse than today, refuse N = 1.
  - **Thumbnails:** a thumbnail that doesn't exist yet is routed to the primary, so only one process generates and writes it. Existing thumbnails are served by replicas.
  - **Writes don't scale:** `docs/operations.md` says writes don't scale with replicas, and gives the memory cost per replica (measured).
- **D42** in `docs/design/10-decisions.md`, amending D8 and the M7.1c owner note about processes. `docs/design/` describes the process model.
- **Data contract:** nothing new on disk.
- **API contract:** no differences in responses.

## Tests

- **Differential suite:** the full suite passes against `--mode prod --schema <file> --replicas 2`. That includes realtime, auth, files, batch and the log tests. Add a way to run it in that mode (for example an environment variable in the test server helper), and document it.
- **Crash:** SIGKILL a replica under load. It is noticed and restarted, and no request fails beyond the connections it held.
- **Shutdown:** SIGTERM stops everything within 10 s, with exit 0. No process is left behind (check with `pgrep`).
- **Refusals:** `--replicas` without `--mode prod --schema`; N = 1 if refused.
- **Performance:** `docs/perf/R.2-replicas.md` with before/after numbers for N = 0, 2 and 4, using the spike's harness and method.

## Verification

- Run `bun run check`, then `bun run test:reference`, one after the other, in the foreground, then the differential suite in replicas mode. Never detach a check with `&`, and never wrap one in `timeout`. Report each exit code.
- **Host:** shared, with dynamic memory. Check `free -m` and the load average before each measurement and test run. Stop every process you start, and verify with `pgrep`.
- The worker instructions in `docs/chief-of-staff.md` apply.
- Open a PR titled "R.2: read-only replicas (`--replicas N`)" against `main`, with "Closes #83" in the body. Do not merge.
