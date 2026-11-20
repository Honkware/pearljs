#!/bin/sh
# Builds the files pearljs/verify-proof loads, into src/verify-proof/:
#
#   verifier.wasm  zk-pow's V1 to V4 verifiers (src/lib.rs here), compiled
#                  for wasm32-unknown-unknown and optimized with wasm-opt
#   v1-cache.bin   the V1 circuit cache, from zk-pow's build_cache
#   v2-cache.bin   the V2 and V3 circuit cache, from zk-pow's build_cache
#   v4-cache.bin   the V4 verifier setups, from zk-pow's build_cache
#   LICENSES.txt   the licences of the crates compiled into verifier.wasm
#
# and src/internal/verify-proof-digests.ts, the SHA-256 digests of the first four.
#
# from a checkout of Pearl's fp8-scheme branch:
#
#   PEARL_FP8=/path/to/pearl wasm/build.sh
#
# Everything is copied to /tmp/pearljs-verify-proof first and built there:
# cargo derives symbol hashes from where a path dependency lives, so a fixed place
# gives the same binary on the same host platform. The host triple and the stage's
# real path (/private/tmp on macOS) still enter those hashes, so other hosts give
# a different, equivalent module; wasm/build-in-container.sh makes the canonical one. zk-pow is patched in that copy
# (patches/: the chunk counter shift, the cache key size, the byte positions
# of the committed matrices and the tile products computed in u64, which reach
# 2^40, and the circuit layout dropped in place where rayon would drop it on a
# pool thread wasm32 never runs, in V1 and V2; none changes anything on 64-bit); the checkout is not touched. Needs rustup's wasm32-unknown-unknown target,
# wasm-bindgen-cli 0.2.118 (the version Cargo.lock pins) and wasm-opt 116
# (cargo install wasm-opt --version 0.116.1). Building the caches takes a few
# minutes; pass --no-caches to keep the ones in src/verify-proof.
set -eu
here=$(cd "$(dirname "$0")" && pwd -P)
out="$here/../src/verify-proof"
pearl=$(cd "${PEARL_FP8:?set PEARL_FP8 to a Pearl fp8-scheme checkout}" && pwd -P)
stage=/tmp/pearljs-verify-proof
# rust-toolchain.toml names the compiler; rustup installs it on first use.
RUSTUP_TOOLCHAIN=$(sed -n 's/^channel = "\(.*\)"$/\1/p' "$here/rust-toolchain.toml")
export RUSTUP_TOOLCHAIN

copy() { (cd "$1" && tar cf - --exclude ./target --exclude ./bindings --exclude '*.bin' .) | (mkdir -p "$2" && cd "$2" && tar xf -); }
# The stage's target directory is kept between runs; only the sources are replaced.
mkdir -p "$stage/wasm/target" "$out"
rm -rf "$stage/zk-pow" "$stage/plonky2" "$stage/pearl-blake3" "$stage/wasm/src" "$stage/wasm/.cargo"
copy "$pearl/zk-pow" "$stage/zk-pow"
copy "$pearl/plonky2" "$stage/plonky2"
copy "$pearl/pearl-blake3" "$stage/pearl-blake3"
cp "$pearl/LICENSE" "$stage/LICENSE"
patch -s -d "$stage/zk-pow" -p0 <"$here/patches/zk-pow-wasm32.patch"
cp -R "$here/src" "$here/.cargo" "$here/Cargo.toml" "$here/Cargo.lock" "$here/rust-toolchain.toml" "$here/licenses.py" "$stage/wasm/"

cd "$stage/wasm"
# Panic messages carry source paths; these are remapped so they name neither the home
# directory nor the stage, which macOS reaches as /private/tmp. CARGO_ENCODED_RUSTFLAGS
# takes flags separated by 0x1f and replaces .cargo/config.toml's, so the getrandom
# backend is repeated here.
sysroot=$(rustc --print sysroot)
cargo_home=$(cd "${CARGO_HOME:-$HOME/.cargo}" && pwd -P)
stage_real=$(cd "$stage" && pwd -P)
sep=$(printf '\037')
# ahash takes compile-time random keys from const-random unless this seeds them.
export CONST_RANDOM_SEED=pearljs-verify-proof
CARGO_ENCODED_RUSTFLAGS="--cfg${sep}getrandom_backend=\"wasm_js\"${sep}--remap-path-prefix=$cargo_home=/cargo${sep}--remap-path-prefix=$sysroot=/rustc${sep}--remap-path-prefix=$stage=/build${sep}--remap-path-prefix=$stage_real=/build" \
  cargo build --locked --release --target wasm32-unknown-unknown
rm -rf target/bindgen
wasm-bindgen --target web --no-typescript --out-dir target/bindgen target/wasm32-unknown-unknown/release/pearljs_verify_proof.wasm
wasm-opt -O3 --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext --enable-mutable-globals \
  --enable-reference-types --enable-multivalue target/bindgen/pearljs_verify_proof_bg.wasm -o "$out/verifier.wasm"

python3 licenses.py "$out/LICENSES.txt"

if [ "${1:-}" != "--no-caches" ]; then
  cd "$stage/zk-pow"
  CARGO_TARGET_DIR="$stage/wasm/target/native" cargo build --locked --release --no-default-features --bin build_cache
  "$stage/wasm/target/native/release/build_cache" "$out/v4-cache.bin" "$out/v2-cache.bin" "$out/v1-cache.bin"
fi
shasum -a 256 "$out/verifier.wasm" "$out/v1-cache.bin" "$out/v2-cache.bin" "$out/v4-cache.bin"

# The loader refuses any file whose digest is not the one written here.
digest() { shasum -a 256 "$out/$1" | cut -d' ' -f1; }
cat >"$here/../src/internal/verify-proof-digests.ts" <<EOF
// Written by wasm/build.sh: the SHA-256 digests of the files pearljs/verify-proof loads.

export const VERIFIER_FILE_DIGESTS = {
  'verifier.wasm': '$(digest verifier.wasm)',
  'v1-cache.bin': '$(digest v1-cache.bin)',
  'v2-cache.bin': '$(digest v2-cache.bin)',
  'v4-cache.bin': '$(digest v4-cache.bin)',
} as const;
EOF
