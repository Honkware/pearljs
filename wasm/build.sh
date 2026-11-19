#!/bin/sh
# Builds the files pearljs/verify-proof loads, into src/verify-proof/:
#
#   verifier.wasm  zk-pow's V2, V3 and V4 verifiers (src/lib.rs here), compiled
#                  for wasm32-unknown-unknown and optimized with wasm-opt
#   v2-cache.bin   the V2 and V3 circuit cache, from zk-pow's build_cache
#   v4-cache.bin   the V4 verifier setups, from zk-pow's build_cache
#   LICENSES.txt   the licences of the crates compiled into verifier.wasm
#
# from a checkout of Pearl's fp8-scheme branch:
#
#   PEARL_FP8=/path/to/pearl wasm/build.sh
#
# zk-pow is copied into wasm/vendor and patched there (patches/, two fixes for
# a 32-bit usize that change nothing on 64-bit); the checkout is not touched.
# Needs rustup's wasm32-unknown-unknown target, wasm-bindgen-cli 0.2.118
# (the version Cargo.lock pins) and wasm-opt 116 (cargo install wasm-opt
# --version 0.116.1). Building the caches takes a few minutes; pass
# --no-caches to keep the ones in src/verify-proof.
set -eu
here=$(cd "$(dirname "$0")" && pwd -P)
out="$here/../src/verify-proof"
pearl=$(cd "${PEARL_FP8:?set PEARL_FP8 to a Pearl fp8-scheme checkout}" && pwd -P)

rm -rf "$here/vendor"
mkdir -p "$here/vendor/zk-pow" "$out"
(cd "$pearl/zk-pow" && tar cf - --exclude ./target --exclude ./bindings --exclude '*.bin' .) | (cd "$here/vendor/zk-pow" && tar xf -)
patch -s -d "$here/vendor/zk-pow" -p0 <"$here/patches/zk-pow-wasm32.patch"
# zk-pow names plonky2 and pearl-blake3 by relative path; point them back at the checkout.
sed -i.orig -e "s#path = \"\.\./plonky2/#path = \"$pearl/plonky2/#" -e "s#path = \"\.\./pearl-blake3\"#path = \"$pearl/pearl-blake3\"#" "$here/vendor/zk-pow/Cargo.toml"
rm "$here/vendor/zk-pow/Cargo.toml.orig"

cd "$here"
# Panic messages carry source paths; map them to fixed names so the binary is the
# same on every machine and names no home directory. CARGO_ENCODED_RUSTFLAGS takes
# flags separated by 0x1f, since the paths may hold spaces, and replaces
# .cargo/config.toml's flags, so the getrandom backend is repeated here.
sysroot=$(rustc --print sysroot)
cargo_home=$(cd "${CARGO_HOME:-$HOME/.cargo}" && pwd -P)
sep=$(printf '\037')
CARGO_ENCODED_RUSTFLAGS="--cfg${sep}getrandom_backend=\"wasm_js\"${sep}--remap-path-prefix=$here=/pearljs/wasm${sep}--remap-path-prefix=$pearl=/pearl${sep}--remap-path-prefix=$cargo_home=/cargo${sep}--remap-path-prefix=$sysroot=/rustc" \
  cargo build --locked --release --target wasm32-unknown-unknown -p pearljs-verify-proof
rm -rf "$here/target/bindgen"
wasm-bindgen --target web --no-typescript --out-dir "$here/target/bindgen" target/wasm32-unknown-unknown/release/pearljs_verify_proof.wasm
wasm-opt -O3 --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext --enable-mutable-globals \
  --enable-reference-types --enable-multivalue "$here/target/bindgen/pearljs_verify_proof_bg.wasm" -o "$out/verifier.wasm"

python3 "$here/licenses.py" "$pearl" "$out/LICENSES.txt"

if [ "${1:-}" != "--no-caches" ]; then
  cargo build --locked --release -p zk-pow --no-default-features --bin build_cache
  "$here/target/release/build_cache" "$out/v4-cache.bin" "$out/v2-cache.bin" -
fi
shasum -a 256 "$out/verifier.wasm" "$out/v2-cache.bin" "$out/v4-cache.bin"
