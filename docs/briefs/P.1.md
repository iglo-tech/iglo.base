# Brief P.1

Written by the chief of staff on 2026-11-05. The official Docker image (D3), after v1.0.0 shipped.

```text
Task P.1: Official Docker image that wraps the release executable
Goal: every published GitHub release gets a linux/amd64 image on GitHub Container Registry (ghcr.io/iglo-tech/iglo.base) that contains exactly that release's executable, checked against its SHA256SUMS; the image runs iglo.base on a volume that can hold an existing PocketBase pb_data.
Read first: AGENTS.md (Stack: the executable is the artifact, D3; remove the "until 1.0 ... Do not add Docker" rule's now-obsolete part in the same change), docs/design/10-decisions.md (D3, D24, D25, D30), docs/releasing.md, docs/cutover.md, .github/workflows/release.yml (how versions and assets are named; pin actions by commit SHA the same way), src/cli/ (serve flags, --dir default, the pb_hooks warning, --hooksDir refusal), /home/t3-code/AGENTS.md (host rules for Docker: never `docker system df`, no nonzero `--keep-storage`, do not prune by hand beyond your own images).
Owns: Dockerfile (new, repository root, or docker/Dockerfile), .dockerignore, .github/workflows/docker.yml (new), docs/releasing.md (an "Image" section), docs/cutover.md (a short "From the PocketBase Docker image" note: the volume path and the flags that do not carry over, e.g. --hooksDir), AGENTS.md (the Stack rule about Docker), docs/design/02-architecture.md (release artifacts), a decision record D33 in docs/design/10-decisions.md for the base image and registry.
Depends on: M7.3 (merged), v1.0.0 released.
Acceptance:
  - The image does not build iglo.base from source: the workflow downloads the release's `iglo-base_<version>_linux_amd64.zip` and `SHA256SUMS` from the GitHub release (gh release download), verifies the checksum, and the Dockerfile copies the unpacked executable in. Base: the smallest image that runs Bun's compiled linux-x64 executable (glibc; check what it actually links, e.g. a distroless cc or debian slim image, pinned by digest); include CA certificates (SMTP/S3/OAuth2 over TLS) and tzdata only if needed. Runs as a non-root user; `pb_data` is a volume at a documented path (`/pb_data`, with `--dir /pb_data`); `EXPOSE 8090`; the default command is `serve --http 0.0.0.0:8090 --dir /pb_data`; SIGTERM reaches the process (it is PID 1 or under a tiny init) so a `docker stop` exits cleanly within the default 10 s. OCI labels: source, version, licenses MIT, description saying it is not an official PocketBase image.
  - .github/workflows/docker.yml: on `release: published`, plus `workflow_dispatch` with a `tag` input to build an existing release (that is how v1.0.0 gets its image). Pushes `ghcr.io/iglo-tech/iglo.base:<version>` and `:latest` (only for a non-prerelease); `packages: write` for that job only; uses GITHUB_TOKEN, no other secrets. A smoke test in the workflow before push: the image's `--version` prints the version; `serve` answers `/api/health` 200; `docker stop` exits 0.
  - Local proof on this host: build the image from the v1.0.0 release assets with the same Dockerfile (rootless docker is available), run it on a `mktemp -d` volume with synthetic data created by PocketBase v0.41.0 (.upstream binary) to show an existing pb_data opens and the file permissions work for the non-root user (document the uid and the `chown` a PocketBase volume needs, if any), `docker stop` timing, image size. Remove your local images and containers afterwards (by name; no global prune).
  - End-to-end on GitHub after the PR is ready: do not push tags or publish releases. The lead runs the workflow for v1.0.0 after merge; say in the PR body what to check.
  - Docs as listed in Owns; `bun run check` passes locally (test:reference not needed unless src/ changes).
Out of scope: arm64 or macOS images (P.2), compose files, Helm charts, building from source in Docker, Docker Hub.
Notes from the lead:
  - The host is small and once ran out of memory around Docker disk accounting: follow /home/t3-code/AGENTS.md exactly. No `docker system df`, no `docker system prune`, no buildx `--keep-storage`.
  - Branch: task/P.1-docker. PR title: "P.1: Docker image for releases".
  - There is no time limit; finish the task. Stop early only for a real blocker, and describe it in the PR and your reply.
```

The worker instructions from `docs/chief-of-staff.md` follow this brief.
