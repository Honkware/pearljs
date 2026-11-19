# Timelock and multisig reference

## Multisig leaves

`multiAScript` takes 1 to 999 x-only keys, in the order given, and a threshold from 1 to the number of keys. It writes the leaf the way Pearl's psbt package recognises it, with the threshold as a small-int opcode up to 16 and a minimal push above that, and it refuses duplicate keys. `parseMultiA` reads such a leaf back, and returns null for any other leaf.

## Multisig witnesses

The witness holds one item per key, in reverse script order: Carol's signature, an empty item for Bob, Alice's signature, then the script and the control block, which for a tree of one leaf is a single byte. `finalizePsbt` lays it out the way Pearl's PSBT code does, with empty items for keys that did not sign and any signatures beyond the threshold dropped. Pearl rejects a witness without the empty items, so always finalize with `finalizePsbt` rather than the `Psbt` class's own `finalizeAllInputs()`, which leaves them out.

Before it builds the witness, `finalizePsbt` checks that the leaf opens the output and that every signature for a key in the leaf verifies, so a PSBT that cannot make a valid spend fails there with the key named (`PSBT input 0 has an invalid script-path signature for key ...`). To build a multi_a witness outside a PSBT, `multiAStack` puts the signatures in the right order.

## Sequences

`encodeSequence` makes the sequence for a relative lock and matches Pearl's `LockTimeToSequence`. It rounds seconds down to 512-second units, so a week given in seconds becomes 1181 units, or 604672 seconds. `decodeSequence` reads a sequence the way Pearl's sequence-lock code does, and returns null when the disable flag is set, which includes every replace-by-fee sequence from 0xfffffffd up:

```ts run
import { decodeSequence, encodeSequence } from 'pearljs';

console.log(encodeSequence({ blocks: 1008 })); // 1008
console.log(decodeSequence(encodeSequence({ seconds: 7 * 24 * 3600 }))); // { seconds: 604672 }
console.log(decodeSequence(0xfffffffd)); // null
```

The BIP68 fields are exported as `SEQUENCE_LOCKTIME_DISABLED`, `SEQUENCE_LOCKTIME_IS_SECONDS`, `SEQUENCE_LOCKTIME_MASK` and `SEQUENCE_LOCKTIME_GRANULARITY` (9, for 512-second units).

## Spending a timelocked leaf

Once the output is old enough, the recovery key spends alone through the CSV leaf. The transaction is version 2, and its input carries the leaf's sequence:

```ts run
import {
  addInputByTxid,
  assembleScriptTree,
  checksigScript,
  createPsbt,
  createTransaction,
  csvScript,
  deriveSigningAccountFromSeed,
  encodeSequence,
  finalizePsbt,
  mnemonicToSeed,
  multiAScript,
  networks,
  p2mr,
  parsePearl,
  prepareP2mrScriptPathInput,
  toOutputScript,
} from 'pearljs';

const network = networks.regtest;
const seed = mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const recovery = deriveSigningAccountFromSeed(seed, network, 3);
const others = [0, 1, 2].map((n) => deriveSigningAccountFromSeed(seed, network, n).derivePublicKey(0));

const lock = encodeSequence({ blocks: 1008 });
const tree = assembleScriptTree([
  multiAScript(others, 2),
  csvScript(lock, checksigScript(recovery.derivePublicKey(0))),
]);
const output = p2mr({ merkleRoot: tree.root }).output;

const funding = createTransaction(2); // made up
addInputByTxid(funding, 'cc'.repeat(32), 0);
funding.addOutput(output, parsePearl('3'));

const unsigned = createTransaction(2); // CSV needs version 2
addInputByTxid(unsigned, funding.getId(), 0, lock); // and the lock as the input's sequence
unsigned.addOutput(toOutputScript(recovery.deriveAddress(0), network), parsePearl('2.9999'));

const psbt = createPsbt(unsigned);
prepareP2mrScriptPathInput(psbt, 0, { tree, leafIndex: 1, value: parsePearl('3'), previousTransaction: funding });
recovery.signScriptPathInput(psbt, 0, { index: 0, leafHash: tree.leaves[1]!.leafHash });
const tx = finalizePsbt(psbt);
console.log(tx.version, tx.ins[0]!.sequence, tx.getId());
```

pearld refuses this transaction until the funding output has 1008 confirmations. `checkStandard` leaves sequence locks to the node, so that refusal comes only when you broadcast.

A CLTV leaf is spent the same way, with `unsigned.locktime` set to the leaf's value or later and the input given a sequence such as 0xfffffffe. `checkStandard` with `height` and `medianTimePast` then tells you whether the locktime has been reached.

## Signers by leaf

| Leaf | Spend with |
| --- | --- |
| Single key | `payFromAccount`, which signs these leaves only |
| Multisig or timelocked | A PSBT, as shown here |
| Hash timelock | A PSBT, finalized with `finalizeScriptPathInput` and `htlcStack` ([Hash timelock contracts](../guides/hash-timelocks.md)) |
| Other conditions | `finalizeScriptPathInput` with a stack of your own ([Leaves that need more than signatures](../guides/psbt-co-signers.md#finalize-leaves-that-need-more-than-signatures)), or `signTapscriptUnchecked` and a hand-built witness ([Spend any other P2MR leaf](../guides/p2mr-other-leaves.md#sign-a-leaf-on-the-transaction)) |

An XMSS key cannot be one of the keys of a `multi_a` leaf, because `OP_CHECKXMSSSIG` is a leaf of its own ([XMSS](../concepts/xmss.md)).
