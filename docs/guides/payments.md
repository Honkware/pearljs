# Build a payment for another signer

Use `buildPayment` when the keys that sign a payment are somewhere pearljs doesn't hold them, such as a hardware device, an offline machine or a signing service. It chooses the coins, adds change and works out the fee just as `payFromAccount` does, then hands back the unsigned transaction and a PSBT for the signer. If you hold the recovery phrase of the account you're paying from, start with [Send a payment](send-a-payment.md), which builds and signs in one call.

## Build the payment

`buildPayment` takes the same options as `payFromAccount`. The coins are plain `Utxo` values because the builder doesn't need to know who holds them, and this example keeps each coin's child index next to it so that an account can sign for it later:

```ts run
import {
  buildPayment,
  deriveSigningAccountFromSeed,
  finalizePayment,
  mnemonicToSeed,
  networks,
  parsePearl,
  toOutputScript,
  type Utxo,
} from 'pearljs';

const network = networks.regtest;
const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const account = deriveSigningAccountFromSeed(mnemonicToSeed(phrase), network);

const utxos: (Utxo & { index: number })[] = [4, 5].map((index) => ({
  txid: `${index}`.repeat(64),
  vout: 0,
  value: parsePearl('1'),
  script: toOutputScript(account.deriveAddress(index), network),
  confirmations: 2,
  index,
}));

const payment = buildPayment({
  network,
  utxos,
  recipients: [{ address: account.deriveAddress(9), amount: parsePearl('1.2') }],
  feeRate: 1000n, // grain/kvB
  changeAddress: account.deriveAddress(0, true),
});
```

`payment` holds the unsigned `transaction` and a `psbt` over it. It also holds the coins the builder chose, as `inputs`, with their scripts and values in `prevouts`, and the `fee` and `vsize` that the signed transaction will have, so the fee can be shown to a user before anything is signed.

The builder prices each input at the size it will have once signed. A P2TR coin is priced as a key-path spend, so give a coin a `spend` when it will be spent through a script leaf instead. `spend` has the shape that [`estimateVsize`](relay-policy-and-fee-bumping.md#estimate-size-and-fee) takes, and a P2MR coin must always have one.

## Sign the inputs

The inputs of a fresh PSBT are bare. `prepareInput` adds the spent output and the key's derivation record to an input, and `signInput` signs it:

```ts continues
payment.inputs.forEach((utxo, i) => account.prepareInput(payment.psbt, i, { index: utxo.index, value: utxo.value }));
payment.inputs.forEach((utxo, i) => account.signInput(payment.psbt, i, { index: utxo.index }));
const signed = finalizePayment(payment);
console.log(signed.txid, signed.vsize, 'vbytes, estimated', payment.vsize);
```

Prepare every input before signing any of them, because a Taproot signature covers the value and script of every output the transaction spends. `signInput` throws `INPUT_UNPREPARED` while any input is still missing them. When the keys are on a hardware device, `account.signInputAsync` signs the same way and waits for the device.

`payFromAccount` goes through these same steps itself. With a device or another machine as the signer, the PSBT travels to it and comes back signed, and [PSBT workflows](psbt.md) walks through both cases.

## Finalize it

`finalizePayment` turns the signed payment into a transaction ready to broadcast. How you call it depends on what the signer gives back:

- After signing through the PSBT, as above, call `finalizePayment(payment)`.
- When the signer returns a signed transaction instead, pass it as `finalizePayment(payment, { signed })`.

Either way the result goes through `checkStandard`, which applies pearld's relay rules, before it comes back. If the signed transaction is not the one this payment built, `finalizePayment` throws `the signed transaction is not the one this payment built`.

## Let the signer check the change

A signer on another machine sees only the PSBT, so it needs a way to tell the change output from a payment. Give `buildPayment` `changeFrom: { account, index }` in place of `changeAddress`. The change then goes to that child of the account's change chain and the PSBT's change output records its derivation, so the signer can confirm with `checkPsbtPayment` that the change returns to its own key before it signs. [PSBT workflows](psbt.md#payment-check) shows the check.

## Signed payment

`finalizePayment` returns a `SignedPayment`, and so does `payFromAccount`, which also checks first that each coin really pays the address of the child key named for it.

| Field | Value |
| --- | --- |
| `transaction`, `hex`, `txid` | The signed transaction, its hex and its id |
| `inputs`, `prevouts` | The outputs it spent, and their scripts and values |
| `fee` | The fee in grain |
| `vsize` | The size in vbytes |
| `change`, `changeIndex` | The change value and its output index, 0n and -1 when there is no change output |

## Recipients

A recipient is `{ address, amount }` or `{ script, amount }`, with the amount in grain. The script form pays an output script directly, which is how to add an output that has no address, such as an OP_RETURN data output made with `embed`:

```ts continues
import { embed } from 'pearljs';

const withNote = buildPayment({
  network,
  utxos,
  recipients: [
    { address: account.deriveAddress(9), amount: parsePearl('0.5') },
    { script: embed({ data: new TextEncoder().encode('invoice 1041') }).output, amount: 0n },
  ],
  feeRate: 1000n, // grain/kvB
  changeAddress: account.deriveAddress(0, true),
});
console.log(withNote.transaction.outs.length, 'outputs');
```

Several recipients make several outputs in the order given, and the change output comes last. One recipient can take `amount: 'max'` alongside others with fixed amounts, and it then receives whatever the fixed amounts and the fee leave. Such a payment spends every coin it is given and has no change output.

## Version and locktime

`version` sets the transaction's version. It is 1 by default, because Oyster, Pearl's own wallet, writes version 1. `locktime` sets the transaction's lock time and is 0 by default. [Multisig and timelocks](multisig-and-timelocks.md#timelocks) covers the spends that need one.

## Reused coins and stale fees

The builder works from the list of coins it is given and never asks a node about them. Two payments built from the same list spend the same coins and only one of them can confirm, so keep track of what you have spent, or fetch the list again from a backend after each send. [Wallet backends](wallet-backends.md) covers where the list comes from, and a `PearlWallet` keeps this record for you ([Send from a wallet](wallet-send.md)).

The fee rate is fixed when the payment is built, and a rate that was right an hour ago may be too low now. Build the payment shortly before it is broadcast, or mark it replaceable with `rbf: true` so its fee can be raised later ([Relay policy and fee bumping](relay-policy-and-fee-bumping.md)).

`checkStandard` checks relay policy and doesn't look the coins up on the chain. A payment that spends an output that doesn't exist is refused by the node when it is broadcast, and pearljs doesn't catch it earlier.

## Next steps

- [Build a transaction by hand](payments-by-hand.md) covers transactions whose inputs and outputs are already decided.
- [Fees and coin selection](../reference/payments-fees-and-coins.md) has the fee units, the fee ceiling and how coins are chosen.
