# The Linux image wasm/build-in-container.sh runs wasm/build.sh in. The base is
# the official rust:1.100.0-bookworm index (both linux/arm64 and linux/amd64),
# pinned by digest; it has the rustc of rust-toolchain.toml, python3, patch,
# perl's shasum and a C++ compiler for wasm-opt's bundled binaryen.
FROM rust@sha256:ade39a710ef85f3506cffcfec3e8a24ba090badef1dff2fb798f71d878833fea

RUN rustup target add --toolchain 1.100.0 wasm32-unknown-unknown \
 && cargo install --locked wasm-bindgen-cli --version 0.2.118 \
 && cargo install --locked wasm-opt --version 0.116.1 \
 && rm -rf /usr/local/cargo/registry /usr/local/cargo/git
