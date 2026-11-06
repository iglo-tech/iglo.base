# P.9 Linux only: drop the macOS build

Written by the chief of staff on 2026-11-06. Owner direction (2026-11-06): "we should drop macOS and Windows build, just Linux x86 and arm. If someone wants to run this elsewhere, can use the source code."

Goal: releases ship only `iglo-base_<version>_linux_amd64.zip` and `iglo-base_<version>_linux_arm64.zip` (plus `SHA256SUMS`) and the existing amd64 + arm64 Docker image. Windows was never built; it stays out. Everything that exists only for the darwin executable goes.

## Scope

- `.github/workflows/release.yml`: drop the darwin matrix entry, its build steps, the darwin zip in `SHA256SUMS` and the upload list, and the `shasum` note in the draft notes.
- `.github/workflows/ci.yml`: drop the `check-macos` job; keep `check-linux-arm64`. Fix the comments.
- The bundled macOS SQLite (D34): remove `scripts/build-sqlite.ts`, `scripts/sqlite-embed.ts`, the `dist/libsqlite3.dylib` import in `src/main.ts`, `src/db/sqlite-lib.ts` and every call of it (`main.ts`, `src/db/connect.ts`, backup worker, restore, system-migration checks), `IGLO_SQLITE_LIB`, `test/support/sqlite.ts` and its `bunfig.toml` preload, and `test/db/sqlite-lib.test.ts` with `test/fixtures/sqlite-linux.json` unless something else still needs them. `scripts/build.ts` accepts `bun-linux-x64` and `bun-linux-arm64` only.
- Code paths that exist only for macOS may stay where they are harmless and portable (for example `legacy_alter_table=OFF` in `connect.ts`, which also matches upstream; the `open`/`xdg-open` choice in `main.ts`). Remove only what is darwin-specific dead weight; do not refactor beyond that. Running from source on macOS should keep working as well as it does with Bun's own SQLite; it is not tested or supported.
- `test/support/reference-tools.ts`: drop darwin-arm64 from the hosts it knows, unless removing it breaks running the reference suite from source; then leave it.
- Tests that are skipped or branched only for macOS (`/proc`, sendmail at `/usr/sbin/sendmail`, `Bun.Image` GIF cropping note): leave the behavior; trim macOS-only branches only where they are plainly dead.
- Docs: a new decision D35 in `docs/design/10-decisions.md` ("Linux only", owner direction, amends D18, D24 and D34; D34 stays as history with a note). Update AGENTS.md (Stack and Verification), `docs/releasing.md`, `docs/operations.md`, `docs/differences.md`, README (Platforms table, the `xattr` note, "Windows and Intel Macs are not supported" becomes "Only Linux is supported; on other systems, run from source with Bun"), `docs/design/01-scope.md`, `02-architecture.md`, `04-api-compatibility.md` (the arm64 GIF difference stays; drop the macOS wording), `12-work-plan.md` (P.9 row is already there). Do not edit old briefs or old perf reports.
- The 1.0.0 and 1.1.0 releases keep their darwin archives. Do not touch published releases.

## Verification

- `bun run check` and `bun run test:reference` pass locally, twice.
- `bun run build` with `IGLO_TARGET=bun-darwin-arm64` is refused with a clear message.
- One on-demand `ci.yml` run (`gh workflow run ci.yml --ref <branch>`), `check-linux-arm64` green or failing only on known P.6 flakes (name them).
- `release.yml` cannot be run without a tag: check it with `actionlint` if available, otherwise read it carefully, and say which in the PR.

Worker rules from `docs/design/12-work-plan.md` apply. Open a PR against `main`; do not merge.

## Added after P.8 merged

- P.8 (#74) added a macOS platform note to `docs/differences.md` (upstream's watcher on macOS misses markers created and removed at once) and skips one differential notify test on macOS. Remove the note; the skip may stay only if it is harmless, otherwise drop the darwin branch.
- P.6 (#75) is still open and touches `ci.yml` comments, `test/support/executable.ts` and test timeouts. Rebase on main before you open the PR, and if #75 has merged by then, resolve conflicts in its favour.
