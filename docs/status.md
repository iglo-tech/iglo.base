# Status

Kept by the chief of staff ([runbook](chief-of-staff.md)). Tasks are defined in the [work plan](design/12-work-plan.md).

Updated: 2026-10-27

## Active

| ID | Stage | Branch / PR | Council round | Notes |
|---|---|---|---|---|
| M0.2 | council | [#2](https://github.com/iglo-tech/iglo.base/pull/2) | 2 (head `205fb01`; round 1: Sol APPROVE, Opus CHANGES, fixed by the lead) | [Brief](briefs/M0.2.md). Worker: Claude Haiku 5.5, medium (work plan: mechanical task) |

## Done

| ID | PR | Merged | Notes |
|---|---|---|---|
| M0.1 | [#1](https://github.com/iglo-tech/iglo.base/pull/1) | 2026-10-27 (`f324454`) | Three council rounds. Opus approved every head; Sol's findings (GET 404 text, Go int/CSV flag values, service-name and signed ports, host name address family) were fixed by the lead. Merged by lead decision after round 3 ([comment](https://github.com/iglo-tech/iglo.base/pull/1#issuecomment-6449746607)). Known small gaps for M0.3: `0/tcp` service entries, service names over 25 bytes, Go vs getaddrinfo resolver order |

## Blocked

None.

## For owner review

Decisions and plan changes made by agents while the owner was away.

- 2026-10-27: task briefs are stored in `docs/briefs/<id>.md` so a stateless lead run, a retry or a fixer gets the same brief.
- 2026-10-27 (M0.1 brief): the guest-only `/api/health` response ships first; the superuser fields (`canBackup`, `realIP`, `possibleProxyHeader`) follow with auth in M2.3.
- 2026-10-27 (M0.2 brief): test tools are Mailpit and versitygw (posix backend) as the S3 test server, both from GitHub releases pinned by SHA-256 in `test/differential/upstream.lock`; everything is prepared into git-ignored `.upstream/` by `bun run upstream:prepare`. Network-needing smoke tests run as `bun run test:reference`, separate from `bun run check`.
- 2026-10-27 (M0.1 merge): after three council rounds the lead merged without a fourth round; the last Sol finding was fixed and every earlier head had Opus approval. Reasoning in the PR.
- 2026-10-27 (M0.1): `migrate` is rejected like `update`, naming `01-scope.md`; `superuser`, `--https` and domain arguments fail with "not implemented yet" until M6.2 and M6.3; tests use an `@test/*` alias next to `@/`; oxfmt skips Markdown so it does not rewrite docs owned by other tasks; a wildcard `--http` host (`:port`, `0.0.0.0:port`) listens on IPv4 and IPv6, as Go does, and a host name listens on its first IPv4 address (lead fixes on the PR); unknown GET/HEAD paths answer `File not found.` like the prebuilt binary's static fallback, until pb_public serving lands in M5.7.
- 2026-10-27 (M0.1): the pre-commit hook is enabled through `git config core.hooksPath .githooks`, which is shared by every worktree of the local clone.

## Paused until

Not paused.
