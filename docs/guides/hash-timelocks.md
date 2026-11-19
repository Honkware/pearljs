# Build a hash timelock contract

A hash timelock contract (HTLC) pays one party who reveals a secret, and gives the coins back to the other party if the secret has not come out by a deadline. Atomic swaps and payment channels are built from them: two HTLCs on two chains are locked to the same hash, so claiming one reveals the secret that claims the other.

On Pearl an HTLC is a script tree of two leaves, in a P2TR or a P2MR output:

| Leaf | Script | Spent with |
| --- | --- | --- |
| claim | `OP_SIZE 32 OP_EQUALVERIFY OP_SHA256 <hash> OP_EQUALVERIFY <claim key> OP_CHECKSIG` | the claim key's signature and the 32-byte preimage |
| refund | `<lock> OP_CHECKLOCKTIMEVERIFY OP_DROP <refund key> OP_CHECKSIG`, or `OP_CHECKSEQUENCEVERIFY` for a relative lock | the refund key's signature, once the lock has passed |

The preimage is the secret, and the hash in the claim leaf is its hash. The `OP_SIZE` check holds the preimage to 32 bytes, so a secret that claims on another chain with the same rule also claims here. For counterparties that lock to `RIPEMD160(SHA256(preimage))`, a 20-byte hash is checked with `OP_HASH160` instead of `OP_SHA256`.

## Build the contract

`htlcLeaves` makes both leaves from the hash, the two parties' x-only keys and the deadline:

```ts run
import { assembleScriptTree, htlcLeaves, networks, p2mrAddress, scriptToAsm, sha256 } from 'pearljs';

const preimage = new Uint8Array(32).fill(7); // in practice crypto.getRandomValues(new Uint8Array(32))
const { claim, refund } = htlcLeaves({
  hash: sha256(preimage),
  claimKey: new Uint8Array(32).fill(2), // x-only keys of the two parties
  refundKey: new Uint8Array(32).fill(3),
  timelock: { locktime: 200_000 }, // or { sequence: encodeSequence({ blocks: 144 }) }
});
const tree = assembleScriptTree([claim, refund]);
console.log(p2mrAddress({ merkleRoot: tree.root }, networks.mainnet).startsWith('prl1z')); // true
tree.leaves.forEach((leaf) => console.log(scriptToAsm(leaf.script)));
```

Assemble the leaves in the order shown, so that both parties derive the same tree and address. In the printed scripts, Pearl's disassembly shows the pushed 32 as `20`, its hex.

A `{ locktime }` deadline is a block height below 500000000 or a Unix time at or above it. A `{ sequence }` deadline counts from the block that confirms the funding output, and comes from `encodeSequence` ([Timelocks](multisig-and-timelocks.md#timelocks)).

Pay to the tree as a P2MR output with `p2mr` or `p2mrAddress`, or as a P2TR output with an internal key, `p2tr({ internalPubkey, merkleRoot })`. For a P2TR output that only the leaves can spend, use `NUMS_INTERNAL_KEY` as the internal key ([Script trees in P2TR outputs](../reference/p2mr-control-blocks.md#script-trees-in-p2tr-outputs)).

`hashlockScript(hash, script)` puts the same hash check in front of any other leaf. `parseHtlcLeaf` reads a claim or refund leaf back into its hash, key and timelock, and returns `null` for anything else. That includes a leaf that pushes the same values in more bytes than they need, which Pearl's script engine refuses to run anyway.

## Claim with the preimage

The claimant builds the spend, signs the claim leaf, and finalizes it with `htlcStack`, which puts the signature and the preimage under the leaf:

```ts run
import {
  addInputByTxid,
  assembleScriptTree,
  createPsbt,
  createTransaction,
  deriveSigningAccountFromSeed,
  estimateVsize,
  extractHtlcPreimage,
  finalizePsbt,
  finalizeScriptPathInput,
  htlcLeaves,
  htlcStack,
  htlcStackSizes,
  mnemonicToSeed,
  networks,
  p2mr,
  parsePearl,
  prepareP2mrScriptPathInput,
  sha256,
  toOutputScript,
} from 'pearljs';

const network = networks.regtest;
const seed = mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const claimer = deriveSigningAccountFromSeed(seed, network, 0);
const refunder = deriveSigningAccountFromSeed(seed, network, 1);
const preimage = new Uint8Array(32).fill(7);

const { claim, refund } = htlcLeaves({
  hash: sha256(preimage),
  claimKey: claimer.derivePublicKey(0),
  refundKey: refunder.derivePublicKey(0),
  timelock: { locktime: 200_000 },
});
const tree = assembleScriptTree([claim, refund]);

const funding = createTransaction(2); // a made-up transaction paying the contract 3 PRL
addInputByTxid(funding, 'cc'.repeat(32), 0);
funding.addOutput(p2mr({ merkleRoot: tree.root }).output, parsePearl('3'));

const unsigned = createTransaction(2);
addInputByTxid(unsigned, funding.getId(), 0);
unsigned.addOutput(toOutputScript(claimer.deriveAddress(1), network), parsePearl('2.9999'));
const psbt = createPsbt(unsigned);
prepareP2mrScriptPathInput(psbt, 0, { tree, leafIndex: 0, value: parsePearl('3'), previousTransaction: funding });
claimer.signScriptPathInput(psbt, 0, { index: 0, leafHash: tree.leaves[0]!.leafHash });
finalizeScriptPathInput(psbt, 0, { stack: htlcStack(claim, { preimage }) });
const tx = finalizePsbt(psbt);

console.log(tx.ins[0]!.witness.map((item) => item.length)); // [ 64, 32, 73, 33 ]
console.log(estimateVsize(tx, [{ type: 'scriptPath', tree, leafIndex: 0, p2mr: true, stack: htlcStackSizes(claim) }]) === tx.virtualSize()); // true
console.log(extractHtlcPreimage(tx, sha256(preimage))?.inputIndex); // 0
```

The witness is the signature, the preimage, the leaf script and the control block. `htlcStack(leaf, { preimage })` checks the preimage before anything is finalized, and throws `PREIMAGE_INVALID` if it is missing, is not 32 bytes or does not hash to the leaf's hash. `finalizeScriptPathInput` then runs the leaf through Pearl's script rules and writes the witness only if it passes ([Finalize leaves that need more than signatures](psbt-co-signers.md#finalize-leaves-that-need-more-than-signatures)).

## Refund after the lock

The refund leaf takes only the refund key's signature, so its stack is `htlcStack(refund)`. The leaf checks its lock against fields of the spending transaction, which the refunder sets:

- For `{ locktime }`, set the transaction's locktime to the leaf's value or later, of the same kind (height or time), and give the input a sequence other than 0xffffffff. pearld relays the refund once the locktime has passed, which for a height lock is in the block after that height.
- For `{ sequence }`, make the transaction version 2 and give the input a sequence of the same kind as the leaf's value and at least as long. pearld relays the refund once the funding output is that old.

If the fields do not meet the leaf's lock, `finalizeScriptPathInput` refuses the refund with the engine's `ErrUnsatisfiedLockTime`. If they meet it but the lock has not yet passed on chain, pearld refuses it when you broadcast. To check a locktime beforehand, call `checkStandard` with `height` and `medianTimePast`.

## Fees

`htlcStackSizes(leaf)` gives the sizes of the witness items under the leaf, which is what `estimateVsize` takes as `stack`. They are `[64, 32]` for a claim and `[64]` for a refund, with 65 in place of 64 for a signature whose sighash type is not SIGHASH_DEFAULT. With them the estimate equals the signed transaction's vsize exactly, as the claim example shows.

## Read the secret from a claim

In a swap, the counterparty watches for the claim and reads the preimage out of its witness to claim on the other chain. `extractHtlcPreimage(tx, hash)` looks through every input's witness for an item that hashes to `hash`, with SHA-256 for a 32-byte hash and HASH160 for a 20-byte one, and returns it as `{ preimage, inputIndex }`, with the index of the input that revealed it. It returns `null` when no item matches, as for a refund, which carries no preimage.
