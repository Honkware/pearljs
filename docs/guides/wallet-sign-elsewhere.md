# Sign a wallet send elsewhere

When the keys are on a hardware device, on a machine kept offline, or nowhere near a watch-only server, the wallet can still build the send and record it while something else signs. The wallet prepares the send as a PSBT, something outside it signs the PSBT, and the signed transaction goes back to the wallet to be recorded and broadcast. A signer that the application can call from the same process needs no PSBT carried by hand. Start from the wallet in [Send from a wallet](wallet-send.md).

## Prepare the send

`prepareSend` takes the same options as `send` and chooses coins in the same way, but stops before signing:

<!-- check-docs: declare const wallet: import('pearljs').PearlWallet; -->
```ts fragment
import { parsePearl } from 'pearljs';

const prepared = await wallet.prepareSend({
  recipients: [{ address: 'rprl1p8dhv8twyj9ezfvk62vvsfgw39s4dgl9t42y0549dc4d2947jj4cs30wfpz', amount: parsePearl('1.5') }],
  feeRate: 2000n, // grain/kvB
});
console.log('fee', prepared.fee, 'change', prepared.change, 'to', prepared.changeAddress, 'held until', new Date(prepared.expiresAt ?? 0));
```

Nothing is signed, broadcast or recorded as sent, so the wallet doesn't need to be unlocked, and a watch-only wallet can prepare sends from its own accounts. The result holds the unsigned transaction as a base64 PSBT in `psbt`, along with its `fee`, `vsize`, `inputs`, `outputs`, `change` and `changeAddress`, and the wallet holds the coins it chose until the signed transaction comes back ([Holds](../reference/wallet-sign-elsewhere-holds.md#holds)). A prepared send spends account coins only ([Inputs and coins](../reference/wallet-sign-elsewhere-holds.md#inputs-and-coins)).

## Sign it

The PSBT goes to whatever holds the keys. On a machine with the recovery phrase, the signing account checks the payment and signs each input, and [PSBT workflows](psbt.md) explains both steps:

<!-- check-docs: declare const prepared: import('pearljs').PreparedSend; declare const phrase: string; -->
```ts fragment
import { checkPsbtPayment, deriveSigningAccountFromSeed, finalizePsbt, mnemonicToSeed, networks, parsePearl, parsePsbt, serializeTransaction } from 'pearljs';

const network = networks.regtest;
const account = deriveSigningAccountFromSeed(mnemonicToSeed(phrase), network);
const psbt = parsePsbt(prepared.psbt);
checkPsbtPayment(psbt, account.watchOnlyAccount(), {
  network,
  recipients: [{ address: 'rprl1p8dhv8twyj9ezfvk62vvsfgw39s4dgl9t42y0549dc4d2947jj4cs30wfpz', amount: parsePearl('1.5') }],
  maxFee: parsePearl('0.001'),
});
for (let i = 0; i < psbt.inputCount; i += 1) account.signInput(psbt, i);
const signedHex = serializeTransaction(finalizePsbt(psbt));
account.destroy();
```

A hardware device takes the same PSBT through its own software ([Sign with a hardware or external signer](psbt-hardware.md)). Either way, what comes back to the wallet is the signed transaction.

## Submit the signed transaction

`submitSigned` takes the signed transaction as hex, bytes or a parsed `Transaction`, checks it, and then records and broadcasts it exactly as `send` does:

<!-- check-docs: declare const wallet: import('pearljs').PearlWallet; declare const signedHex: string; -->
```ts fragment
const sent = await wallet.submitSigned(signedHex, { label: 'supplier invoice 88' });
console.log(sent.txid);
```

The wallet accepts only the transaction it prepared, while it is still held: the same inputs, outputs, sequences and lock time, and so the same txid. It then checks that every input is signed and that each signature is valid for the output it spends, and holds the transaction to pearld's relay policy and to the fee ceiling it was prepared under. A failed broadcast is handled as in [Handle a failed broadcast](wallet-send.md#handle-a-failed-broadcast).

A signed transaction the wallet won't take comes back as an error, and [Refusals](../reference/wallet-sign-elsewhere-holds.md#refusals) lists the codes and what to do about each.

A signer that the application can call directly, such as a device behind a transport or a signing service, doesn't need a PSBT carried by hand: pass it to `send` as `signer` ([Signing in the same process](../reference/wallet-sign-elsewhere-holds.md#signing-in-the-same-process)). [Complete example](../reference/wallet-sign-elsewhere-holds.md#complete-example) runs a watch-only wallet with a separate signer from start to finish.
