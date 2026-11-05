# Brief P.3

Written by the chief of staff on 2026-11-05. Performance, second pass (owner direction 2026-11-05: the M7.1 misses were accepted for 1.0, to be revisited after the MVP).

```text
Task P.3: Performance, second pass
Goal: close as much as is safely possible of the p50 gap M7.1c left at 50 clients (list 21.5 vs 11.8 ms, expand author 54.6 vs 26.8 ms, view 7.2 vs 3.5 ms, create 23.3 vs 12.1 ms; p95 already within the bar), and cut startup time (iglo.base about 0.3–0.5 s vs PocketBase about 0.05 s on a real-sized database, M7.4). Results as absolute numbers (ms, req/s), not only ratios.
Read first: AGENTS.md (performance changes need before/after numbers in docs/perf/), docs/design/02-architecture.md (Performance bar, threads), docs/design/10-decisions.md (D8, D25, D26, D31), docs/perf/M7.1a-profile.md, docs/perf/M7.1b-fixes.md, docs/perf/M7.1c-final.md (method, harness, what was tried; read-pool batching was removed because it broke D8 deadlines and caused head-of-line blocking: do not bring it back), docs/design/12-work-plan.md (P.3, Rules for workers).
Owns: the modules the profile points at (src/db/, src/records/, src/apis/ record handlers, src/core/ hydration and export, src/cli/serve.ts and startup paths), the perf harness, docs/perf/P.3-*.md, design docs the change touches.
Depends on: M7.1c (merged).
Acceptance:
  - Start with a fresh profile on the current main with the M7.1c harness, run when the host is quiet (check load and other agents' processes first; record load average with every measurement; repeat each measurement at least 3 times and report the median and spread). Same for startup: profile what runs between process start and the first `/api/health` 200 on a database of realistic size (generate one: about 20 collections, about 10k records, relations and files metadata; never use ~/iglo.base-staging).
  - Fix what the profile ranks highest, one change at a time, each measured before and after against main in the same session. Candidates from M7.1c: the read-pool hop cost, record hydration, expand's `publicExport`, JSON writing; startup work that can be deferred or cached safely. Each change must keep every compatibility contract (data and API, AGENTS.md) and D8's per-query deadlines.
  - Whether more threads or processes are worth their shared-state cost: a short written analysis with a measured prototype only if the profile says the single main thread is the limit.
  - docs/perf/P.3-second-pass.md: method, host load, before/after tables in ms for list, filter+sort, expand, view, create at 1, 10 and 50 clients against upstream, startup times, and what was tried and dropped with the reason.
  - `bun run check` and `bun run test:reference` pass locally (D25).
Out of scope: changing API results, the data format or D8's guarantees; new runtime dependencies; macOS or arm64.
Notes from the lead:
  - Correctness over speed: a smaller safe gain beats a larger risky one. If the remaining gap is structural (one JavaScript thread vs Go's goroutines), say so with numbers rather than forcing it.
  - Branch: task/P.3-perf. PR title: "P.3: Performance, second pass".
  - There is no time limit; finish the task. Stop early only for a real blocker, and describe it in the PR and your reply.
```

The worker instructions from `docs/chief-of-staff.md` follow this brief.
