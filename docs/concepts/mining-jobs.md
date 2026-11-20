# Pearl jobs and shares

A Pearl miner works on a job and sends shares to its pool, as a Bitcoin miner does, but the work behind them is different. In Bitcoin a miner changes the nonce in a header and hashes it again until the hash falls below the target. In Pearl the work is matrix multiplication: the miner multiplies two large matrices, hashes a small piece of the result, and wins when that hash falls below a target scaled to the work. The block carries a certificate, a zero-knowledge proof with its public data, which shows that the work was done for this header, so a node can check the work without repeating it.

[Build a block from a template](../guides/mining.md) shows the functions that compute each step described here.

## Bitcoin and Pearl side by side

| | Bitcoin | Pearl |
| --- | --- | --- |
| What the miner varies | the nonce and the coinbase's extranonce | the matrices it multiplies and its mining configuration |
| What is hashed to win | the 80-byte header | one tile of the matrix product (hash_jackpot) |
| Winning condition | header hash at most the target | hash_jackpot at most the target times the tile's work |
| Nonce in the header | 4 bytes | none; the last 32 bytes are a proof commitment |
| What else the block carries | nothing | a certificate: public data and a ZK proof |
| How a share differs from a block | an easier target | an easier target |

A Pearl header has no nonce. Its last 32 bytes are the proof commitment, which binds the header to the certificate, so the header is fixed before the work starts and the certificate is attached after it ends.

## Certificate versions

The certificate's format has changed at forks, and the network's fork heights say which version a block at a given height must carry. V1 is the original format, which mainnet blocks 1 to 71934 carry. V2 and V3 share one design and differ in how the matrix commitments are salted. V4 arrives with the FP8 fork and changes the inside of the work while keeping its shape, so it is easiest to follow once V2 and V3 are clear.

## V2 and V3 jobs

A job is what a miner needs to start working: the first 76 bytes of the header (`incompleteHeader`), which hold the version, the previous block, the merkle root, the time and the bits. The 32-byte proof commitment that completes the header comes later. The miner then goes through these steps:

1. It fixes a mining configuration (`MiningConfiguration`). The configuration sets the common dimension k shared by the two matrices, the noise rank, and which rows of A and columns of B one tile covers.
2. It computes the job key, which is BLAKE3 of the 76 bytes and the 52-byte configuration (`jobKey`). Every hash that follows is keyed by it, so changing a transaction, the time or the configuration changes all of them.
3. It commits to its matrices. Hash A is the BLAKE3 Merkle root of A's int8 bytes, padded to 1024-byte chunks and keyed by the job key, and hash B is the same for B transposed (`matrixCommitment`). Hash A is the value a pool must recompute exactly. V3 then salts each root with the matrix's size (`saltedRootA`, `saltedRootB`), and a mixture-of-experts (MoE) job folds its routing into A's side (`hashActivations`).
4. It derives the noise seeds from those commitments. Seed B is BLAKE3 of the job key and B's root, and seed A is BLAKE3 of seed B and A's root (`noiseSeeds`). The noise the miner adds to A and B comes from these seeds, so the noise is only known once the matrices are fixed, and the miner cannot pick matrices to suit it.
5. It computes the noisy product tile by tile. Each tile folds to sixteen 32-bit words, which are hashed under seed A to give hash_jackpot (`jackpotHash`).
6. It checks each tile against the target. A tile wins when hash_jackpot, read as a little-endian number (`jackpotValue`), is at most the target scaled by the tile's work, which is the target times the tile's entries times the dot product length (`jackpotBound`). From the rank-penalty fork the bound is also divided by rank / 128 (`rankPenalizedBound`, `checkRankPenalty`), so a higher rank buys no easier tiles.

## The certificate

When a tile wins, the miner hands over a plain proof: the winning tile's rows and columns with the Merkle openings that tie them to hash A and hash B. pearl-gateway, the service between pearld and its miners, turns the plain proof into a certificate.

The certificate has two parts. Its public data holds the configuration, hash A, hash B, hash_jackpot, the matrix sizes and the tile's position (`parsePublicData`), and its proof is the ZK proof that hash_jackpot came from that work. The header's proof commitment is double SHA-256 of the certificate's version and public data, and the certificate repeats the block hash, so header and certificate each name the other (`sealBlock`).

## Shares

A share is the same work held to an easier target. Pearl's verifier takes a pool's share bits in place of the header's, so a pool judges a certificate as a share or as a block with one check, and one hash_jackpot can be both a share and a block.

Pearl has no extranonce. The job key already makes each template's work its own, so there is nothing for an extranonce to do, and pearld's coinbase carries an extra nonce of 0.

## V4 jobs

V4, from the FP8 fork, keeps the shape of the work and changes what goes into it: the matrices are FP8, and the proof uses a new proof system.

The public data is a statement (`certificateStatement`) that opens with the full header of one of the block's four most recent ancestors. B is keyed by that ancestor and A by the proposed header, so a miner can prepare B before the next block's transactions are known. The certificate also carries the headers between the block and that ancestor.

A V4 tile wins when hash_jackpot is at most the target times h, w and k (`v4JackpotBound`), and the rank penalty does not apply.

## Checks without the proof

Everything in `pearljs/mining` is hashing and integer arithmetic, which is fast. It can confirm that a certificate's public data meets the target and matches the header ([Mining checks](../reference/mining-checks.md)), but it cannot tell whether hash_jackpot really came from the work. The proof shows that, and `verifyProof(header, certificate, { bits })` from `pearljs/verify-proof` checks it with Pearl's verifier against the share bits a pool passes. [Proof verification](verify-proof-checks.md) describes those checks.
