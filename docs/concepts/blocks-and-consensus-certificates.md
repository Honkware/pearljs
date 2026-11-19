# Certificates and block checks

A Pearl block's certificate is its proof of work. It holds a zero-knowledge proof together with the public data the proof is about, and a V4 certificate also carries the headers that link the block to the ancestor its proof was keyed by. pearljs checks that a certificate belongs to its block, and leaves the question of whether the proof itself holds to the proof verifier or a node.

## Scope of the block checks

`parseBlock` ([Parse and check a block](../guides/blocks-and-consensus.md)) and the check functions in [Block checks](../reference/blocks-and-consensus-limits.md#block-checks) establish that a block is well formed and holds together: its certificate belongs to its header, and its transactions belong to its roots.

`checkCertificateBinding` checks what Pearl checks before it verifies a proof, and stops there. A block that passes it may therefore still be invalid, and `verifyBlockProof` is the function that checks the proof ([Proof verification](verify-proof-checks.md)). Run it alongside these checks, or use the checks on blocks a pearld has already accepted, or to prepare a block for a pearld. The five genesis blocks are hardcoded in Pearl and don't pass `checkCertificateBinding`.

## V4 certificates

The FP8 fork replaces the proof system, and the certificate with it. A V4 certificate holds:

- the block hash;
- up to 832 bytes of public data;
- a proof of up to 62000 bytes;
- up to three full block headers, parent first.

The proof is keyed by one of the block's four most recent ancestors, and that ancestor's complete header opens the public data. The headers between the block and that ancestor are carried in `certificate.ancestorHeaders`.

The proof commitment in the header covers only the certificate's version and public data, so the ancestor headers are held in place by the chain itself: each must be the parent of the one before it. `checkCertificateBinding` checks this link by link, and rejects a break with the depth that Pearl's verifier names (`v4 ancestor header at depth 2 does not connect`).

Pearl counts no V4 certificate as MoE, whatever its length, so `isMoECertificate` is false for one and the dense-only rule doesn't apply to it. The rank-penalty rule doesn't apply to V4 either. `blockVsize` leaves the certificate out, ancestor headers included, while `blockSize` counts the certificate and its ancestor headers.

## V4 statements

Apart from the ancestor header, V4 public data is the proof's statement: the matrix shapes, the commitments and the jackpot claim. `checkCertificateBinding` reads only the ancestor header out of it, and checks that its length is one a statement can have (240 to 832 bytes, from `PUBLIC_DATA_MIN_SIZE_V4`).

`certificateStatement(certificate)` reads all of it, with the names that zk-pow's decoder uses:

- the ancestor header;
- `k`, `r`, `quant` and `device`;
- the A and B operands;
- `experts`, and the MoE part when there is one;
- the commitment digests, the tile bases and the jackpot claim.

It rejects the encodings that zk-pow's decoder rejects for their shape, with that decoder's wording, and keeps as written any values the decoder would reject for their bounds or layout. Whether the statement holds is for the node to judge, together with the proof.

`device` is the number Pearl's code commits, 0 or 1, and identifies the GPU whose matmul datapath the proof reproduces. zk-pow names them `H100` and `B200`, which `V4_DEVICE_NAMES[device]` returns, and testnet2 carries blocks from both.

## Nodes with and without the FP8 code

A pearld with the FP8 code allows proofs of up to 62000 bytes on the wire, where a pearld without it allows 60000, and the two word their limit errors differently. V1 to V3 proofs must still fit in 60000 bytes, which Pearl checks before it verifies one, and `checkCertificateBinding` checks the same.

`parseBlock`, `serializeBlock` and `serializeCertificate` follow the FP8 code by default. Pass `{ fp8: false }` to read and write exactly as a pearld without it does, with version 4 unsupported, 60000-byte proofs and its wording. Every block such a pearld accepts parses the same either way.
