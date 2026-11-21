# Vectors

Pearl's Go and Rust code generate the vector files below, and the tests compare pearljs against them.
 [Compatibility verification](verification.md) has the overview.

## Generators

`vectors/generate.go` produces expected values through Pearl's Go packages. The TypeScript tests compare pearljs against those outputs instead of relying only on self-round-trips. The generator runs Pearl's script engine over every script-path spend before writing it.

With Go 1.26.10 available as `go`, regenerate the checked-in file using a Pearl source checkout. The XMSS vectors need Pearl's XMSS library and the `xmss` build tag:

```sh
make -C /path/to/pearl/xmss
go -C /path/to/pearl/node run -tags xmss /path/to/pearljs/vectors/generate.go \
  -out /path/to/pearljs/vectors/pearl-go.json
```

Three more generators run pearld's own code:

- `vectors/rpcfixtures_test.go` writes the RPC reply fixtures by running pearld's own handlers and amount encoders. It joins pearld's package through a build overlay, as its header shows.
- `vectors/wsfixtures_test.go` does the same for websocket frames, taking every notification from pearld's notification manager.
- `vectors/difficulty_test.go` writes `vectors/difficulty.json` by running `calcNextRequiredDifficulty` with each network's params over chosen last blocks and times. It joins package blockchain through a build overlay, as its header shows.

`vectors/gcs/generate.go` writes `vectors/gcs.json` with Pearl's gcs and builder packages. It holds filters for the blocks in `pearl-go.json` and for a block of edge-case outputs, the header chain through them, and match results at fixed inputs. Among the matches are a false positive and a match only the 32-bit path finds:

```sh
go -C /path/to/pearl/node run /path/to/pearljs/vectors/gcs/generate.go \
  -blocks /path/to/pearljs/vectors/pearl-go.json -out /path/to/pearljs/vectors/gcs.json
```

## Areas compared

| Area | Compared with Pearl's output |
| --- | --- |
| Keys and addresses | Addresses and derivation |
| Transactions | Transactions, signature hashes and script encodings |
| PSBT | PSBTs, P2MR script paths included |
| Script paths | Script trees, control blocks and script-path spends |
| XMSS | Keys and signatures |
| Blocks | Block headers and full blocks |
| Relay policy | The policy checks |
| Coin selection | Inputs, change, fee and the unsigned transaction from Oyster's `txauthor` |
| Mempool limits | Replacement and package limits, replayed against pearld's own mempool |
| Timelocks and multi_a | CLTV, CSV and multi_a leaves Pearl's script engine spent, and refused before maturity |
| Chain parameters | The parameters, and certificate rules at every fork boundary |
| Emission and difficulty | Subsidy and supply, compact bits, work and difficulty |

Pearl and tiny-secp256k1 use different valid Schnorr nonce derivation, so signature bytes are not expected to match. The tests verify TypeScript signatures against the Go-generated sighash and output key. The P2MR PSBT tests swap each Go signature for the pearljs one, then compare PSBTs and transactions byte for byte.

## Coin selection

The coin selection cases run Oyster's `txauthor.NewUnsignedTransaction` in Go over fixed sets of coins. They are `coinSelection` in `vectors/pearl-go.json`, checked by `test/coinselect.test.ts`. pearljs picks the same inputs, change and fee, and writes the same unsigned transaction byte for byte.

## Recovery

The first receive and change addresses and the account key of every Oyster variant are compared with what Oyster's own loader and address manager hand out for the same input on each network (`recovery` in `vectors/pearl-go.json`). The raw-spacing seeds are compared with go-bip39's, and `pq` addresses with the code Pearl removed, rebuilt from its current packages. The phrase handling is compared with the desktop wallet's `parseSeedInput`, run as it ships in version 3.0.0 (`test/fixtures/desktop-seed-input.json`).

Which payments a restore misses is compared with Oyster's own recovery run over chains of blocks. The blocks pay addresses out of order, in the same block, on both chains, at the window's edges and across its batches of 2000 blocks. The fixture is `test/fixtures/oyster-recovery-walk.json`, written by `vectors/recoverywalk_test.go` inside Oyster's wallet package, as its header shows.

## Messages

The BIP-322 and legacy hashes, transactions and sighashes are compared with what Pearl's Go code computes (`messageFormats` in `vectors/pearl-go.json`). The verdicts on every sighash type are compared with Oyster's verifier and Pearl's script engine (`messageSighashes`). The BIP-322 hashes and P2TR signatures are also checked against the test vectors published with BIP-322.

## Hash timelocks

The leaves, trees and outputs are compared with what Pearl's Go code builds (`htlcs` in `vectors/pearl-go.json`). The cases are P2TR and P2MR trees with CLTV and CSV refunds, and SHA-256 and HASH160 claims.

The script interpreter gives Pearl's engine's verdict and message on each spend. It accepts claims and refunds. It refuses a wrong preimage, a 33-byte preimage, a signature by the other party's key and a refund before its lock.

## Script interpreter

`vectors/interpreter/generate.go` builds 10025 spends and has `txscript.NewEngine(...).Execute()` judge each one:

- valid spends of every kind, each with one thing changed at a time;
- every opcode over boundary operands;
- limits and lock times;
- 3000 random scripts from a seeded grammar.

It writes them to `vectors/interpreter/vectors.json.gz`. `test/interpreter-vectors.test.ts` requires the same verdict, the same error code, the same message and the same stacks after every step.

The checked-in file is a pure function of the seed. To regenerate it, or to run a larger random sweep under a fresh seed:

```sh
make -C /path/to/pearl/xmss
go -C /path/to/pearl run -tags xmss /path/to/pearljs/vectors/interpreter/generate.go \
  -out /path/to/pearljs/vectors/interpreter/vectors.json.gz
vectors/interpreter/sweep.sh /path/to/pearl 50000
```

## FP8

`vectors/pearl-go.json` stays generated from Pearl's master branch. The V4 certificate and the FP8 fork come from Pearl's fp8-scheme branch, and are checked against `vectors/fp8.json`. `vectors/fp8/generate.go` writes that file from the branch at commit 1dd75a52e073b4a67079c7b6758228d71865ccea (pearld 1.6.0-fp8-testnet1), and the file records the commit it came from.

Pearl's Go code does not decode a V4 statement; zk-pow's Rust does. `vectors/fp8/statement/main.rs` runs its decoder, `PublicParams::from_bytes`, at the same commit over Pearl's two mined statements and twenty edits of them. It writes `vectors/fp8-statements.json`, which records the commit (its header gives the build).

The generator runs Pearl's real V4 verifier, so it needs the zk-pow Go bindings built as for the [live tests](verification-live.md#build-and-run):

```sh
make -C /path/to/pearl/xmss
CGO_ENABLED=1 CGO_LDFLAGS_ALLOW='.*zk_pow_ffi.*' go -C /path/to/pearl/node run -tags xmss,zkpow \
  /path/to/pearljs/vectors/fp8/generate.go -commit <sha> -out /path/to/pearljs/vectors/fp8.json
```

### FP8 results

The tests compare pearljs against that branch's own code.

Blocks:

- V4 blocks keyed by the parent and at depths two to four match, with the longest public data and the largest proof.
- V1 to V3 blocks whose proofs pass the old limit match too.
- The fields compared are serialization, hashes, proof commitments, MoE classification, merkle and witness roots, size, stripped size, size without witnesses and vsize.

Certificate binding:

- Pearl's two mined FP8 proof fixtures are accepted by its verifier, and each gets eight edits.
- `checkCertificateBinding` refuses exactly the edits Pearl refuses before the statement and the proof, in the same words.
- Those edits are a missing, altered or extra ancestor header, an altered ancestor in the statement, an altered previous-block hash, and public data one byte short.
- `checkCertificateBinding` passes the edits that only the proof check catches.

Decoding and encoding:

- The decoder refuses an unknown version, V4 public data and proofs past their limits, and four ancestor headers.
- It refuses an ancestor count that is huge, non-canonical, missing or truncated.
- It refuses V2 bodies past the wire limits.
- Its words are Pearl's, word for word, where Pearl names the limit.
- The encoder's refusals are compared as well.

Fork rules and RPC:

- `CheckCertificateRules` and `RequiredCertVersion` agree with pearljs at every fork boundary of every network, V4 included.
- getblocktemplate, getinfo, getnetworkinfo and getmininginfo come from a 1.6 pearld's handlers (`test/fixtures/rpc-responses-fp8.json`, from `vectors/rpcfixtures_test.go` run in that branch).

Testnet2 blocks:

- Three blocks of the public testnet2 chain sit beside the vectors, as its Blockbook served them on 2026-11-19.
- They are the last V3 block at 150282, and V4 blocks at 150283 and 150285. The second V4 block carries two ancestor headers.
- They parse, round-trip, bind and meet the certificate rules.

Statements:

- `certificateStatement` reads every field of an accepted statement as the decoder's debug output shows it, device included.
- It refuses, in the decoder's words, every encoding the decoder refuses for its shape.
- Edits the decoder refuses for bounds or layout, pearljs reads as written. These are k 0, rank 16, tile bases past the matrix, and an MoE index set out of order.

Proofs themselves are judged by `pearljs/verify-proof`, against pearld's verdicts ([Proof verifier](#proof-verifier)).

## Mining

Every hash and bound in `pearljs/mining` is checked against Pearl's own code. `vectors/mining/zkpow/main.rs` runs zk-pow on master (commit 38dd764a) for these:

- job keys, matrix commitments and salted roots;
- the MoE fold, noise seeds and jackpot hashes;
- the public data codec and structure rules;
- targets, and both bounds with the jackpot at, under and over them.

`vectors/mining/fp8/main.rs` does the V4 bound on the fp8-scheme branch (1dd75a52). `vectors/mining/node_test.go` joins pearld's mining package for the coinbase, witness commitment and merkle root it builds at heights and extra nonces that change each push's length, and runs the rank-penalty rule through `zkpow.CheckRankPenalty` and `CheckCertificateRules`. `vectors/mining/gateway_frames.py` captures the lines pearl-gateway's client and server write on both branches. The luck intervals are SciPy's (`vectors/mining/stats.py`).

The live mining and gateway tests are in [Live regtest suite](verification-live.md#mining-and-pearl-gateway).

## Proof verifier

### Certificates

`vectors/mining/proofs/main.go` mines V2, V3, V3 MoE and V4 (H100 and B200) certificates with zk-pow's CPU miners on the fp8-scheme branch (1dd75a52). It has `zkpow.VerifyZKProofFFI` judge each as mined, and after one change at a time:

- a proof byte flipped, or the proof cut short or emptied;
- a public data byte flipped;
- a later timestamp, or harder bits in the header or as a share target;
- another merkle root, or a wrong proof commitment;
- a V2 proof judged as V3 and back, V3 as V4 and V4 as V3;
- a V4 certificate with an ancestor header it does not need.

`test/verify-proof.test.ts` checks that pearljs gives each of the 84 cases pearld's verdict, and its message, cut and prefixed as pearld does. `vectors/mining/proofs/check/main.go` judges the V2 and V3 cases again with master's verifier (38dd764a). All agree, except the two V4 proofs judged as V3, which master refuses as too large because its proof limit is 60000 bytes.

`test/verify-proof-differential.test.ts` checks the verdict and message against `VerifyZKProofFFI` on 2337 certificates with changed public data, the sizes where a 32-bit product wraps among them.

On a regtest pearld, `test/live/verify-proof.test.ts` verifies blocks pearld mined, and refuses them with a flipped proof byte or harder bits.

### Plain proofs

`vectors/mining/plain/mine.rs` mines plain proofs with zk-pow's CPU miners (V2 and V3 dense, V2 MoE, V4 on H100 and B200), and takes zk-pow's two committed plain-proof fixtures. `vectors/mining/plain/main.go` calls `verify_plain_proof_ffi` and `verify_plain_proof_v4_ffi` through cgo on each:

- as mined, at other share bits and on changed headers;
- at every certificate version;
- cut and extended;
- with size fields set past 32 bits, and with MoE dimensions whose products pass 2^32;
- with 1500 random edits.

`test/verify-plain-proof.test.ts` checks pearljs gives all 1964 the FFI's verdict, and its message on all but 234. Of those, 212 have a dimension past its bound and are refused before the module, and in 22 bincode refuses a 64-bit size field on the 32-bit side.

`vectors/mining/plain/large.rs` mines V2, V3 and V4 shares whose matrices pass 2^32 bytes, up to 2^33, with zk-pow's own verifier as the judge. Every row the share does not open holds the same fixed bytes, so the Merkle trees are built chunk by chunk without the matrices in memory.

Two more reach 2^40 bytes for V3, and 2^39 bytes in 128-byte leaves for V4, whose 2^32 leaves pass 32 bits. Hashing those trees is out of reach, so their unopened subtrees carry arbitrary chaining values, which zk-pow accepts as it would a mined tree's.

`main.go` gives the seven the same changes, 1895 cases in all. pearljs gives every one the FFI's verdict, and its message on all but 190: 153 with a dimension past its bound, and 37 that bincode refuses. The memory stays flat over 600 plain proofs, these among them.

### V1 proofs

V1 proofs are judged against mainnet blocks 200, 24000, 71740 and 71934, read from a mainnet pearld's block store. `vectors/mining/proofs/v1/main.go` has `zkpow.VerifyCertificate`, which pearld runs on a block's certificate, judge each as mined and after the same changes. It adds:

- the proof padded past 60000 and 62000 bytes;
- a V1 proof judged as V2 and V3, and the V2 and V3 proofs above judged as V1;
- 1320 changes to the public data, 318 of which reach the proof.

`test/verify-proof-v1.test.ts` checks pearljs gives all 1398 pearld's verdict and message, the 1320 public-data changes checked against `VerifyCertificate` among them. `verifyBlockProof` accepted all 71934 V1 proofs of mainnet, blocks 1 to 71934, read from that store.
