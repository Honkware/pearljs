# Block limits and checks

## Certificate limits

`parseBlock` applies these with the words Pearl's decoder uses:

| Limit | Value | Constant |
| --- | --- | --- |
| V1 public data | 164 bytes | `PUBLIC_DATA_SIZE_V1` |
| V2 and V3 public data | up to 4807 bytes | `PUBLIC_DATA_MAX_SIZE_V2` |
| Dense V2 and V3 public data | 164 bytes | `PUBLIC_DATA_SIZE_DENSE_V2` |
| V4 public data | up to 832 bytes | `PUBLIC_DATA_MAX_SIZE_V4` |
| V4 public data, smallest statement | 240 bytes | `PUBLIC_DATA_MIN_SIZE_V4` |
| V4 ancestor headers | at most three | `MAX_CERTIFICATE_V4_ANCESTOR_HEADERS` |
| Proof | up to 62000 bytes | `MAX_ZK_PROOF_SIZE` |
| Whole certificate | 65000 bytes | `CERTIFICATE_MAX_SIZE` |

A pearld without the FP8 code allows 60000-byte proofs, and V1 to V3 proofs must fit in 60000 bytes on either ([Nodes with and without the FP8 code](../concepts/blocks-and-consensus-certificates.md#nodes-with-and-without-the-fp8-code)).

## Block checks

| Check | Throws unless |
| --- | --- |
| `checkMerkleRoot(block)` | the header's Merkle root matches the transactions, with pearld's message |
| `checkWitnessCommitment(block)` | the coinbase's witness commitment is right, with the rules of Pearl's `ValidateWitnessCommitment` |
| `checkCertificateBinding(block)` | the certificate's hash is the header hash, the header's proof commitment is the certificate's, neither public data nor proof is empty, a V1 to V3 proof is within 60000 bytes, and a V4 certificate's ancestor headers chain the block to the header its proof was keyed by; with Pearl's message |
| `checkCertificateRules(certificate, network, height)` | the certificate version is right for the height, with Pearl's message |

`checkCertificateRules` applies the version and dense-only rules. The rank-penalty rule reads the certificate's public data, so it is in `checkBlockWork` from `pearljs/mining` ([Build a block from a template](../guides/mining.md#build-the-block-skeleton)).

## Sizes

| Function | Result |
| --- | --- |
| `blockVsize` | The stripped size plus a quarter of the witness bytes, rounded up, with the certificate left out, Pearl's rule |
| `blockSize` | The serialized size with everything, certificate and ancestor headers included |
| `blockStrippedSize` | The size without certificate and witnesses |

A block may have at most `MAX_BLOCK_VSIZE` (1,000,000) vbytes.

`calculateMerkleRoot`, `witnessCommitment`, `certificateProofCommitment` and `serializeCertificate` are the pieces underneath.

## V4 certificates

The proof in a V4 certificate is keyed by one of the block's four most recent ancestors, and that ancestor's complete header opens the certificate's public data. `certificateAncestorHeader` returns it, and the headers between the block and that ancestor are in `certificate.ancestorHeaders`, which is empty when the ancestor is the parent:

```ts run
import { blockHashHex, certificateAncestorHeader, parseBlock } from 'pearljs';
import { SimulatedChain } from 'pearljs/testing';

const chain = new SimulatedChain();
chain.mine(2);
const block = parseBlock(await chain.rpc.getRawBlock(chain.tip.hash));
const certificate = block.certificate!;
console.log(certificate.version, certificate.ancestorHeaders?.length); // 4 0
console.log(blockHashHex(certificateAncestorHeader(certificate)!) === chain.blocks[1]!.hash); // true: keyed by the parent
```

## V4 statements

The rest of the public data is the statement the proof proves. `certificateStatement(certificate)` reads all of it, field by field, using the names from zk-pow's decoder (`PublicParams::from_bytes`), and [V4 statements](../concepts/blocks-and-consensus-certificates.md#v4-statements) describes the fields:

```ts run
import { V4_DEVICE_NAMES, certificateStatement, parseBlock } from 'pearljs';
import { SimulatedChain } from 'pearljs/testing';

const chain = new SimulatedChain();
chain.mine(1);
const certificate = parseBlock(await chain.rpc.getRawBlock(chain.tip.hash)).certificate!;
const statement = certificateStatement(certificate)!;
console.log(statement.k, V4_DEVICE_NAMES[statement.device], statement.experts); // 1024 H100 0
```

## Headers

A header is 108 bytes (`BLOCK_HEADER_SIZE`): the version, the previous block's hash, the Merkle root, the timestamp, the bits, and the proof commitment, which takes the place of Bitcoin's nonce. The block hash is the double SHA-256 of those bytes:

```ts run
import { blockHash, blockHashHex, parseBlockHeader, serializeBlockHeader } from 'pearljs';

const header = {
  version: 1,
  prevBlock: new Uint8Array(32),
  merkleRoot: new Uint8Array(32).fill(1),
  timestamp: 1760000000,
  bits: 0x1b00ffff,
  proofCommitment: new Uint8Array(32).fill(2),
};
const bytes = serializeBlockHeader(header);
console.log(bytes.length); // 108
console.log(parseBlockHeader(bytes).bits === header.bits); // true
console.log(blockHashHex(header)); // display order, as RPC shows it
console.log(blockHash(header).length); // 32 bytes in internal order, the reverse
```

Hashes inside headers and blocks are in internal byte order, while the text that RPC and explorers show is in the reverse order. `blockHashHex` and `transactionId` give the display form.
