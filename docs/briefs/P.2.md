# Brief P.2

Written by the chief of staff on 2026-11-05. macOS and linux-arm64 builds (D24's post-1.0 part).

```text
Task P.2: macOS (darwin-arm64) and linux-arm64 builds
Goal: every release also ships darwin-arm64 and linux-arm64 executables, each tested on its own platform, and the Docker image also exists for linux/arm64; on macOS the executable uses a bundled SQLite so its behaviour does not depend on the macOS version.
Read first: AGENTS.md (Stack, Verification), docs/design/10-decisions.md (D3, D8, D18, D24, D25, D33 and the decision D24 amends), docs/design/03-data-compatibility.md (SQLite version, `legacy_alter_table`, math and JSON functions, the macOS paragraph), docs/releasing.md, .github/workflows/release.yml, .github/workflows/docker.yml, .github/workflows/ci.yml, scripts/build.ts, src/db/ (where connections are opened; `Database.setCustomSQLite` must run before the first one, also in every worker: read pool, backup, log writer, thumbnails).
Owns: scripts/build.ts (targets), .github/workflows/release.yml, docker.yml and ci.yml (new jobs), Dockerfile (multi-arch), the macOS SQLite loading code in src/db/ and its tests, docs/releasing.md, docs/design/03-data-compatibility.md and 02-architecture.md (platforms), a decision record D34 (how the macOS SQLite is built, shipped and loaded), AGENTS.md (the "linux-x64 only" lines).
Depends on: M7.3, P.1 (merged).
Acceptance:
  - Build: `bun build --compile --target=bun-darwin-arm64` and `bun-linux-arm64` (same entry points and bytecode flags as linux-x64), archives named like the linux-x64 one (`iglo-base_<version>_<os>_<arch>.zip`), all in one `SHA256SUMS`.
  - macOS SQLite: the same SQLite version and compile options as Bun's bundled SQLite on Linux (3.53.4 with Bun 1.4.4: check it with `sqlite_version()` and `PRAGMA compile_options` on linux), built from source fetched only from GitHub (the official mirror github.com/sqlite/sqlite at the matching tag, or another GitHub-hosted source), never from sqlite.org or other hosts (hard limit: no external services beyond GitHub and the upstream forge). How the library travels with a one-file executable (embedded and written to a private cache path on first start, or shipped next to the executable in the archive) is your design call; record it in D34 with the reason, and make the executable fail with a clear message, not silently fall back to the system SQLite, if the library cannot be loaded.
  - Native tests on GitHub runners (the only place these platforms exist; D25 still holds for linux-x64): a `ci.yml` workflow_dispatch job per platform (macos arm64 runner, ubuntu arm64 runner) runs `bun run check` and `bun run test:reference`; the macOS job also proves the bundled SQLite is in use (`sqlite_version()` and compile options equal Linux's). Run them on your branch with `gh workflow run ci.yml --ref <branch>` and wait with `gh run watch` (allowed in this task). If upstream's reference binary for a platform is missing from the pinned tools, say so and run what can run.
  - release.yml builds and smoke-tests each executable on its own runner (or cross-builds on linux and smoke-tests natively), then attaches all three archives to the draft release. Prove it with one test tag `v0.0.0-test.2` pushed from your branch: watch it green, download the draft's darwin-arm64 and linux-arm64 archives, check `SHA256SUMS`, then delete the draft and the tag (`gh release delete v0.0.0-test.2 --yes --cleanup-tag`). No other tags, publish nothing.
  - docker.yml builds linux/amd64 and linux/arm64 from the release's linux archives into one multi-arch manifest. Do not run docker.yml (it pushes to ghcr.io); the lead runs it after merge. Verify the arm64 image locally only if this host can run it (it cannot without qemu; then say so).
  - Docs updated; `bun run check` and `bun run test:reference` pass locally on linux-x64.
Out of scope: Windows (D18), darwin-x64, signing and notarization (note in docs/releasing.md that macOS users must clear the quarantine attribute: `xattr -d com.apple.quarantine iglo-base`), Homebrew.
Notes from the lead:
  - GitHub-hosted runner minutes are fine; keep runs few and purposeful.
  - Branch: task/P.2-platforms. PR title: "P.2: macOS and linux-arm64 builds".
  - There is no time limit; finish the task. Stop early only for a real blocker, and describe it in the PR and your reply.
```

The worker instructions from `docs/chief-of-staff.md` follow this brief.
