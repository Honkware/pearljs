# PSBT checks and compatibility

## Sighash types a signer accepts

A PSBT input can carry a sighash type, and whoever handled the PSBT last can set it. That field decides what the signature commits to. SIGHASH_NONE, for example, commits to no outputs: whoever holds such a signature can send the money anywhere.

The PSBT signers sign with SIGHASH_DEFAULT only, which commits to everything. An input that asks for another type is refused unless the caller lists that type in `allowedSighashTypes`. The PSBT signers are:

- `signInput`, `signInputAsync`;
- `signTaprootKeyPathInputAsync`;
- `signScriptPathInput`, `signTaprootScriptPathInput`, `signP2mrScriptPathInput`;
- the async variants.

```ts run
import {
  Transaction,
  addInputByTxid,
  createPsbt,
  createTransaction,
  deriveSigningAccountFromSeed,
  mnemonicToSeed,
  networks,
  toOutputScript,
} from 'pearljs';

const network = networks.regtest;
const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const account = deriveSigningAccountFromSeed(mnemonicToSeed(phrase), network);

const unsigned = createTransaction(2);
addInputByTxid(unsigned, '11'.repeat(32), 0);
unsigned.addOutput(toOutputScript(account.deriveAddress(5), network), 99_000n);
const psbt = createPsbt(unsigned);

// Someone prepared this input to be signed for itself and one output only.
const type = Transaction.SIGHASH_SINGLE | Transaction.SIGHASH_ANYONECANPAY;
account.prepareInput(psbt, 0, { index: 0, value: 100_000n, sighashType: type });

try {
  account.signInput(psbt, 0, { index: 0 });
} catch (err) {
  console.log((err as Error).message); // PSBT input 0 asks for sighash type 0x83, which is not in allowedSighashTypes
}

// Signing with it has to be said out loud.
account.signInput(psbt, 0, { index: 0, allowedSighashTypes: [type] });
```

`prepareInput` and the script-path prepare functions take a `sighashType` to write into the PSBT. Signing with it needs the same type in `allowedSighashTypes`. The list replaces the default, so include `Transaction.SIGHASH_DEFAULT` in it to keep accepting that too. The raw-transaction signers (`signP2mrInput`, `signTapscriptUnchecked`) take `sighashType` as an argument, never from the transaction, so they have no such option.

## Parsing

`parsePsbt` takes base64 and applies the checks of Pearl's own parser (`psbt.NewFromRawBytes`). It refuses:

- anything that is not canonical padded base64 (`PSBT must be canonical padded base64`);
- bytes after the last map (`invalid PSBT: 1 bytes follow the last map`);
- lengths written as non-canonical varints (`invalid PSBT: a length is a non-canonical varint`);
- a key or value that runs past the end;
- an input sighash type field that is not 4 bytes;
- an unsigned transaction that already contains signatures or witnesses.

Every failure is a `PearlError` with code `PSBT_MALFORMED`. For anything that came over a wire, use `parsePsbt`. The class's own `Psbt.fromBase64` makes none of these checks. `createPsbt(tx)` starts a PSBT from an unsigned transaction, and `addPearlOutput` adds an output by Pearl address, to a PSBT or a transaction.

Parsing checks the encoding, not the intent. Before signing a PSBT from someone else, read its outputs and amounts and compare them with what you were asked to pay. Leave `allowedSighashTypes` alone unless you know why the type is there.

## Finalizing

`finalizePsbt` finalizes every input and returns the transaction. Script-path inputs get the witness layout Pearl accepts, after a check that the leaf opens the output and every signature in it verifies. Every witness is run through Pearl's script rules before it is kept. These all fail here with a typed error, not at the node:

- a key-path signature that does not verify;
- a timelock the transaction does not meet;
- a leaf that wants more than its signatures.

Always finalize with it and not with the `Psbt` class's own `finalizeAllInputs`. That method cannot finalize P2MR inputs and leaves out the empty items a multi_a witness needs.

An input with no key-path signature and no leaf to spend through fails with `INPUT_NOT_FINALIZED`.

Extraction refuses a transaction paying more than 5000 grain per vbyte, usually the sign of a missing change output. Do not disable that guard to make an unchecked transaction pass.

## Custom witnesses

Before anything is written, `finalizeScriptPathInput` runs the finished witness through Pearl's script rules for that input. If the script engine refuses it, the function throws a `ScriptRejectedError` and leaves the input as it was, with the engine's own code in `scriptCode`, for example `ErrEqualVerify` for a wrong preimage or `ErrUnsatisfiedLockTime` for a timelock the transaction does not meet. The most common cause is items in the wrong order, and [Check a spend with the script interpreter](../guides/interpreter.md) shows how to step through a leaf to see its stack.

### Other inputs

`finalizePsbt` makes the same script check on every witness it builds itself. It finalizes on its own the leaves that need nothing but signatures:

- a multi_a leaf;
- a `<key> OP_CHECKSIG` leaf;
- a leaf that wraps one of those in a timelock.

For any other leaf it tries the signatures alone. When the engine refuses that witness, it throws `WITNESS_ITEMS_NEEDED` with the engine's verdict as the error's `cause` and leaves the input untouched. Inputs already finalized by `finalizeScriptPathInput` are kept as they are, so finalize the custom inputs first and then call `finalizePsbt`, or `finalizePayment`, for the rest.

P2MR inputs work the same way once `prepareP2mrScriptPathInput` has prepared them. Some fields of the transaction itself are still yours to set:

- a `cltvScript` branch needs the transaction's locktime;
- a `csvScript` branch needs the input's sequence;
- an annex, or a signature after `OP_CODESEPARATOR`, is signed on the transaction instead ([Sign a leaf on the transaction](../guides/p2mr-other-leaves.md#sign-a-leaf-on-the-transaction)).

## Compatibility with Pearl's tools

P2TR inputs, key path and script path, use the standard BIP371 fields, and Pearl's Go psbt package reads and finalizes them. P2MR inputs use fields that package already has, written byte for byte as it writes them ([Sign through a PSBT](../guides/p2mr-sign.md#sign-through-a-psbt)).

Pearl has no P2MR PSBT code, so its own tools cannot finalize P2MR PSBTs:

- Its parser checks every tap-leaf control block as a Taproot one. It rejects a single-leaf P2MR control block.
- It loads a longer P2MR control block only when the first proof hash happens to be a valid x-only key.
- Its `psbt.Finalize` takes P2TR inputs only.

Finalize P2MR PSBTs with pearljs and hand Pearl the extracted transaction, not the PSBT.

Neither pearld nor Oyster has PSBT RPC methods. XMSS signatures have no PSBT field, so XMSS spends are signed on the transaction ([XMSS](../concepts/xmss.md)).
