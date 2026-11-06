#!/bin/sh
# Prepares the Docker build context `ctx` for .github/workflows/docker.yml:
# downloads the release archives of the architectures in $ARCHES ("amd64",
# "arm64") with their SHA256SUMS, verifies the checksums and unpacks each
# executable to ctx/<arch>/iglo-base, which the Dockerfile copies by
# $TARGETARCH. Needs TAG, VERSION and ARCHES; gh reads GH_TOKEN and GH_REPO.
set -eu
mkdir -p ctx/dl ctx/pb_data ctx/pb_migrations
set --
for arch in $ARCHES; do
  set -- "$@" --pattern "iglo-base_${VERSION}_linux_${arch}.zip"
done
gh release download "$TAG" --dir ctx/dl --pattern SHA256SUMS "$@"
for arch in $ARCHES; do
  name="iglo-base_${VERSION}_linux_${arch}.zip"
  # check only the archives that were downloaded
  (cd ctx/dl && grep -F " $name" SHA256SUMS | sha256sum -c -)
  mkdir -p "ctx/$arch"
  unzip -q -j "ctx/dl/$name" iglo-base -d "ctx/$arch"
  chmod 0755 "ctx/$arch/iglo-base"
done
rm -r ctx/dl
cp .dockerignore ctx/.dockerignore
