# Official iglo.base image (D33). It does not build iglo.base: it wraps the
# release executable. The build context holds the unpacked, checksum-verified
# release (`iglo-base`) and the empty directories `pb_data` and `pb_migrations`; the Docker workflow
# (.github/workflows/docker.yml) prepares both. See docs/releasing.md#image.
#
# gcr.io/distroless/base-debian13:nonroot: glibc, CA certificates and tzdata,
# no shell; the executable links only libc, libm, libdl and libpthread.
# Runs as uid/gid 65532 (nonroot).
FROM gcr.io/distroless/base-debian13:nonroot@sha256:9039a88709bcc2bacf5a2faac331d65dd6840f763f225ad9594cc0c67bcd0fba

ARG VERSION=unknown
LABEL org.opencontainers.image.title="iglo.base" \
      org.opencontainers.image.description="iglo.base: a Bun and TypeScript port of PocketBase v0.41.0. Not an official PocketBase image." \
      org.opencontainers.image.source="https://github.com/iglo-tech/iglo.base" \
      org.opencontainers.image.url="https://github.com/iglo-tech/iglo.base" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}"

COPY --chown=65532:65532 pb_data /pb_data
# --migrationsDir defaults to <dir>/../pb_migrations: collection changes made in
# the dashboard write auto-generated migration files there.
COPY --chown=65532:65532 pb_migrations /pb_migrations
COPY --chmod=0755 iglo-base /usr/local/bin/iglo-base

VOLUME /pb_data
VOLUME /pb_migrations
EXPOSE 8090
# PID 1 is the executable, so SIGTERM from `docker stop` reaches it.
ENTRYPOINT ["/usr/local/bin/iglo-base"]
CMD ["serve", "--http", "0.0.0.0:8090", "--dir", "/pb_data"]
