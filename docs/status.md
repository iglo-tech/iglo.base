# Status

Kept by the chief of staff ([runbook](chief-of-staff.md)). Tasks are defined in the [work plan](design/12-work-plan.md).

Updated: 2026-10-27

## Active

| ID | Stage | Branch / PR | Council round | Notes |
|---|---|---|---|---|
| M0.1 | worker | `task/M0.1-skeleton` | 0 | [Brief](briefs/M0.1.md). Worker: Claude Opus 5.5, medium |

## Done

| ID | PR | Merged | Notes |
|---|---|---|---|

## Blocked

None.

## For owner review

Decisions and plan changes made by agents while the owner was away.

- 2026-10-27: task briefs are stored in `docs/briefs/<id>.md` so a stateless lead run, a retry or a fixer gets the same brief.
- 2026-10-27 (M0.1 brief): the guest-only `/api/health` response ships first; the superuser fields (`canBackup`, `realIP`, `possibleProxyHeader`) follow with auth in M2.3.

## Paused until

Not paused.
