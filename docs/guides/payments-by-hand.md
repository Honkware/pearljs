# Build a transaction by hand

When the inputs and outputs of a transaction are already decided, you can build it directly instead of going through the payment builder in [Send a payment](send-a-payment.md).

## Build the transaction

`createTransaction` makes an empty transaction of the version you give it, and `addInputByTxid` adds an input by the transaction id as explorers and RPC show it. Wrap the transaction in a PSBT with `createPsbt` so that it can be signed, and add more outputs to either one as you go:

```ts run
import {
  addInputByTxid,
  addPearlOutput,
  createPsbt,
  createTransaction,
  deriveSigningAccountFromSeed,
  finalizePsbt,
  mnemonicToSeed,
  networks,
  serializeTransaction,
  toOutputScript,
  transactionId,
} from 'pearljs';

const network = networks.regtest;
const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const account = deriveSigningAccountFromSeed(mnemonicToSeed(phrase), network);

const unsigned = createTransaction(2);
addInputByTxid(unsigned, '6f1e3c0b5d1a4c0e9b7a2d4f8c6e0a1b3d5f7092a4c6e8f0b1d3f507192b4d6f', 1);
unsigned.addOutput(toOutputScript(account.deriveAddress(9), network), 99_000n);

const psbt = createPsbt(unsigned);
addPearlOutput(psbt, account.deriveAddress(0, true), 800n, network);
```

Nothing at this level chooses coins or works out a fee. The fee is whatever the inputs hold beyond the outputs, so here, with an input of 100,000 grain and outputs of 99,000 and 800, it is 200 grain.

## Sign it

An account signs the inputs that spend its own coins. `prepareInput` adds the spent output, the internal key and the BIP86 derivation record to an input, and `signInput` signs it:

```ts continues
account.prepareInput(psbt, 0, { index: 0, value: 100_000n }); // the spent output: child 0, 100000 grain
account.signInput(psbt, 0, { index: 0 });
```

Before it signs, `signInput` checks that the spent output's script belongs to the child key it was told. These two methods cover BIP86 key-path spends. Spends through a script leaf are in [P2MR](p2mr.md), [Multisig and timelocks](multisig-and-timelocks.md) and [PSBT workflows](psbt.md).

## Finalize it

`finalizePsbt` puts the signatures in place and returns the transaction, ready to broadcast:

```ts continues
const tx = finalizePsbt(psbt);
console.log(transactionId(tx), serializeTransaction(tx).length / 2, 'bytes');
```

`finalizePsbt` refuses a PSBT that pays more than 5000 grain per vbyte. A fee that high usually means a change output is missing, so fix the transaction rather than turning the guard off.

`addInputByTxid` and `addPearlOutput` are two of the helpers that sit beside the `Transaction` and `Psbt` classes, and [Transaction helpers](../reference/payments-by-hand-helpers.md#helpers) lists the rest.

## Sweep a single key

To move everything a single private key holds, such as a key exported with `dumpprivkey` or kept on a paper backup, use `sweepWif` for a key in WIF form or `sweepKey` for raw key bytes. Each spends every output of the key's key-path address into one output, with no change. That address is `keyPathAddress(privateKey, network)`, the one Oyster gives an imported key. [Sweeping](../reference/payments-by-hand-helpers.md#sweeping) has an example and how its fee differs from Oyster's `sweepaccount`.

## Read a transaction

`inspectTransaction` reads a transaction against the outputs it spends, given in input order, and reports what it pays and how each input was spent. That is useful for checking a transaction from anywhere before you sign or broadcast it. [Reading transactions](../reference/payments-by-hand-helpers.md#reading-transactions) has an example and what it reports for each input, and [Reading a coinbase](../reference/payments-by-hand-helpers.md#reading-a-coinbase) covers the transaction that pays a block's reward.
