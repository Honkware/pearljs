# Sign a P2MR spend

`payFromAccount` spends a single-key P2MR leaf in one call, as [Build and spend a P2MR output](p2mr.md) shows. To sign the leaf yourself, sign it on the transaction when one program holds the keys, through a PSBT when the transaction travels between machines, or on a hardware device. The trees and the made-up funding transactions are built the same way as in that guide.

## Sign on the transaction

`signP2mrInput` signs one input of a `Transaction` through a single-key leaf, and `account.signP2mrInput` does the same with an account's child key as the signer. Give it the tree, the leaf, the child whose key the leaf pushes, and `prevouts`, the script and value of every input's spent output in input order:

```ts run
import {
  addInputByTxid,
  assembleScriptTree,
  checksigScript,
  checkStandard,
  createTransaction,
  deriveSigningAccountFromSeed,
  mnemonicToSeed,
  networks,
  p2mr,
  parsePearl,
  toOutputScript,
} from 'pearljs';

const network = networks.regtest;
const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const account = deriveSigningAccountFromSeed(mnemonicToSeed(phrase), network);

const tree = assembleScriptTree([0, 1, 2].map((index) => checksigScript(account.derivePublicKey(index))));
const output = p2mr({ merkleRoot: tree.root }).output;

const funding = createTransaction(2); // made up, as above
addInputByTxid(funding, 'aa'.repeat(32), 0);
funding.addOutput(output, parsePearl('5'));

const tx = createTransaction(2);
addInputByTxid(tx, funding.getId(), 0);
tx.addOutput(toOutputScript(account.deriveAddress(9), network), parsePearl('4.9999'));

const prevouts = [{ script: output, value: parsePearl('5') }];
account.signP2mrInput(tx, 0, {
  index: 1, // the child whose key leaf 1 pushes
  prevouts,
  tree,
  leafIndex: 1,
  previousTransactions: [funding],
});
checkStandard(tx, { prevouts });
console.log(tx.getId(), tx.ins[0]!.witness.map((item) => item.length)); // 64-byte signature, 34-byte script, 65-byte control block
```

The signer sets the input's witness to the signature, the leaf script and the control block, the same three items Pearl's wallet code builds. Before it signs, it checks that the spent output commits to the tree's root and that the leaf pushes the signer's key, and it checks the [previous transactions](p2mr.md#previous-transactions) and the fee.

## Fee guard

Because `signP2mrInput` sees every input value and every output, it checks the fee before it signs, and so do `signXmssP2mrInput` and the async variants of both. It throws `OUTPUTS_EXCEED_INPUTS` when the outputs add up to more than the inputs, and `FEE_TOO_HIGH` when the transaction pays more than `maxFeeRate`, which usually means a change output was forgotten. The default rate is `DEFAULT_MAX_FEE_RATE`, the fee ceiling described in [Fees and coin selection](../reference/payments-fees-and-coins.md#fee-ceiling).

To sign a transaction that is meant to pay more, pass a higher rate:

```ts
import { signP2mrInput, type P2mrSignOptions, type TapscriptSigner, type Transaction } from 'pearljs';

declare const tx: Transaction;
declare const signer: TapscriptSigner;
declare const options: P2mrSignOptions;

signP2mrInput(tx, 0, signer, { ...options, maxFeeRate: 20_000_000n }); // grain/kvB
```

The rate is worked out on the transaction with this input's witness in place. Inputs that are still unsigned make the transaction smaller than it will finally be, which can only make the check stricter. Under ANYONECANPAY others may still add inputs, so the outputs are allowed to exceed the inputs seen so far.

`signTapscriptUnchecked`, the bare primitive described in [Spend any other P2MR leaf](p2mr-other-leaves.md#sign-a-leaf-on-the-transaction), makes no fee check. PSBT spends get theirs when `finalizePsbt` extracts the transaction.

## Sighash types

The signers use SIGHASH_DEFAULT unless `sighashType` on `signP2mrInput` asks for another type: `Transaction.SIGHASH_ALL`, `SIGHASH_NONE` or `SIGHASH_SINGLE`, each with or without `SIGHASH_ANYONECANPAY`. The raw-transaction signers take the type only from this argument and never from the transaction. A signature with a type other than the default is 65 bytes instead of 64. XMSS leaves accept SIGHASH_DEFAULT only.

## Sign through a PSBT

A PSBT carries the spend from the party that builds it to the parties that sign ([Collect signatures from co-signers](psbt-co-signers.md)). Signing a P2MR leaf this way takes three steps:

1. `prepareP2mrScriptPathInput` adds what a signer needs to the input.
2. `account.signScriptPathInput` or `signP2mrScriptPathInput` adds a signature for one leaf.
3. `finalizePsbt` builds the witness and returns the transaction.

```ts run
import {
  addInputByTxid,
  assembleScriptTree,
  checksigScript,
  createPsbt,
  createTransaction,
  deriveSigningAccountFromSeed,
  finalizePsbt,
  mnemonicToSeed,
  networks,
  p2mr,
  parsePearl,
  prepareP2mrScriptPathInput,
  toOutputScript,
} from 'pearljs';

const network = networks.regtest;
const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const account = deriveSigningAccountFromSeed(mnemonicToSeed(phrase), network);

const tree = assembleScriptTree([0, 1, 2].map((index) => checksigScript(account.derivePublicKey(index))));
const output = p2mr({ merkleRoot: tree.root }).output;
const funding = createTransaction(2); // made up, as above
addInputByTxid(funding, 'aa'.repeat(32), 0);
funding.addOutput(output, parsePearl('5'));

const unsigned = createTransaction(2);
addInputByTxid(unsigned, funding.getId(), 0);
unsigned.addOutput(toOutputScript(account.deriveAddress(9), network), parsePearl('4.9999'));

const psbt = createPsbt(unsigned);
prepareP2mrScriptPathInput(psbt, 0, { tree, leafIndex: 2, value: parsePearl('5'), previousTransaction: funding });
account.signScriptPathInput(psbt, 0, { index: 2, leafHash: tree.leaves[2]!.leafHash });
const tx = finalizePsbt(psbt);
console.log(tx.getId());
```

`account.signScriptPathInput` signs P2TR and P2MR inputs alike, for any leaf that pushes the child key.

Pearl has no PSBT code for P2MR, so a P2MR input carries fields that Pearl's psbt package already has, and pearljs writes them byte for byte as that package does. The input has no internal key or Merkle root field, only these:

- the witness UTXO;
- a tap leaf script keyed by the P2MR control block (`0xc1` followed by the proof);
- tap script signatures;
- the sighash type, when it is not the default;
- the previous transaction as `nonWitnessUtxo`, when it is given.

`finalizePsbt` builds P2MR witnesses the way Pearl's finalizer builds them for P2TR, multi_a leaves included. First it checks that the leaf opens the output and that every signature for a key in the leaf verifies, and afterwards it runs the witness through Pearl's script rules, so a PSBT that cannot make a valid spend fails here with the key or the engine's error named. On a leaf that is not multi_a, it leaves out signatures for keys the leaf does not push and puts the rest in reverse script order.

Pearl's own tools cannot finalize P2MR PSBTs, so hand Pearl the extracted transaction rather than the PSBT ([Compatibility with Pearl's tools](../reference/psbt-checks.md#compatibility-with-pearls-tools)).

## Sign with a hardware device

Hardware wallets and other signers that answer asynchronously sign through `signP2mrInputAsync`, `signP2mrScriptPathInputAsync`, `signTaprootScriptPathInputAsync` (for a P2TR script path) and `signTapscriptUncheckedAsync`. Each takes a `TapscriptSignerAsync`, which is the leaf key as `publicKey` and a `signSchnorr(hash)` that resolves to 64 bytes. On a PSBT the call is `signP2mrScriptPathInputAsync(psbt, i, signer, { leafHash })`.

A leaf names its key as it is, so the device signs with the untweaked key at that path and applies no tweak. Every check, the previous-transaction check among them, runs before the device is asked, so a spend that would be refused never reaches it.

A key-path spend works the other way round, because there the signer has to tweak the key first. Key-path inputs of a BIP86 account go through `account.signInputAsync` and a `KeyPathSignerAsync`, and a transaction with both kinds of input uses both ([Sign with a hardware or external signer](psbt-hardware.md)).
