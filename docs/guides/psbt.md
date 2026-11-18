# Sign a PSBT on an offline machine

A recovery phrase kept on a machine that never connects to a network is out of reach of anything that compromises the online one. A PSBT (a partially signed transaction, BIP174 with the BIP371 Taproot fields) carries a transaction between the two: the online machine builds it, the offline machine checks and signs it, and the online machine broadcasts the result.

The online machine holds only the account's extended public key and talks to a node, so it chooses the coins and the fee. The offline machine holds the phrase and talks to nothing, so before it signs it checks where every grain goes, its own change included.

## Export the account key

The extended public key lets the online machine derive the account's addresses and build payments from them, but not sign. Export it once from the offline machine, together with its origin, the master fingerprint and derivation path of the account:

```ts run
import {
  buildPayment,
  checkPsbtPayment,
  deriveSigningAccountFromSeed,
  finalizePayment,
  finalizePsbt,
  formatPearl,
  importWatchOnlyAccount,
  mnemonicToSeed,
  networks,
  parsePearl,
  parsePsbt,
  parseTransaction,
  serializeTransaction,
  toOutputScript,
} from 'pearljs';

const network = networks.regtest;
const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
// Exported once from the offline machine: the account key and where it comes from.
const exported = deriveSigningAccountFromSeed(mnemonicToSeed(phrase), network).watchOnlyAccount();
const xpub = exported.extendedPublicKey();
const origin = { masterFingerprint: exported.masterFingerprint!, path: exported.path! };

const customer = 'rprl1p8dhv8twyj9ezfvk62vvsfgw39s4dgl9t42y0549dc4d2947jj4cs30wfpz';
```

## Build the payment online

On the online machine, `importWatchOnlyAccount` turns the key and its origin into an account without private keys. Build the payment from it with `buildPayment`, then call `prepareInput` on every input so the PSBT describes what each one spends:

```ts continues
// 1. Online, watch-only: build the payment and describe every input.
//    The unspent outputs come from a wallet backend in practice.
const watchOnly = importWatchOnlyAccount(xpub, network, origin);
const payment = buildPayment({
  network,
  utxos: [
    {
      txid: '6f1e3c0b5d1a4c0e9b7a2d4f8c6e0a1b3d5f7092a4c6e8f0b1d3f507192b4d6f',
      vout: 1,
      value: parsePearl('2'),
      script: toOutputScript(watchOnly.deriveAddress(3), network),
      confirmations: 12,
      index: 3,
      change: false,
    },
  ],
  recipients: [{ address: customer, amount: parsePearl('1.5') }],
  feeRate: 2000n, // grain/kvB
  // Change goes to the account's change chain, and the PSBT says which child holds it.
  changeFrom: { account: watchOnly, index: 0 },
});
payment.inputs.forEach((utxo, i) => watchOnly.prepareInput(payment.psbt, i, utxo));
// The PSBT is all that crosses to the offline machine, with the order it is meant to fill.
const request = payment.psbt.toBase64();
```

`changeFrom` sends the change to the account's change chain and records in the PSBT which child holds it, so the offline machine can recognise its own change. `prepareInput` writes each input's spent output and a [derivation record](#derivation-records) that names the child key it pays. Prepare every input before any is signed, because a Taproot signature covers all the spent outputs; signing early fails with `INPUT_UNPREPARED` and names the input.

The base64 `request` is all that needs to reach the offline machine, along with the order it is meant to fill, which here is 1.5 PRL to the customer.

## Check and sign offline

On the offline machine, parse the PSBT and check it against the order before signing anything. `checkPsbtPayment` returns the totals to show the person approving, and throws if the PSBT pays anyone else or pays too high a fee:

```ts continues
// 2. Offline, with the phrase: parse, check against the order, show the totals, sign.
const account = deriveSigningAccountFromSeed(mnemonicToSeed(phrase), network);
const psbt = parsePsbt(request);
const summary = checkPsbtPayment(psbt, account.watchOnlyAccount(), {
  network,
  recipients: [{ address: customer, amount: parsePearl('1.5') }],
  maxFee: parsePearl('0.001'),
});
console.log('sends', formatPearl(summary.sent), 'returns', formatPearl(summary.change), 'fee', formatPearl(summary.fee));
// Each input names its child in its derivation record, so no index is passed.
for (let i = 0; i < psbt.inputCount; i += 1) account.signInput(psbt, i);
const signedHex = serializeTransaction(finalizePsbt(psbt));
account.destroy();
```

`signInput` reads which child to sign with from each input's derivation record, so the loop passes no index. `finalizePsbt` builds the witnesses and returns the signed transaction, and `account.destroy()` wipes the keys from memory. The signed transaction goes back to the online machine as hex.

## Broadcast from the online machine

Back online, give the signed transaction to `finalizePayment`, which checks that it is the transaction the payment built:

```ts continues
// 3. Online again: check the signed transaction is the one that was built, then broadcast.
const signed = finalizePayment(payment, { signed: parseTransaction(signedHex) });
console.log(signed.txid, 'fee', formatPearl(signed.fee), 'PRL');
```

`finalizePayment` with `signed` checks that the transaction has the txid the payment built and that it passes `checkStandard`. The signatures are left to the node, which verifies them when you broadcast, as in [Send a payment](send-a-payment.md).

## Derivation records

A derivation record (`tapBip32Derivation`) holds the master fingerprint and the path to a child key. `prepareInput`, which both the watch-only and the signing account have, writes one for each input along with the witness UTXO and the internal key.

When `importWatchOnlyAccount` is given the key's origin, as in the example, the records are the ones Pearl's own PSBT code writes. Without an origin, the child is recorded under the account key's own fingerprint as `m/0/3`. The signing account for the same key reads that form too, though other software may not.

`signInput` without an `index` reads the child from the record and then checks, as it always does, that the input's witness UTXO pays that child. The record only tells it where to look, so a false record cannot make the account sign for a key it does not hold. An input whose record names none of the account's children fails with `DERIVATION_NOT_FOUND`.

On a change output, the records are the ones Oyster writes on its own change: the internal key and both BIP32 derivation records, byte for byte.

## Payment check

`checkPsbtPayment` is the offline machine's own view of the PSBT. It matches each expected recipient to one output of exactly that amount, and every other output has to be proven change. An output is proven change when it carries a derivation record, the account derives the key at that path again, and the script that key makes is the output's script.

The change also has to be where a restore of the account would find it, which is on the change chain below `nextChangeIndex` plus `gapLimit`. These default to 0 and 250, so pass the account's next change index. `receiveChainChange: true` accepts change on the receive chain as well.

When the check fails, it throws one of these:

| Code | Cause | Fix |
| --- | --- | --- |
| `PSBT_OUTPUT_UNEXPECTED` | An output is neither an expected recipient nor proven change, for example change swapped for someone else's address, whatever its record says | Refuse the PSBT, or if it is your own change without a record, build with `changeFrom` or call `account.prepareOutput` on outputs you add yourself |
| `PSBT_RECIPIENT_MISSING` | A payment in the order is missing or has a different amount | Refuse the PSBT |
| `FEE_TOO_HIGH` | The fee is above `maxFee` | Refuse the PSBT, or raise `maxFee` if the fee is intended |

The summary it returns is what to show the person approving. For a display of your own, `psbtOutputs(psbt, network, account)` gives the same proof output by output, as `mine` and `child`.

To read a PSBT's outputs without an account, use `psbtOutputs(psbt, network)`, which gives each output's Pearl address, script and value. The `Psbt` class's own `txOutputs[i].address` knows no Pearl network and prints an address with another chain's prefix.

## Input values

The offline machine takes the input values from the online machine. That is safe for these inputs, because a Taproot key-path signature commits to the value of every input, so a wrong value produces a signature the network rejects rather than one that pays a different fee than the signer approved.

## Next steps

- [Sign with a hardware or external signer](psbt-hardware.md) signs on a device, an HSM or a signing service.
- [Collect signatures from co-signers](psbt-co-signers.md) covers multisig leaves and leaves that need more than signatures.
- [PSBT checks and compatibility](../reference/psbt-checks.md) lists the sighash types a signer accepts, what parsing and finalizing check, and how the PSBTs work with Pearl's own tools.
