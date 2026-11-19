# Parse and check a block

An indexer, a miner's tooling or anything else that handles raw Pearl blocks can parse them with pearljs and check the parts of a block that can be checked without verifying its proof. The proof itself is checked separately, by `pearljs/verify-proof` ([Verify a block's proof](verify-proof.md)).

pearljs also carries each network's consensus numbers, from fork heights and certificate rules to difficulty, work and the emission curve, which [Consensus parameters](../reference/blocks-and-consensus-parameters.md) lists.

## Parse the block

On the wire, a Pearl block is its certificate, then the 108-byte header, then the transactions. This example takes its block from the simulated chain in `pearljs/testing`, so it runs without a node, and with a node the bytes come from `PearldClient.getRawBlock(hash)`:

```ts run
import {
  blockHashHex,
  blockSize,
  blockVsize,
  checkCertificateBinding,
  checkCertificateRules,
  checkMerkleRoot,
  checkWitnessCommitment,
  isMoECertificate,
  parseBlock,
  parsePearl,
  serializeBlock,
  transactionId,
} from 'pearljs';
import { SimulatedChain, testAddress } from 'pearljs/testing';

// A block with a payment in it, as getblock returns it with verbosity 0.
const chain = new SimulatedChain();
chain.pay(testAddress(0), parsePearl('1'));
chain.mine();
const raw = await chain.rpc.getRawBlock(chain.tip.hash);

const block = parseBlock(raw);
checkCertificateBinding(block); // throws unless the certificate belongs to this header
checkCertificateRules(block.certificate, chain.network, chain.height); // throws unless its version is right for the height
checkWitnessCommitment(block); // throws unless the coinbase commits to the witnesses
checkMerkleRoot(block); // throws unless the header's Merkle root is that of the transactions

console.log(blockHashHex(block.header) === chain.tip.hash); // true
console.log(block.certificate?.version, block.certificate && isMoECertificate(block.certificate)); // 4 false
console.log(blockSize(block), 'bytes,', blockVsize(block), 'vbytes,', block.transactions.length, 'transactions');
console.log(transactionId(block.transactions[0]!)); // the coinbase
console.log(Buffer.from(serializeBlock(block)).equals(raw)); // true
```

`parseBlock` applies Pearl's certificate limits and reports a breach in the words Pearl's own decoder uses ([Certificate limits](../reference/blocks-and-consensus-limits.md#certificate-limits)). It also rejects non-canonical transactions and trailing bytes. The transactions are `Transaction` objects, the same class `parseTransaction` returns. The parsers return copies, so the result shares no memory with the input, even when the input is a Node `Buffer`.

Each check function throws when its part of the block is wrong, and [Block checks](../reference/blocks-and-consensus-limits.md#block-checks) lists what each one tests. A block that passes them all may still have an invalid proof ([Certificates and block checks](../concepts/blocks-and-consensus-certificates.md)).

## Look up more

[Block limits and checks](../reference/blocks-and-consensus-limits.md) also covers [reading a V4 certificate's ancestor](../reference/blocks-and-consensus-limits.md#v4-certificates), [its statement](../reference/blocks-and-consensus-limits.md#v4-statements) and [working with a header](../reference/blocks-and-consensus-limits.md#headers).
