# Brief P.8

Written by the chief of staff on 2026-11-06. Found in the P.4 review: CLI changes to settings and collections do not reach a running server.

```text
Task P.8: Multi-instance notify watcher
Goal: a running iglo.base picks up settings and collections changes made by another process on the same pb_data (a CLI command such as `superuser ips`, `migrate up`, `migrate down`, `migrate collections`, or another server instance) the way PocketBase v0.41.0 does, and iglo.base's own changes notify other instances (including a running PocketBase) the same way.
Read first: AGENTS.md, docs/design/02-architecture.md (threads; the collections cache and settings), docs/design/03-data-compatibility.md, docs/design/10-decisions.md (D8, D26), upstream core/notify_watcher.go and core/notify_watcher_test.go, core/base.go (LocalNotifyDirName, registerNotifyWatcherHooks, where settings and collections reload), src/app/bootstrap.ts (the "not here yet" note), the modules that own the settings and collections caches, docs/operations.md and docs/differences.md ("Known gap" row).
Owns: a new src/app/notify-watcher.ts (or the module upstream's layout suggests), the bootstrap and terminate wiring, the hooks where settings and collections saves write the marker files, the cache reload entry points it calls, tests in test/, docs/operations.md and docs/differences.md (remove the restart notes and the "Known gap" row once it works), docs/design/02-architecture.md.
Depends on: P.4 (merged).
Acceptance:
  - Same files and timing as upstream: the `.notify` directory in the data dir, one marker per instance (`settings@<id>`, `collections@<id>`) written and removed after a save, a watcher that ignores its own instance's markers and reloads settings or the collections cache about 50 ms after another's (check upstream for the exact debounce and which events count), the markers removed on terminate, a failure to watch logged once as a warning and not fatal. Use Bun/Node `fs.watch` (no new dependency); check it works on Linux and macOS (the macOS CI job), and on a Docker volume.
  - Only the main thread holds the caches (D8); if a worker keeps its own copy (read pool, log writer), it must see the reload too, or say why it does not need to.
  - Tests through public boundaries with the release executable: (1) `superuser ips` set and cleared by the CLI while the server runs takes effect within about 1 s without restart (requests 403/200 as upstream); (2) `migrate up` that creates a collection and one that changes a rule, while the server runs: the API serves the new state without restart; (3) a settings change through the API on iglo.base makes a running upstream PocketBase v0.41.0 on the same pb_data reload (differential, upstream binary from .upstream), and the reverse; (4) no reload storm: a burst of 100 saves causes a bounded number of reloads. Use waits on conditions, not fixed sleeps.
  - No iglo-specific files or rows (the data contract): `.notify` is upstream's own directory.
  - Before/after numbers for a settings save and a collection save (AGENTS.md: changes to the database access layer need measurements) in docs/perf/P.8-notify.md.
  - `bun run check` and `bun run test:reference` pass locally (D25).
Out of scope: realtime across instances (upstream does not do it either), anything beyond settings and collections.
Notes from the lead:
  - Branch: task/P.8-notify-watcher. PR title: "P.8: Notify watcher for settings and collections".
  - P.6 (test reliability) runs at the same time and changes test/ harness files; keep your test changes in new files where you can, and rebase on origin/main before you finish.
  - There is no time limit; finish the task. Stop early only for a real blocker, and describe it in the PR and your reply.
```

The worker instructions from `docs/chief-of-staff.md` follow this brief.
