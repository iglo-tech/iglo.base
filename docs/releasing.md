# Releasing

iglo.base ships one artifact, the compiled linux-x64 executable (D24, D3).
`.github/workflows/release.yml` builds it.

## How to release

1. Run `bun run check` and `bun run test:reference` on the host (D25) from the commit to release.
2. Tag that commit and push the tag: `git tag v0.1.0 && git push origin v0.1.0`. The tag must be `vMAJOR.MINOR.PATCH` with an optional `-prerelease` suffix; the workflow fails on anything else.
3. The workflow runs `bun run check`, builds with the version from the tag, smoke-tests the executable (`--version` prints the tag's version, `serve` on a temporary directory answers `/api/health` with 200), archives it and creates a **draft** GitHub release. Tags with a `-` suffix are marked as pre-releases. `test:reference` is not part of the workflow (it takes over 10 minutes); it is the manual step 1.
4. Review the draft and publish it by hand. Nothing is public until then.

`workflow_dispatch` is a dry run, also when it is started on a tag: it builds and uploads the archive as a workflow artifact (version `0.0.0-dryrun.<run number>`) and creates no release.

## What it produces

- `iglo-base_<version>_linux_amd64.zip`, containing `iglo-base` (the executable), `LICENSE` and `README.txt` (a pointer to the repository). `<version>` is the tag without the leading `v`.
- `SHA256SUMS`, with the archive's SHA-256 checksum.

`iglo-base --version` prints `iglo-base version <version>`; a build outside the release (plain `bun run build`) prints `iglo-base version (untracked)`. The version is set at build time: `IGLO_VERSION=0.1.0 bun run build` (`scripts/build.ts` passes it to `bun build --define` and to the dashboard footer).

## Image

`.github/workflows/docker.yml` wraps a published release in a linux/amd64 image (D33). It runs when a release is published, and by hand with `workflow_dispatch` and a `tag` input (for example `v1.0.0`) for a release that already exists. It does not build iglo.base: it downloads `iglo-base_<version>_linux_amd64.zip` and `SHA256SUMS` with `gh release download`, checks the checksum, and the `Dockerfile` copies the executable into `gcr.io/distroless/base-debian13:nonroot` (pinned by digest). Before pushing it smoke-tests the image: `--version` prints the version, `serve` answers `/api/health` with 200 and `docker stop` exits 0.

It pushes `ghcr.io/iglo-tech/iglo.base:<version>` and, for a release that is not a pre-release, `:latest`. Only this job has `packages: write`; there are no other secrets. A draft release is refused.

```sh
docker run -d --name iglo -p 8090:8090 -v iglo-data:/pb_data ghcr.io/iglo-tech/iglo.base:1.0.0
```

- `/pb_data` is the data volume (`--dir /pb_data`); `/pb_migrations` holds the auto-generated migration files that dashboard changes write (`--migrationsDir` defaults to `<dir>/../pb_migrations`). Mount both to keep them.
- The process runs as uid/gid 65532 and is PID 1. A new named volume takes that ownership from the image. A directory taken over from PocketBase (usually root-owned) must be handed over first: `chown -R 65532:65532 <dir>`.
- The default command is `serve --http 0.0.0.0:8090 --dir /pb_data`; arguments after the image name replace it, so repeat `serve` and the flags you need.
- The image is not an official PocketBase image. Update the digest in the `Dockerfile` by hand when the base needs a refresh.

## Verifying a download

```sh
sha256sum -c SHA256SUMS      # in the directory with both files
unzip iglo-base_0.1.0_linux_amd64.zip
./iglo-base --version
```

## Switching a deployment

[cutover.md](cutover.md) is the runbook for moving a PocketBase v0.41.0 deployment to a released executable and back.
