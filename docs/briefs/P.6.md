# Brief P.6

Written by the chief of staff on 2026-11-06. Test reliability: the v1.1.0 release checks hit two known flakes again (realtime cascade order on macOS, the batch-files timestamp pairing on linux-arm64).

```text
Task P.6: Test reliability
Goal: `bun run check` and `bun run test:reference` give the same result on every run on this host and on the GitHub arm64 and macOS runners, so a failure always means a defect.
Read first: AGENTS.md (Tests, Verification), docs/design/10-decisions.md (D25, D26), docs/status.md "Hardening backlog" (every row whose Area names tests, a test harness, or a test file), test/support/executable.ts, test/differential/harness/ (compare.ts, the normalizers), the failing tests named below.
Owns: test/ (harness, support and the flaky tests), bunfig.toml and package.json test scripts if needed, docs/status.md is the lead's (list the rows you closed in the PR body; the lead removes them).
Depends on: P.2 (merged).
The flakes (each seen at least once; reproduce, find the cause, fix it):
  - test/differential/realtime/realtime.test.ts "a user delete updates the records that reference it": cascade notifications arrive in varying order (macOS run 42183686087 on 2026-11-06, and earlier on linux).
  - test/differential/auth/oauth2-flows.test.ts:365 realtime messages of a new user arrive in either order; :255 requires `updated === created` on a new `_externalAuths` row.
  - test/differential/sdk/batch.test.ts "files in a batch, rules and auth": a create and update of the same record in one batch share or split a millisecond `updated` ("timestamps not paired consistently", linux-arm64 run 42183686087).
  - apis/sql_test.go TestSQLRun and the SDK suite's "SQLService > sql" compare `execTime` exactly.
  - test/differential/files/serve.test.ts:493 "HEAD of a thumb" `Last-Modified` across a second boundary.
  - test/differential/auth/otp-flows.test.ts "the message of each server is the same" (`verified` true vs false once).
  - S3-files test: pb_data copied while a `ranges_*` temp file is being deleted (cause found in the P.2 review).
  - `freePort()` races ("address already in use") and test:reference port collisions on a shared host.
  - Stack-depth tests (JSON parser `TestMaxRecursion`, MIME JSON) that overflow in a full `check` run but pass alone.
  - test/oauth2/safe-file.test.ts "the deadline covers a slow name resolution"; the collections "dry run reports query errors and timeouts" 1 ms timeout; test/differential/backups/backups.test.ts:301 `keys()` on a 400.
Rules for the fixes:
  - Fix the cause in the harness or the test: wait for a condition instead of a fixed delay, compare event sets where upstream itself does not order them (check upstream's code to prove it does not), normalize a value only where upstream's own two runs can differ the same way (the harness's existing "generated timestamp" rules show how), allocate ports so that parallel agents on this host cannot collide. Never weaken a comparison so far that a real difference would pass, and never skip or retry a test to hide a flake. If a flake turns out to be a product defect, fix it with a test through a public boundary when it is small; otherwise stop and describe it.
  - Prove each fix: run the affected test file in a loop (at least 20 runs, or until the old failure rate makes a pass meaningful, with the numbers in the PR), then the full `bun run check` and `bun run test:reference` twice each, one after the other. Then run `gh workflow run ci.yml --ref <your branch>` once and wait with `gh run watch` (allowed in this task); report each job's result.
Out of scope: product behavior changes beyond a small defect a flake reveals; the non-test rows of the hardening backlog (P.7).
Notes from the lead:
  - The host runs other agents; give each test server its own port and directory, and stop every server you start.
  - Branch: task/P.6-test-reliability. PR title: "P.6: Test reliability".
  - There is no time limit; finish the task. Stop early only for a real blocker, and describe it in the PR and your reply.
```

The worker instructions from `docs/chief-of-staff.md` follow this brief.
