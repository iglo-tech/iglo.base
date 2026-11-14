# R.1 Read-only replicas: measurement spike

Written by the chief of staff on 2026-11-14. The spec is GitHub issue [#82](https://github.com/iglo-tech/iglo.base/issues/82) (`gh issue view 82`). This spike decides whether [#83](https://github.com/iglo-tech/iglo.base/issues/83) (R.2) gets built. **Base branch: `main`.**

## Scope

- **Prototype.** The prototype is throwaway, exactly as the issue describes it.
  - **Primary:** today's server, listening on an internal Unix socket in a private `mktemp -d` directory.
  - **Replicas:** N processes on the public port with `Bun.serve({ reusePort: true })`. Each answers `GET` list, view, expand and file requests from its own read-only SQLite connections. Collections and settings are loaded once at start.
  - **Everything else** goes to the primary over the socket. `/api/realtime` is streamed through.
  - **Branch:** push the prototype to `spike/replicas` and never merge it. Keep it out of `src/` on `main`.
  - **Code quality:** it only has to be correct enough for the measured requests to return the same responses as without replicas. Check that with a few requests before measuring.
- **Measurements:** use the P.3 harness (`test/perf/compare/bench.ts`) and follow the issue's "Measure" section.
  - **Requests:** list, filter and sort, expand, view and create, at 1, 10 and 50 clients.
  - **Configurations:** N = 0, 1, 2 and 4, against PocketBase v0.41.0 in the same session.
  - **Repetitions:** at least 3 per cell, with median and spread.
  - **Host data:** record the load average and the CPU count (`nproc`).
  - **Memory:** RSS idle and after each run, for the primary and every replica.
  - **Write cost:** create latency at 1 client, direct versus through a replica.
- **Host limits.** The host is shared, with dynamic memory between 2 and 16 GiB. Before each configuration, check `free -m` and the load average. Skip N = 4 if available memory is under 3 GiB, and say so. Never run measurements in parallel with a check run. Stop every process you started before you finish.
- **Result:** `docs/perf/replicas-spike.md`, with tables in ms and req/s, memory, the method, and a clear **go** or **no-go** under the issue's rule: reads at 50 clients within 1.2× of PocketBase or better with 2–4 replicas, and 1-client latency no worse than +0.1 ms. Name the bottleneck if it is a no-go.

## Verification

- The PR changes only `docs/perf/replicas-spike.md`, plus a line in `docs/design/12-work-plan.md` if needed. Run `bun run check` on it; `test:reference` isn't needed for a doc-only PR.
- The worker instructions in `docs/chief-of-staff.md` apply.
- Open a PR titled "R.1: read-only replicas spike" against `main`, with "Part of #82" in the body and a link to the `spike/replicas` branch. Do not merge.
