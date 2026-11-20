# Prepared send reference

## Inputs and coins

`previousTransactions` holds the transactions that the inputs spend. When every input of the spending transaction is a P2MR output, the signers look up each input in the previous transactions and check that the output it points at has the script and value given, before anything is signed; `trustPrevouts` skips the check for a caller that has already verified the values.

Each input that spends an account's coin carries its internal key and its derivation, under the account's origin when the wallet knows it. The change output carries the same for the change address, so a signer that holds the account can prove the change is its own rather than trust an address it is shown. For a watch-only wallet, the origin is the `watchOnlyOrigin` it was created with ([Create a watch-only wallet](../guides/wallet-create.md#create-a-watch-only-wallet)).

A prepared send spends account coins only. An XMSS key has to have its index reserved inside the wallet before anything signs with it, and imported keys sign from the keystore, so `from: { xmss }` or `from: { imported }` throws `WALLET_WATCH_ONLY` and `from: 'all'` leaves those coins out.

## Refusals

A signed transaction the wallet won't take comes back as one of these errors:

| Code | Cause | What to do |
| --- | --- | --- |
| `WALLET_NOT_PREPARED` | The transaction isn't one the wallet prepared and still holds, or a coin it spends is no longer the wallet's to spend | Prepare the send again and sign the new PSBT |
| `SIGNATURES_MISSING` | An input carries no witness | Have the signer sign every input |
| `SIGNATURE_INVALID` | The script engine refuses a witness for the output it spends | Have the signer sign that input again with the key that owns it |
| `XMSS_INDEX_REUSE` | An XMSS signature of one of the wallet's keys uses an index the wallet has already handed out | Nothing is recorded or sent; see [Hold XMSS keys in a wallet](../guides/wallet-xmss-keys.md) |

When `submitSigned` accepts an XMSS signature of one of the wallet's own keys, it first stores that key's next index past the one used, before doing anything else. [Errors](errors.md#wallets-stores-and-keystores) lists the remaining codes, including those of the relay policy and the fee ceiling.

## Holds

From `prepareSend` until the signed transaction comes back, the wallet holds the coins it chose and the change address, so other sends and other prepared sends take different coins and a different change address. The hold lasts for `hold` milliseconds, ten minutes (`DEFAULT_PREPARE_HOLD_MS`) unless given. It is stored with the wallet, so it lasts across a restart, and the held coins count under `locked` in the balance. `preparedSends()` lists the holds, each with its `id`, `txid`, inputs and `expiresAt`.

A hold ends in one of three ways:

- `submitSigned(transaction)` ends it by sending.
- `cancelPrepared(id)` ends it by letting the coins go. Once the backend holds the signed transaction, the send can no longer be called off, so `cancelPrepared` throws `WALLET_TRANSACTION_KNOWN`.
- The hold runs out, which also lets the coins go. A signer can still broadcast what it signed after that, and the next sync then records the transaction.

`hold: 0` holds nothing and returns a preview, with `id` and `expiresAt` null, that can't be submitted. To see which change address the next send would use without taking it, call `peekChangeAddress()`.

## Signing in the same process

A signer that the application can call directly, such as a device behind a transport or a signing service, doesn't need a PSBT carried by hand. `send({ ..., signer })` and `bumpFee(txid, { feeRate, signer })` take a `KeyPathSignerAsync` and ask it for the signature of each account input in place of the keystore ([Keys, mnemonics and accounts](../guides/keys-and-accounts.md#keep-the-phrase-away-from-a-server)):

<!-- check-docs: declare const wallet: import('pearljs').PearlWallet; declare const signer: import('pearljs').KeyPathSignerAsync; -->
```ts fragment
import { parsePearl } from 'pearljs';

const sent = await wallet.send({
  recipients: [{ address: 'rprl1p8dhv8twyj9ezfvk62vvsfgw39s4dgl9t42y0549dc4d2947jj4cs30wfpz', amount: parsePearl('1.5') }],
  signer,
});
console.log(sent.txid);
```

Such a send needs no unlocked keystore and can spend a watch-only account's coins. Like a prepared send, it spends account coins only, and the wallet checks every signature against the output it spends before it records the transaction. `signingAccount.keyPathSigner()` is a signer of this kind for an account held in memory, which is what a signing service puts behind its transport ([Sign with a hardware or external signer](../guides/psbt-hardware.md)).

## Complete example

This program runs a watch-only wallet on a server and keeps the phrase on a separate signer. It runs on `SimulatedChain` from `pearljs/testing`, so it needs no node:

```ts run
import {
  PearlWallet,
  checkPsbtPayment,
  createMemoryStore,
  deriveSigningAccountFromSeed,
  finalizePsbt,
  formatPearl,
  mnemonicToSeed,
  parsePearl,
  parsePsbt,
  serializeTransaction,
} from 'pearljs';
import { SimulatedChain, testAddress } from 'pearljs/testing';

const chain = new SimulatedChain();
const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

// On the signer: export the account key and its origin once.
const account = deriveSigningAccountFromSeed(mnemonicToSeed(phrase), chain.network);
const exported = account.watchOnlyAccount();

// On the server: a watch-only wallet that receives a payment.
const wallet = await PearlWallet.create({
  store: createMemoryStore(),
  backend: chain,
  watchOnly: exported.extendedPublicKey(),
  watchOnlyOrigin: { masterFingerprint: exported.masterFingerprint!, path: exported.path! },
});
chain.pay(await wallet.receiveAddress(), parsePearl('12'));
chain.mine();
await wallet.sync();

const recipients = [{ address: testAddress(1), amount: parsePearl('5') }];
const prepared = await wallet.prepareSend({ recipients, feeRate: 2000n });
console.log('prepared, fee', formatPearl(prepared.fee), 'PRL; locked', formatPearl(wallet.balance().locked), 'PRL');

// On the signer: check where the coins go, then sign.
const psbt = parsePsbt(prepared.psbt);
checkPsbtPayment(psbt, exported, { network: chain.network, recipients, maxFee: parsePearl('0.001') });
for (let i = 0; i < psbt.inputCount; i += 1) account.signInput(psbt, i);
const signedHex = serializeTransaction(finalizePsbt(psbt));
account.destroy();

// Back on the server.
const sent = await wallet.submitSigned(signedHex);
console.log('sent', sent.txid);
chain.mine();
await wallet.sync();
console.log('confirmed', formatPearl(wallet.balance().confirmed), 'PRL');
```
