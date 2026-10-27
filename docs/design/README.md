# iglo.base design

Kickoff design for porting PocketBase v0.40.6 to Bun + SQLite, without its extension surface, as a drop-in replacement. Read in order.

| # | Doc | Covers |
|---|---|---|
| 1 | [Scope](01-scope.md) | Goals, non-goals, exactly what is removed (the extension surface) and what is kept |
| 2 | [Architecture](02-architecture.md) | Runtime, process model, SQLite access, module layout, configuration, dependencies |
| 3 | [Data compatibility](03-data-compatibility.md) | The `pb_data` format, schema, values, system migrations, settings, tokens, backups, cutover and rollback |
| 4 | [API compatibility](04-api-compatibility.md) | What compatible means, every endpoint, realtime, batch, files, deliberate differences |
| 5 | [Rules and filters](05-rules-and-filters.md) | The filter language and the semantics that must match exactly |
| 6 | [Auth](06-auth.md) | Tokens, password, OTP, MFA, OAuth2 providers, emails, rate limits |
| 7 | [Files, mail, backups, jobs and logs](07-files-mail-backups-jobs.md) | Local and S3 storage, thumbnails, SMTP, backups, built-in cron jobs, logs |
| 8 | [Admin UI](08-admin-ui.md) | Reusing upstream's dashboard, the patch set, installer |
| 9 | [Port plan](09-port-plan.md) | Upstream baseline, what is ported, milestones, testing strategy |
| 10 | [Decisions](10-decisions.md) | Short decision records with reasons |
| 11 | [Open questions](11-open-questions.md) | What still needs the owner |

## Decisions at a glance

- Port of PocketBase **v0.40.6** (`9d281cc`, 2026-10-23), not an upstream-tracking fork.
- **MIT**, inherited from PocketBase, with its copyright notice kept.
- **Bun ≥ 1.4, TypeScript, one compiled executable.** No Docker.
- **The extension surface is removed:** no Go framework mode, `pb_hooks`, `pb_migrations`, `migrate` command or dashboard extensions. The `update` command is also dropped (D19). Nothing else is removed.
- **PocketBase's `pb_data` format, unchanged and two-way:** open existing data without migration, and leave it readable by PocketBase for rollback.
- **PocketBase's API, verified against the upstream binary** by a differential test suite seeded with upstream's ~720 API scenarios.
- **Upstream's dashboard is reused** with a small, listed patch set and iglo.base branding only (D17).
- **Upstream releases after v0.40.6:** security and bug fixes ported by hand (D16).
- **Release binaries:** linux-x64, linux-arm64, darwin-arm64 (D18).
- **Filters and rules are ported file by file,** aiming for the same SQL, because they are security boundaries.
- **Upstream's names stay:** `pb_data`, `pb_public`, `PB_*` variables, flags and commands.

## Status

Design phase. No code. The [port plan](09-port-plan.md) starts with the skeleton and the spikes that settle the two provisional decisions (D8 SQLite access, D10 thumbnails).
