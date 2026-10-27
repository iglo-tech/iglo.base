# Open questions

Questions that change scope or order and need the owner. Everything else is decided in [Decisions](10-decisions.md). Each one has a default, so work is not blocked.

1. **Which PocketBase version and features does the data to be moved use?**
   - **Default:** v0.40.x, no `pb_hooks`, no custom Go build, local file storage.
   - **Why it matters:** older data needs one run of PocketBase v0.40.6 first (D12). Hooks need a plan to move their logic before cutover. S3 storage moves S3 testing earlier in M5.

2. **What happens with upstream releases after v0.40.6?**
   - **Default:** review each upstream release by hand. Port security fixes and bug fixes that do not change the data format. Changes to the data format or API are not followed in 1.x; following them would be a new compatibility target and a new major version.
   - **Why it matters:** apps upgrading their SDKs past v0.40-era versions may expect newer server behavior.

3. **Dashboard branding.**
   - **Default:** "iglo.base" name and logo, "PocketBase-compatible" with a link to PocketBase, documentation links to pocketbase.io.
   - **Why it matters:** it is a small patch either way, but it decides whether users see a different product.

4. **Which platforms get release binaries?**
   - **Default:** linux-x64, linux-arm64, darwin-arm64, like other iglo.\* projects. Upstream also ships Windows, FreeBSD, 32-bit ARM and others.
   - **Why it matters:** Windows needs extra work (no `sendmail`, restart-by-re-exec, file locking during restore).

5. **Is the `update` command needed?**
   - **Default:** yes, downloading iglo.base releases from GitHub, so `iglo.base update` replaces `pocketbase update` in existing workflows.
   - **Why it matters:** if deployments are always updated by the deploy pipeline, it can be dropped, removing a network feature.

6. **Where does the first instance run, and is a staging copy of real data available?**
   - **Default:** a staging copy of the current production `pb_data` is used in M7 to rehearse the move and the rollback.
   - **Why it matters:** real data catches field and rule combinations no fixture has.
