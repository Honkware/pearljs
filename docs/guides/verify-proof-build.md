# Reproduce the verifier build

The WebAssembly module and the circuit caches behind the [proof verifier](verify-proof.md) are committed to the repository as built files. Anyone who wants to confirm they come from Pearl's source can build them again in the pinned container and compare the digests. A build matches only on one platform, and the Pearl source that the build copies can be checked too.

## Prerequisites

- Docker.
- A checkout of Pearl's fp8-scheme branch at commit 1dd75a52e073b4a67079c7b6758228d71865ccea.

## Build in the container

Point `PEARL_FP8` at the Pearl checkout and give the script a directory to write to:

```sh
PEARL_FP8=/path/to/pearl wasm/build-in-container.sh /tmp/verifier-out
shasum -a 256 /tmp/verifier-out/verifier.wasm /tmp/verifier-out/*.bin
```

`wasm/build-in-container.sh` runs `wasm/build.sh` unchanged inside the container defined by `wasm/Dockerfile`, as linux/amd64. On a host of another architecture Docker emulates it, which takes about 12 minutes on an arm64 Mac with `--no-caches`. The Dockerfile pins its base image by digest and installs wasm-bindgen-cli 0.2.118 and wasm-opt 0.116.1 with `--locked`. The output goes to the directory given and never over `src/`.

## Compare the digests

The digests the build prints should be the ones in `src/internal/verify-proof-digests.ts`, which are the digests pearljs pins and checks before it uses a file. Two builds in that container gave the same `verifier.wasm`, and all three caches came out byte for byte as committed. The V1 cache is also byte for byte the `v1_cache.bin` that zk-pow embeds.

To build without the container, or to check only the Pearl source the build copies, see [Building the verifier](../reference/verify-proof-limits.md#building-the-verifier).
