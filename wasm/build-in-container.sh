#!/bin/sh
# Runs wasm/build.sh, unchanged, in the Linux image of wasm/Dockerfile and writes
# what it builds to a directory of your choice, not over src/:
#
#   PEARL_FP8=/path/to/pearl wasm/build-in-container.sh OUT [--no-caches]
#
# OUT gets verifier.wasm, v1-cache.bin, v2-cache.bin, v4-cache.bin, LICENSES.txt and
# verify-proof-digests.ts. The build runs as linux/amd64, emulated on an arm64
# host (about 12 minutes there without the caches): the files pearljs ships are
# that platform's, because the host triple enters cargo's crate hashes and
# another platform gives a different, equivalent module. PLATFORM overrides it
# for comparison. The repository and the Pearl checkout are mounted read-only. With --no-caches the caches are the
# ones in src/verify-proof.
set -eu
here=$(cd "$(dirname "$0")" && pwd -P)
repo=$(dirname "$here")
pearl=$(cd "${PEARL_FP8:?set PEARL_FP8 to a Pearl fp8-scheme checkout}" && pwd -P)
mkdir -p "${1:?give an output directory}"
out=$(cd "$1" && pwd -P)
shift
platform=${PLATFORM:-linux/amd64}
[ "$platform" = linux/amd64 ] || echo "building for $platform: not the platform of the shipped files" >&2
tag=pearljs-wasm-build:$(echo "$platform" | tr / -)

docker build --platform "$platform" -t "$tag" - <"$here/Dockerfile"
docker run --rm --platform "$platform" \
  -v "$repo/wasm:/repo/wasm:ro" -v "$repo/src/verify-proof:/repo/verify-proof:ro" \
  -v "$pearl:/pearl:ro" -v "$out:/out" -e PEARL_FP8=/pearl "$tag" sh -euc '
    mkdir -p /work/wasm /work/src/verify-proof /work/src/internal
    (cd /repo/wasm && tar cf - --exclude ./target .) | (cd /work/wasm && tar xf -)
    cp /repo/verify-proof/v1-cache.bin /repo/verify-proof/v2-cache.bin /repo/verify-proof/v4-cache.bin /work/src/verify-proof/
    /work/wasm/build.sh "$@"
    cp /work/src/verify-proof/* /work/src/internal/verify-proof-digests.ts /out/
  ' build "$@"
