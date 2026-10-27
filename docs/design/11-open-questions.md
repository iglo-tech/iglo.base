# Open questions

Questions that change scope or order and need the owner. Everything else is decided in [Decisions](10-decisions.md). Each one has a default, so work is not blocked.

1. **Where does iglo.base's user documentation live?**
   - **Default:** Markdown in this repository under `docs/` (for example `docs/api/`, `docs/rules.md`), linked from the dashboard at their GitHub URLs. Written in M7 with the operations guide.
   - **Why it matters:** the dashboard's documentation links point to iglo.base docs (D17), so the pages they link to must exist by 1.0. A separate docs site adds hosting and a build step.

## Resolved

Answered by the owner on 2026-10-27:

| Question | Answer |
|---|---|
| Which PocketBase version and features does the data to be moved use? | v0.40.x, no hooks, no custom build, local file storage, backups on S3 ([D15](10-decisions.md#d15-source-data-is-plain-v040x)) |
| What happens with upstream releases after v0.41.0? | Manual review, port security and bug fixes only ([D16](10-decisions.md#d16-upstream-releases-after-v0410-fixes-only-by-hand)) |
| Dashboard branding | iglo.base only, links to iglo.base docs ([D17](10-decisions.md#d17-dashboard-branding-iglobase-only)) |
| Which platforms get release binaries? | linux-x64, linux-arm64, darwin-arm64 ([D18](10-decisions.md#d18-release-platforms)) |
| Is the `update` command needed? | No, dropped ([D19](10-decisions.md#d19-drop-the-update-command)) |
| Where does the first instance run, and is a staging copy of real data available? | Locally; a production backup is available and used in M7, outside the repository ([D20](10-decisions.md#d20-rehearse-the-cutover-on-a-staging-copy-of-production-data)) |
