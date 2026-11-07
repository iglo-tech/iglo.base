# Releasing

iglo.base ships one compiled executable per platform: linux-x64 and linux-arm64 (D24, D3, D35). There is no macOS or Windows build; releases 1.0.0 and 1.1.0 keep the archives they were published with.
`.github/workflows/release.yml` builds each on a runner of its own platform.

## How to release

1. Run `bun run check` and `bun run test:reference` on the host (D25) from the commit to release.
2. Tag that commit and push the tag: `git tag v0.1.0 && git push origin v0.1.0`. The tag must be `vMAJOR.MINOR.PATCH` with an optional `-prerelease` suffix; the workflow fails on anything else.
3. The workflow builds with the version from the tag on two runners (`ubuntu-latest`, `ubuntu-24.04-arm`), smoke-tests each executable on its own platform (`--version` prints the tag's version, `serve` on a temporary directory answers `/api/health` with 200), archives them, writes one `SHA256SUMS` and creates a **draft** GitHub release. The linux-x64 job also runs `bun run check`. Tags with a `-` suffix are marked as pre-releases. `test:reference` is not part of the workflow (it takes over 10 minutes); it is the manual step 1 for linux-x64. For linux-arm64 start the on-demand CI workflow before tagging (`gh workflow run ci.yml --ref <branch>`): its job `check-linux-arm64` runs `bun run check` and `bun run test:reference` natively.
4. Review the draft and publish it by hand. Nothing is public until then.

`workflow_dispatch` is a dry run, also when it is started on a tag: it builds and uploads the archive as a workflow artifact (version `0.0.0-dryrun.<run number>`) and creates no release.

## What it produces

- `iglo-base_<version>_linux_amd64.zip` and `iglo-base_<version>_linux_arm64.zip`, each containing `iglo-base` (the executable), `LICENSE` and `README.txt` (a pointer to the repository). `<version>` is the tag without the leading `v`.
- `SHA256SUMS`, with the SHA-256 checksum of both archives.

`IGLO_TARGET=bun-linux-arm64 bun run build` cross-compiles a linux-arm64 executable on any host; `bun-linux-x64` and `bun-linux-arm64` are the only targets `scripts/build.ts` accepts (D35).

The executables are not signed or notarized.

`iglo-base --version` prints `iglo-base version <version>`; a build outside the release (plain `bun run build`) prints `iglo-base version (untracked)`. The version is set at build time: `IGLO_VERSION=0.1.0 bun run build` (`scripts/build.ts` passes it to `bun build --define` and to the dashboard footer).

## Image

`.github/workflows/docker.yml` wraps a published release in one multi-arch image, linux/amd64 and linux/arm64 (D33, D35). It runs when a release is published, and by hand with `workflow_dispatch` and a `tag` input (for example `v1.0.0`) for a release that already exists. It does not build iglo.base: it downloads `iglo-base_<version>_linux_amd64.zip`, `iglo-base_<version>_linux_arm64.zip` and `SHA256SUMS` with `gh release download` (`scripts/docker-context.sh`), checks the checksums, and the `Dockerfile` copies the executable of the image's architecture into `gcr.io/distroless/base-debian13:nonroot` (pinned by digest; it must list linux/arm64). Before pushing, each architecture's image is built and smoke-tested on a runner of that architecture (`ubuntu-latest`, `ubuntu-24.04-arm`; no emulation), then one `docker buildx build --platform linux/amd64,linux/arm64 --push` publishes the manifest. The smoke test: `--version` prints the version, `serve` answers `/api/health` with 200 and `docker stop` exits 0. The checkout does not keep the job token.

It pushes `ghcr.io/iglo-tech/iglo.base:<version>` and `:latest` only when the tag is the repository's latest published release (`gh release view` without a tag, never a pre-release), so rebuilding an older release or a patch on an older line does not move it. Only this job has `packages: write`; there are no other secrets. A draft release is refused.

```sh
docker run -d --name iglo -p 8090:8090 -v iglo-data:/pb_data ghcr.io/iglo-tech/iglo.base:1.0.0
```

- The executable is `/iglo-base` and the working directory is `/`, so the defaults "next to the executable" are the volumes, for `serve` and for every other command, without `--dir`: `/pb_data` (data; declared a volume), `/pb_migrations` (auto-generated migration files that dashboard changes write; declared a volume), `/pb_public` (static files served at `/`; mount it, it is not declared) and `/pb_hooks` (not supported; iglo.base warns when it exists). Mount what you need to keep. If you override the command, `serve` plus your flags is enough; no path flag is required.
- Run other commands in the running container or as a one-off container; both land on the same volumes:

  ```sh
  docker exec iglo /iglo-base superuser upsert admin@example.com 'a long password'
  docker run --rm -v iglo-data:/pb_data ghcr.io/iglo-tech/iglo.base:1.0.0 superuser upsert admin@example.com 'a long password'
  docker run --rm -it -v iglo-data:/pb_data -v iglo-migrations:/pb_migrations ghcr.io/iglo-tech/iglo.base:1.0.0 migrate collections
  ```

  There is no shell in the image, so use the full path `/iglo-base` with `docker exec`.
- The process runs as uid/gid 65532 and is PID 1. A new named volume takes that ownership from the image. A directory taken over from PocketBase (usually root-owned) must be handed over first: `chown -R 65532:65532 <dir>` with rootful Docker. With rootless Docker or Podman, uid 65532 maps to a host subuid, so `chown` as the host user does not help; instead run the container with `--user 0:0`: under rootless Docker the host user who owns the directory is uid 0 inside the container, so this is that user, not host root, and the files stay owned by them. Rootless Podman maps the same way: `--user 0:0` or `--userns=keep-id`. This also leaves nothing to change back for a rollback.
- Back up or copy the whole data directory, never only `data.db`: `-wal` and `-shm` files remain after a crash or a kill (a clean stop removes them).
- No shell, `wget` or `curl` exists in the image, so compose or Kubernetes health checks that exec into the container cannot work. Check `/api/health` from the host or the reverse proxy instead.
- The image is not an official PocketBase image. Update the digest in the `Dockerfile` by hand when the base needs a refresh.

## SDK releases

The JavaScript SDK in `sdk/` is published independently to npm as `iglo.base` under `sdk-v<version>` tags (D36). `.github/workflows/sdk-release.yml` automates releases.

### How to release

1. In a single PR, bump `"version"` in `sdk/package.json` and add a new section `## <version>` in `sdk/CHANGELOG.md` with the release notes.
2. Merging the PR to `main` triggers `.github/workflows/sdk-release.yml`.
3. The workflow runs three isolated jobs under least privilege:
   - `check` (read-only, `contents: read`): checks out without persistent credentials (`persist-credentials: false`), sets up Node 24 and Bun, verifies `npm --version` >= 11.5.1, validates semver, checks git tags via `git ls-remote --exit-code`, checks npm registry via `npm view --json` (only `E404` is treated as not published; network or server errors fail immediately), extracts non-empty release notes from `sdk/CHANGELOG.md`, runs lint, SDK typecheck, SDK unit tests (`bun test sdk/test`), build (`bun run sdk:build`), package checks (`bun run sdk:check-package`), and uploads `sdk/dist` as an artifact (`sdk-dist`).
   - `publish` (`contents: read`, `id-token: write`): downloads the `sdk-dist` artifact and publishes the exact build with `npm publish --provenance --access public`. Plain versions publish under `--tag latest`; prerelease versions (`*-*`) publish under `--tag next`. Every non-prerelease version publishes as `latest`; if a patch release is made on an older maintenance line (e.g. 1.0.5 after 1.1.0), it moves the `latest` tag unless managed manually with `npm dist-tag`. If the repository secret `NPM_TOKEN` is present, it is used as `NODE_AUTH_TOKEN` (for the initial bootstrap); otherwise OIDC trusted publishing is used. If the version is already published on npm, this job is skipped on real runs (on dry runs of an existing version, it runs `npm pack --dry-run`).
   - `release` (`contents: write`): runs when `publish` succeeds or was skipped because the version is already on npm. It resolves the commit that was published using the npm registry's `gitHead` (`npm view iglo.base@<version> gitHead`), failing on registry errors and falling back to the workflow commit only if `gitHead` is absent. It checks if the git tag `sdk-v<version>` and GitHub release exist, and creates only what is missing. Prerelease versions create GitHub releases with `--prerelease`. All SDK releases use `--latest=false` so server releases remain latest.

If both `iglo.base@<version>` and tag `sdk-v<version>` already exist, the workflow exits successfully without republishing. If the git tag exists on remote but npm does not have the version, the workflow fails loudly so the mismatch can be investigated.

### Partial failure recovery

If the `publish` step succeeds on npm but the subsequent tag or GitHub release creation fails (or a runner terminates), the workflow is safely recoverable:
- Re-running the workflow with "Re-run all jobs" (choose "Re-run all jobs", not only failed jobs, so `check` re-detects that `iglo.base@<version>` is already published on npm rather than reusing a cached `npm_exists=false`).
- The `publish` job is skipped (preventing npm `E403` cannot publish over existing version errors).
- The `release` job runs, reads `npm view iglo.base@<version> gitHead` to point the tag at the published commit (failing on registry errors, and falling back to the workflow commit only if `gitHead` is absent), and creates the missing git tag and GitHub release with the release notes from `sdk/CHANGELOG.md`.
- For manual recovery, check the published commit with `npm view iglo.base@<version> gitHead`, tag it with `git tag sdk-v<version> <commit> && git push origin sdk-v<version>`, and run `gh release create sdk-v<version> --title sdk-v<version> --notes-file <notes> --latest=false`.

### Dry run and branch rules

- Manual runs via `workflow_dispatch` default to `dry-run: true`.
- A real publish (`dry-run: false`) is only permitted when running on `refs/heads/main`; running on any other branch with dry-run off fails early with a clear error.
- Running a dry run on an already published version still runs the full build and checks, then runs `npm pack --dry-run` with a notice that the version is already published (because current npm's `npm publish --dry-run` fails with exit 1 on existing versions). For an unpublished version, dry run executes `npm publish --dry-run`. This allows packaging verification at any time on any branch.

### One-time npm setup and bootstrap

Releases use npm trusted publishing (OIDC with `permissions: id-token: write`). npm trusted publishing requires npm CLI >= 11.5.1 and Node >= 22.14.0 (the workflow runs Node 24 with npm 11).

npm requires that a package already exist on the registry before a trusted publisher can be configured in package settings. In addition, npm enforces that a newly created trusted publisher configuration must complete its first successful publish within 2 days (48 hours); if not validated within 2 days, the configuration expires and can no longer be used or edited. Because `iglo.base` is a new package, the first release (1.0.0) requires a one-time bootstrap:

1. **Create the granular bootstrap token and repository secret:**
   - On npmjs.com, generate a **granular access token** with **"All packages"** set to **Read and write (publish and stage)**. Check **"Bypass two-factor authentication"** (required so automated CI can publish without an interactive OTP) and choose the shortest available expiration date (e.g. 7 days; granular tokens require an expiration date). (Note: npm will remove the ability to publish new package versions directly with a granular access token in January 2027, so the initial bootstrap must be performed before then.)
   - Store the token as repository secret `NPM_TOKEN` on GitHub (`Settings` -> `Secrets and variables` -> `Actions`).
2. **Run sdk-release.yml manually on main:**
   - `sdk/package.json` is already 1.0.0 on `main`, so no push trigger will fire. Trigger the bootstrap publish manually: go to the **Actions** tab -> **SDK release** -> **Run workflow** on branch `main` with **dry-run** unchecked (`dry-run: false`). The publish job uses `NPM_TOKEN` as `NODE_AUTH_TOKEN` and publishes 1.0.0 to npm with `--provenance` (which succeeds because the job has `id-token: write`), then the release job tags `sdk-v1.0.0` and creates the GitHub release.
3. **Immediately delete the secret and revoke the token:**
   - Immediately after the 1.0.0 publish succeeds, delete the `NPM_TOKEN` secret from GitHub repository settings and revoke the token on npmjs.com.
   - **Why the token must be removed immediately and not kept as a fallback:** npm falls back to the token silently when OIDC fails (`lib/utils/oidc.js` catches token exchange failures, logs them only at `verbose` level with `Failed token exchange request ...`, and returns, allowing `npm publish` to proceed with the token). Because the workflow has `id-token: write`, a publish falling back to `NPM_TOKEN` still receives provenance attestation, so the run appears completely green even though OIDC failed and the trusted publisher configuration remained unvalidated and expired. Keeping the token as a supposed "fallback" conceals OIDC configuration errors instead of testing trusted publishing. Furthermore, a token with "All packages" and 2FA bypass should never sit in repository secrets longer than necessary.
4. **Configure trusted publishing only when the validating publish is ready:**
   - Do **not** add the trusted publisher immediately on bootstrap day, as doing so starts npm's 2-day validation timer before any release is ready.
   - Add the trusted publisher on npmjs.com only when you are ready to validate it within 2 days, using one of two routes:
     - **Option A (Recommended — validate with a throwaway prerelease):** Do not wait for a real production release. Open a PR bumping `sdk/package.json` to a throwaway prerelease version (e.g. `1.0.1-rc.0`) with release notes in `sdk/CHANGELOG.md`. Before merging, navigate on npmjs.com to package `iglo.base` -> **Settings** -> **Trusted Publishers** -> **Add trusted publisher**:
       - **Publisher:** GitHub
       - **Organization/User:** `iglo-tech`
       - **Repository:** `iglo.base`
       - **Workflow filename:** `sdk-release.yml`
       - **Environment:** Leave empty (the workflow does not use a GitHub Environment).
       - **Allowed actions:** Check/enable direct publishing (`npm publish`). By default, npm configurations created after September 3, 2026 only allow `npm stage publish`; direct `npm publish` must be explicitly enabled so automated releases can publish directly without requiring a maintainer to manually promote staged versions.
       Then merge the PR within 2 days. The workflow publishes `1.0.1-rc.0` to npm under the `next` tag (`--tag next`), which leaves the `latest` tag pointing to 1.0.0 and permanently validates the trusted publisher configuration without waiting for real features.
     - **Option B (Validate with the next real release):** Wait until the next version bump PR (e.g. 1.0.1) is reviewed and ready to merge. Add the trusted publisher on npmjs.com as described above on the day of the release, and merge the PR within 2 days.
   - **What happens if the 2-day window passes:** If the configuration is not validated by a successful publish within 2 days, it expires permanently and can no longer be used or edited. Subsequent OIDC publishes fail with authentication errors (`ENEEDAUTH`). To recover: go to package `iglo.base` -> **Settings** -> **Trusted Publishers**, delete the expired configuration, re-create it with the settings above, and run the validating publish within 2 days.
   - Once validated by its first successful publish, the trusted publisher configuration is permanent and exempt from expiry. All future releases use keyless OIDC trusted publishing.
5. **Alternative manual bootstrap:**
   - Alternatively, build the SDK locally from a clean checkout on `main` (`bun run sdk:build`) and publish 1.0.0 once by hand from `sdk/` (`npm publish --access public`) using interactive 2FA login (note: this initial publish will lack GitHub Actions provenance attestation). No `NPM_TOKEN` secret is needed.
   - After manual publishing, run `sdk-release.yml` on `main` with `dry-run: false`. That run detects `npm_exists=true` with the git tag missing, skips `publish`, and runs `release` to create the `sdk-v1.0.0` git tag and GitHub release.
   - Do not add the trusted publisher on bootstrap day. When ready to validate (either via the recommended throwaway prerelease like `1.0.1-rc.0` or when the next real version is ready), configure trusted publishing as described in step 4 and merge within 2 days.

### Concurrency and queue behavior

The concurrency group `sdk-release` specifies `cancel-in-progress: false`. GitHub Actions retains at most one pending run in queue per concurrency group; if multiple releases merge in rapid succession, GitHub may supersede intermediate pending runs with the latest queued run. The latest run publishes its version. A skipped version cannot be published by `workflow_dispatch` on its historical commit because real publishes are only permitted on `refs/heads/main`, which now carries a newer version; to release a superseded version, either bump to a new version on `main` or, if `main` itself is at the unpublished version, trigger `sdk-release.yml` manually via `workflow_dispatch` on `main` with `dry-run: false`. The workflow's check logic ensures that if an older or re-run workflow executes when the version and tag are already present, it exits cleanly without errors or duplicate tags.

## Verifying a download

```sh
sha256sum -c SHA256SUMS      # in the directory with both files
unzip iglo-base_0.1.0_linux_amd64.zip
./iglo-base --version
```

## Switching a deployment

The [operations guide](operations.md) covers installing and running a release. [cutover.md](cutover.md) is the runbook for moving a PocketBase v0.41.0 deployment to a released executable and back.
