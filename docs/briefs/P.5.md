# Brief P.5

Written by the chief of staff on 2026-11-05. The first post-MVP task (owner direction 2026-11-05: work through the post-MVP list).

```text
Task P.5: Dashboard tests: the full agent-browser checklist and automated browser tests
Goal: the vendored dashboard is checked end to end against iglo.base once in full, and three flows are covered by automated browser tests that can be rerun on this host.
Read first: AGENTS.md (Tests: "Use agent-browser to verify the admin dashboard"; Rules: no new runtime dependency without a decision), docs/design/08-admin-ui.md (patch set, verification), docs/manual-tests/dashboard.md (the checklist and its earlier runs), docs/design/10-decisions.md (D17 branding, D25, D26, D30), docs/design/12-work-plan.md (P.5, Rules for workers), package.json scripts, bunfig.toml, test/differential/ (how a suite outside `bun test`'s default run is wired, e.g. `test:reference`).
Tools: `agent-browser` is installed at /usr/local/bin/agent-browser (`agent-browser skills get core` explains it). Use only that for browsers; do not add Playwright, Puppeteer or another browser dependency.
Owns: docs/manual-tests/dashboard.md (a new run entry, and fixes to the checklist text where it is out of date), test/browser/ (new), a `test:browser` script in package.json (and bunfig.toml only if needed to keep test/browser/ out of plain `bun test`), docs/design/08-admin-ui.md (verification paragraph), small fixes in src/ or the dashboard patch set for defects the checklist finds, each with a test through a public boundary (a defect larger than a small fix: stop and describe it in the PR; the lead makes it a task).
Depends on: M7.3 (merged).
Acceptance:
  - The full checklist run on the release build (`IGLO_VERSION=0.0.0-p5 bun run build`), every row: install, branding, collections (all field types, rules, indexes, a view collection), records (file, edit, filters, relations, download, thumbnails), auth options and OAuth2 provider setup (configure only; no login, no network), settings (application name, mail test against a local Mailpit or the SMTP sink the test suite uses, never a real server; files storage and backups S3 test against the local S3 test server the suite uses; backups create/list/download/restore/delete; rate limits; trusted proxy; export and import collections), logs (list, chart, entry, filter, settings), crons (list and run), SQL console, realtime. Each row is recorded in a new "Runs" entry with date, commit and pass/fail. Where a screen behaves differently from upstream PocketBase v0.41.0's dashboard on its own binary (.upstream), compare both side by side; a difference is a defect unless 04-api-compatibility.md or D17 lists it.
  - Automated browser tests in test/browser/, driven by the agent-browser CLI from bun test files, each starting the built executable on a fresh `mktemp -d` dir on a free port: (1) install: the installer link creates the first superuser and lands on Collections; (2) a collection-and-record round trip: create a base collection with a few field types, create a record with a file, edit it, see it in the list, delete it, checking each result through the API too; (3) the logs page: a request made through the API shows up in the logs list and its entry opens. `bun run test:browser` runs them; it is not part of `bun run check` (the browser is a host tool), and it fails clearly when agent-browser is missing. Run it three times in a row green.
  - Docs: 08-admin-ui.md says how the dashboard is verified now (checklist plus `test:browser`); AGENTS.md's Verification block gains the `test:browser` line.
  - `bun run check` and `bun run test:reference` pass locally (D25).
Out of scope: OAuth2 logins and anything needing the network beyond localhost, dashboard features or redesign, CI wiring, macOS.
Notes from the lead:
  - Test credentials go in the .md files as AGENTS.md says (test data only). Never touch ~/iglo.base-staging.
  - The host runs other agents; give each run its own port and directory, close every agent-browser session you open, and stop every server you start.
  - Branch: task/P.5-dashboard-tests. PR title: "P.5: Dashboard checklist run and browser tests".
  - There is no time limit; finish the task. Stop early only for a real blocker, and describe it in the PR and your reply.
```

The worker instructions from `docs/chief-of-staff.md` follow this brief.
