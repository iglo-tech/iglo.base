# Status

Kept by the chief of staff ([runbook](chief-of-staff.md)). Tasks are defined in the [work plan](design/12-work-plan.md).

Updated: 2026-10-27

## Active

| ID | Stage | Branch / PR | Council round | Notes |
|---|---|---|---|---|
| M0.1 | council | [#1](https://github.com/iglo-tech/iglo.base/pull/1) | 3 (head `ba25b3f`; rounds 1–2: Opus APPROVE, Sol CHANGES, fixed by the lead) | [Brief](briefs/M0.1.md). Worker: Claude Opus 5.5, medium |

## Done

| ID | PR | Merged | Notes |
|---|---|---|---|

## Blocked

None.

## For owner review

Decisions and plan changes made by agents while the owner was away.

- 2026-10-27: task briefs are stored in `docs/briefs/<id>.md` so a stateless lead run, a retry or a fixer gets the same brief.
- 2026-10-27 (M0.1 brief): the guest-only `/api/health` response ships first; the superuser fields (`canBackup`, `realIP`, `possibleProxyHeader`) follow with auth in M2.3.
- 2026-10-27 (M0.1): `migrate` is rejected like `update`, naming `01-scope.md`; `superuser`, `--https` and domain arguments fail with "not implemented yet" until M6.2 and M6.3; tests use an `@test/*` alias next to `@/`; oxfmt skips Markdown so it does not rewrite docs owned by other tasks; a wildcard `--http` host (`:port`, `0.0.0.0:port`) listens on IPv4 and IPv6, as Go does (lead fix on the PR); unknown GET/HEAD paths answer `File not found.` like the prebuilt binary's static fallback, until pb_public serving lands in M5.7.
- 2026-10-27 (M0.1): the pre-commit hook is enabled through `git config core.hooksPath .githooks`, which is shared by every worktree of the local clone.

## Paused until

Not paused.
