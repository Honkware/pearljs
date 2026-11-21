# Proof verification

Every Pearl block carries a certificate whose zero-knowledge proof shows that the miner's matrix work was really done for that header ([Pearl jobs and shares](mining-jobs.md)). `pearljs/verify-proof` checks that proof, and a miner's plain proof, outside pearld. It is zk-pow, Pearl's verifier, compiled to WebAssembly and patched only where WebAssembly's 32-bit sizes would change the answer. It runs the same checks as pearld in the same order, so a certificate or a share gets the verdict and message pearld would give it.

[Verify a block's proof](../guides/verify-proof.md) shows how to call it.

## Certificate checks

`verifyProof(header, certificate, { bits })` runs what pearld's `VerifyZKProofFFI` runs for a V2, V3 or V4 certificate, in the same order:

1. It checks that the certificate names the header's hash and that the header's proof commitment is the certificate's. A mismatch is refused with `block hash mismatch: ...` or `proof commitment mismatch: ...`.
2. It checks sizes. Neither the public data nor the proof may be empty, and V4 public data must fit in 4807 bytes. A proof over 62000 bytes, public data of a length no certificate of its version can have, and more than three V4 ancestor headers are refused with the verifier's own messages before anything is copied into the module.
3. It hands the proof to zk-pow's verifier. For V2 and V3 the proof is checked against the 76-byte incomplete header with V2's or V3's noise seeds, and for V4 against the full header followed by the certificate's ancestor headers. Before the verifier looks at the proof, it checks the structure of the public data and compares hash_jackpot with `bits`.

## V1 certificates

V1 is the original certificate format, which mainnet blocks 1 to 71934 carry. A V1 certificate is judged the way pearld judges a block's:

1. `verifyCertificate` refuses a proof over 60000 bytes (`v1 proof rejected: legacy proof data too large: ...`).
2. `verifyCertificateV1` checks the hash and the proof commitment, and refuses an empty proof.
3. zk-pow's V1 verifier, `verify_zk_proof_v1`, takes 164 bytes of public data (`v1 proof requires 164 byte public_data, got ...`) and judges the proof against the header's own bits.

Shares are judged through `VerifyZKProofFFI`, which has no V1 path, so with `bits` given a V1 certificate gets that function's answer ([Verdicts](../reference/verify-proof-limits.md#verdicts)).

## Scope of the proof

The proof says that the work behind hash_jackpot was done for this header. The consensus rules around the work are a separate matter, so for a block also run `checkCertificateBinding`, `checkCertificateRules` and `checkBlockWork` (rank penalty included) from `pearljs/mining`, as pearld does.

## Plain proof checks

A plain proof is what a miner sends to pearl-gateway before any certificate exists. `verifyPlainProof` checks it with zk-pow's `verify_plain_proof_ffi` for certificate versions 1 to 3 and `verify_plain_proof_v4_ffi` for version 4. Each decodes the proof, checks its openings against the roots they commit to, recomputes the jackpot and holds it to `bits`.

Pearl's FFI bounds neither the size of a plain proof nor the work it causes, and it copies the bytes into the verifier's memory. pearljs therefore refuses an oversized proof, and one whose declared dimensions would make zk-pow allocate far more than any real proof needs, before the module sees it ([Size limits](../reference/verify-proof-limits.md#size-limits)). The two families differ in when the dimensions are bounded: zk-pow builds a V1 to V3 proof's statement, and allocates by its `k`, before its sanity check bounds the dimensions, while a V4 proof's statement is bounded before any opening is read.

## 64-bit arithmetic

WebAssembly's `usize` is 32 bits, and pearld's is 64. That matters because a statement's matrices can reach 2^40 bytes (2^24 rows of up to 65536 bytes). Mainnet block 71740's V1 proof, for example, commits a B matrix of 2^34 bytes.

The build patches zk-pow to compute these values in 64 bits: every byte position in the committed matrices, the tile shape and, for V1, the difficulty factor h·w·k. Each statement is then judged as the 64-bit verifier judges it. Verification memory does not grow with the matrices, so the verifier imposes no size limit of its own below Pearl's bounds.

Any other arithmetic in zk-pow that would overflow 32 bits panics instead of wrapping. The result is the `error` outcome rather than a verdict on a statement other than the one given.

## Large matrices in shares

Plain proofs raise the same problem. Five of the six V2 and V3 mainnet blocks in `test/mainnet-blocks/fixtures` commit a matrix of 4 GiB or more, and block 98976's A is 512 GiB. Pearl's bounds allow 2^40 bytes (2^24 rows of 2^16 bytes), so the byte positions in a share go past WebAssembly's 32-bit `usize`.

The build patches zk-pow and its Merkle library to carry every position, tree size and leaf index of a plain proof's openings in 64 bits. A share of any size within Pearl's bounds then gets the verdict pearld gives it. Verification memory follows the opened rows rather than the matrices, so a V4 share of 2^39-byte matrices takes 29 MiB.

On the 32-bit side, bincode refuses a dimension, row index or length of 2^32 or more. No valid proof has one, and the verdict in that case is pearld's rejection.

## Circuit caches

A circuit cache holds the setup the verifier needs for one family of certificates, and the caches are the same setups pearld embeds. The V1 and V2 caches are byte for byte the `v1_cache.bin` and `v2_cache.bin` that zk-pow's `build_cache` writes, and the V4 cache is checked against the BLAKE3 digest zk-pow pins before it is used. Like pearld, the verifier accepts only proofs whose circuits are in its cache.

The caches are shipped because building the setups in place is not practical. The V2 and V3 circuits took 179 seconds in Chrome and 449 in Node, with 3.3 GB of memory, and the V4 setups ran out of WebAssembly's 4 GB in both. Loading a cache takes under 0.1 seconds.

## Trusted files

The pearljs package is what the verifier trusts. The package pins the SHA-256 digest of each of its four files, and every file is hashed after it is read. A file whose digest is not the pinned one is refused with `PROOF_VERIFIER_UNAVAILABLE`, whatever `locate` returned.

The host that serves the files needs no trust. A CDN or another origin can serve them, and a changed or replaced file is refused rather than used.

## Instances

One instance of the module serves every verification. Its memory grows to what the largest proof so far needed, however many proofs it judges, and WebAssembly memory never shrinks. An instance left above 256 MiB after a call is let go once the calls already holding it finish, and the next verification loads a fresh one.

When the module traps, or the engine stops it because of a stack overflow or running out of memory, the verdict is `error` with the reason as its message. That instance is dropped, and the next verification, and any already waiting for it, load a fresh one.
