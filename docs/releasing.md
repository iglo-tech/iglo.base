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

## Verifying a download

```sh
sha256sum -c SHA256SUMS      # in the directory with both files
unzip iglo-base_0.1.0_linux_amd64.zip
./iglo-base --version
```

## Switching a deployment

The [operations guide](operations.md) covers installing and running a release. [cutover.md](cutover.md) is the runbook for moving a PocketBase v0.41.0 deployment to a released executable and back.
