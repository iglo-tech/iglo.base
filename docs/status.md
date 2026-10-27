# Status

Kept by the chief of staff ([runbook](chief-of-staff.md)). Tasks are defined in the [work plan](design/12-work-plan.md).

Updated: 2026-10-28

## Active

| ID | Stage | Branch / PR | Council round | Notes |
|---|---|---|---|---|
| M0.4 | fix | [#4](https://github.com/iglo-tech/iglo.base/pull/4) | 2 → fix (round 2 at `f3fd190`: Opus APPROVE, Sol CHANGES: lossless lastInsertId, multi-statement scripts, last-statement rowsAffected, incremental reads with duplicate column names, `__proto__` identifiers. An Opus fixer is working on these plus Opus's non-blocking rows() iterator note; next: council round 3. After merge, the lead adds dbx's notice to `LICENSE`) | [Brief](briefs/M0.4.md). Worker: Claude Opus 5.5, medium. Chosen as the next critical-path task (M1 depends on it) |

## Done

| ID | PR | Merged | Notes |
|---|---|---|---|
| M0.3 | [#3](https://github.com/iglo-tech/iglo.base/pull/3) | 2026-10-27 (`d623b82`) | Three council rounds, all CHANGES from both members. Merged by lead decision after round 3 with no fourth round ([decision](https://github.com/iglo-tech/iglo.base/pull/3#issuecomment-6454783462)). The round-3 findings (JSON name folding, XML text, names and numbers, JSON BOM and trailing bytes, signed NaN) were fixed at `aebad19`. Carried gaps: quoted multipart boundaries (M0.8/M3.2); XML into `any` fields; rare Unicode folds |
| M0.2 | [#2](https://github.com/iglo-tech/iglo.base/pull/2) | 2026-10-27 (`ca2cd61`) | Two council rounds. Round 1: Sol APPROVE, Opus CHANGES (upstream's first-start installer opened a browser and created its superuser after tests began); fixed by the lead with no-op `open`/`xdg-open` on the child PATH and a wait for the installer. Round 2: both APPROVE. PocketBase publishes no checksums, so its archive hashes come from single downloads |
| M0.1 | [#1](https://github.com/iglo-tech/iglo.base/pull/1) | 2026-10-27 (`f324454`) | Three council rounds. Opus approved every head; Sol's findings (GET 404 text, Go int/CSV flag values, service-name and signed ports, host name address family) were fixed by the lead. Merged by lead decision after round 3 ([comment](https://github.com/iglo-tech/iglo.base/pull/1#issuecomment-6449746607)). Known small gaps for M0.3: `0/tcp` service entries, service names over 25 bytes, Go vs getaddrinfo resolver order |

## Blocked

None.

## For owner review

Decisions and plan changes made by agents while the owner was away.

- 2026-10-27: task briefs are stored in `docs/briefs/<id>.md` so a stateless lead run, a retry or a fixer gets the same brief.
- 2026-10-27 (M0.1 brief): the guest-only `/api/health` response ships first; the superuser fields (`canBackup`, `realIP`, `possibleProxyHeader`) follow with auth in M2.3.
- 2026-10-27 (M0.2 brief): test tools are Mailpit and versitygw (posix backend) as the S3 test server, both from GitHub releases pinned by SHA-256 in `test/differential/upstream.lock`; everything is prepared into git-ignored `.upstream/` by `bun run upstream:prepare`. Network-needing smoke tests run as `bun run test:reference`, separate from `bun run check`.
- 2026-10-27 (M0.3): D22 — `Bun.serve` normalizes requests before the handler: `.`/`..` (and `%2e%2e`) segments and `\` in paths are resolved (upstream redirects with 307 or answers 404), and repeated header lines are joined with `, ` (upstream rules see the first). Recorded as a deliberate difference instead of moving to `node:http`. Temporary gap: `?fields=` on `/api/health` is ignored until M2.4 ports the picker.
- 2026-10-27 (M0.3 brief): the app context and clock live in a new `src/app/` module; the default middlewares owned by later tasks get no-op placeholder slots in upstream's order; ported unit tables for the router, event and error helpers are allowed as internal tests because these are shared contracts.
- 2026-10-27 (M0.2 merge): the runbook now points workers and the council at `.upstream/pocketbase` (or the same pinned checkout at `/home/t3-code/upstream/pocketbase`).
- 2026-10-27 (M0.1 merge): after three council rounds the lead merged without a fourth round; the last Sol finding was fixed and every earlier head had Opus approval. Reasoning in the PR.
- 2026-10-27 (M0.1): `migrate` is rejected like `update`, naming `01-scope.md`; `superuser`, `--https` and domain arguments fail with "not implemented yet" until M6.2 and M6.3; tests use an `@test/*` alias next to `@/`; oxfmt skips Markdown so it does not rewrite docs owned by other tasks; a wildcard `--http` host (`:port`, `0.0.0.0:port`) listens on IPv4 and IPv6, as Go does, and a host name listens on its first IPv4 address (lead fixes on the PR); unknown GET/HEAD paths answer `File not found.` like the prebuilt binary's static fallback, until pb_public serving lands in M5.7.
- 2026-10-27 (M0.1): the pre-commit hook is enabled through `git config core.hooksPath .githooks`, which is shared by every worktree of the local clone.

- 2026-10-27 (M0.3, after round 3): the lead decided with no fourth council round. Every reproduced XML, JSON, form and case-folding mismatch is fixed in the PR. Temporary gap: quoted multipart boundaries that contain `;`, `"` or `\` are rejected by Bun's `formData()` but accepted upstream. M0.8 (multipart spike) and M3.2 own that path; M3.2 must close the gap or list it in `04-api-compatibility.md`.

- 2026-10-27 (M0.4 brief): M0.4 builds src/db and its tests but does not wire the databases into `serve`. M1.2 does that together with the system migrations, so `serve` never creates an unmigrated pb_data. Reads run on the main-thread connection behind upstream's concurrent/nonconcurrent API until the M0.6 spike decides D8. dbx v1.13.0 is read from the pinned checkout `/home/t3-code/upstream/dbx`.

- 2026-10-27 (M0.4 PR): the lead accepted the worker's open points. `bun:sqlite` cannot set SQLITE_DBCONFIG_DEFENSIVE (`_defensive=1`); this is documented in `03-data-compatibility.md` and no native addon is added. The fixture tests live in `test/differential/db/`, because only `test:reference` prepares upstream's `tests/data`. The one-line fix to `05-rules-and-filters.md` is accepted. Reading integers above 2^53 without losing precision was first left for M1.8; after council round 1, the lead decided that the db layer reads integers losslessly: `number` within the safe range, `bigint` outside it.

- 2026-10-27 (M0.4): dbx v1.13.0 is MIT (Copyright (c) 2016, Qiang Xue). Its notice is kept with the translated files.

## Paused until

Not paused. The last pause (Claude API rate limit) ended 2026-10-27T22:30:14+01:00.
