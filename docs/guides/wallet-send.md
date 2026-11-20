# Send from a wallet

Once a wallet holds confirmed coins, `send` pays from them in one call and keeps track of the coins and change for you. The wallet also handles a broadcast that fails and can raise the fee of a payment that is slow to confirm. The examples use the wallet from [Create a wallet and receive](wallet-create.md).

## Send a payment

Sending needs the wallet's keys, so unlock it first with its passphrase:

<!-- check-docs: declare const wallet: import('pearljs').PearlWallet; -->
```ts fragment
import { parsePearl } from 'pearljs';

await wallet.unlock(process.env.WALLET_PASSPHRASE ?? '', { timeout: 60_000 });
const sent = await wallet.send({
  recipients: [{ address: 'rprl1p8dhv8twyj9ezfvk62vvsfgw39s4dgl9t42y0549dc4d2947jj4cs30wfpz', amount: parsePearl('1.5') }],
  feeRate: 2000n, // grain/kvB; the backend's estimate if left out
  rbf: true,
  label: 'supplier invoice 88',
});
console.log(sent.txid, 'fee', sent.fee, 'change', sent.change, 'to', sent.changeAddress);
```

`unlock` keeps the wallet unlocked for `timeout` milliseconds, here one minute. `send` chooses coins the way Oyster, Pearl's own wallet, does and puts the change at the account's next change address. It signs with keys it decrypts from the keystore for this one call and checks the transaction against pearld's relay policy, then records the transaction and broadcasts it. The result has the `txid`, `fee`, `vsize` and `change` of the transaction, and `changeAddress`.

`rbf: true` marks the transaction as replaceable so that [its fee can be raised](#raise-the-fee) later, and `label` is a note kept with it in the history. By default a send spends coins of the first signing account that have at least one confirmation, and `minConfirmations: 0` lets it spend unconfirmed ones too. When the keys are on a device or a machine kept offline, sign through `prepareSend` instead ([Sign a wallet send elsewhere](wallet-sign-elsewhere.md)).

`send` refuses a transaction whose fee rate is above the fee ceiling, `maxFeeRate`, by throwing `FEE_TOO_HIGH` before anything is signed. The ceiling protects against a forgotten change output or a wrong estimate turning most of a payment into fee, and [Fee ceiling](../reference/payments-fees-and-coins.md#fee-ceiling) has its default and how to raise it.

The wallet stores the transaction before it broadcasts it, so its coins count as spent from the moment `send` reaches the network. Two sends can't choose the same coins, even when they are made at the same moment, because the operations that change a wallet run one at a time, in the order they were called.

## Handle a failed broadcast

When a broadcast fails, what the wallet does next depends on what the node's reply proves. If the node answers that it already has the transaction, the send stands and `send` returns normally. pearld says this as `already have transaction in mempool`, or as `transaction already exists` with code -27.

If the node refuses the transaction in a way that keeps it out of the mempool, `send` throws `WALLET_BROADCAST_REFUSED` with the node's error as its `cause`. Such a refusal is a rule rejection (code -26), an orphan (-25) or bytes the node can't decode (-22), and a failed policy check in the backend counts the same way. The wallet takes the transaction back out and its coins are free to spend again.

A refusal is final only from a backend that talks to a node of your own, `pearldBackend` or `oysterBackend`, which set `broadcastRefusalsFinal`. The server behind `blockbookBackend` or `filterBackend` can relay a transaction and still answer that it refused it, so from those backends the same reply becomes `WALLET_BROADCAST_UNCERTAIN`, described below. An application can therefore pay again after `WALLET_BROADCAST_REFUSED` without paying twice.

Anything else is `WALLET_BROADCAST_UNCERTAIN`: a dropped connection, an HTTP error, or an error code that proves nothing either way. The transaction may have reached the node, so it stays recorded with `broadcast: false` and its coins stay spent until you learn what happened:

<!-- check-docs: declare const wallet: import('pearljs').PearlWallet; declare const options: import('pearljs').SendOptions; -->
```ts fragment
import { WalletError } from 'pearljs';

try {
  await wallet.send(options);
} catch (err) {
  if (!(err instanceof WalletError) || err.code !== 'WALLET_BROADCAST_UNCERTAIN') throw err;
  await wallet.refresh();
  const { accepted, refused, failed } = await wallet.rebroadcast();
  console.log(accepted, refused, failed);
}
```

`refresh()` asks the backend whether it has the transaction. `rebroadcast()` sends every transaction still marked as not broadcast and returns them sorted into `{ accepted, refused, failed }`, and one the node already has counts as accepted without being sent again.

If a transaction will never confirm, `abandon(txid)` gives it up and frees its coins. It throws `WALLET_TRANSACTION_KNOWN` while the backend holds the transaction in its mempool or in a block, since the transaction can still confirm. Each sync and `refresh` asks the backend again about abandoned transactions whose coins nothing else has spent, and one that the backend shows again, in its mempool or a block, counts as active once more.

> [!WARNING]
> A transaction that reached some other node can still confirm after `abandon`. A new payment to the same recipient made with other coins may then pay twice. Spending the abandoned transaction's own coins in the new payment rules that out.

## Raise the fee

A payment sent with `rbf: true` can be replaced by one that pays a higher fee:

<!-- check-docs: declare const wallet: import('pearljs').PearlWallet; declare const sent: import('pearljs').SendResult; -->
```ts fragment
const faster = await wallet.bumpFee(sent.txid, { feeRate: 6000n });
console.log(faster.txid, 'replaces', faster.replaces);
```

`bumpFee` keeps the recipients and every original input, and takes the extra fee out of the change. It adds another confirmed input only when the change can't cover the fee, and it raises the fee further if pearld's [replacement rules](relay-policy-and-fee-bumping.md#replace-by-fee) require more. The original transaction becomes `replaced` in the history.

A recipient that was sent a fixed amount always receives that amount in the replacement. When the original had no change output, the extra fee comes from the recipient that was sent `'max'`, if there was one, or else from another confirmed coin, whose remainder becomes change. With no such coin the bump throws `WALLET_NOT_REPLACEABLE`. `bumpFee` is held to the same fee ceiling as `send`.

## Choose the coins

`from` sets which coins a send may spend:

- `{ account: '1' }` spends the coins of one account.
- `{ imported: address }` spends the coins of a key added with `importKey(wif)`.
- `{ xmss: id }` spends the coins of an XMSS key ([Hold XMSS keys in a wallet](wallet-xmss-keys.md)).
- `'all'` spends from any account or key in the wallet.

To keep a particular output out of every send, call `lockOutpoint(outpoint)`, either for good or `until` a given time. The lock is stored with the wallet, and locked outputs count under `locked` in the balance.

## Sweep a key

`sweep({ wif })` moves everything held by a key from outside the wallet, such as a paper wallet, to a new receive address, using the key for that one sweep without storing it.

## Estimate a send

`estimateSend(options, feeRates)` works out what the same send would cost at each of several fee rates, which suits a fee slider in a UI:

<!-- check-docs: declare const wallet: import('pearljs').PearlWallet; declare const options: import('pearljs').SendOptions; -->
```ts fragment
for (const { feeRate, fee, vsize, error } of wallet.estimateSend(options, [1000n, 2000n, 5000n])) {
  console.log(feeRate, fee ?? error?.message, vsize);
}
```

Each answer is `{ feeRate, fee, vsize, inputs, change, error }`, and `fee` is null with `error` set when the send can't be built at that rate. The estimate is worked out from the wallet's state in memory, so it makes no request and holds no coins, and it is cheap enough to run on every move of the slider.

## Insufficient funds

When the coins can't cover a send, `send` throws a `WalletInsufficientFundsError`, a kind of `InsufficientFundsError`. Besides `missing`, it says in grain how much the source holds that it couldn't spend, and why:

- `locked` is held by `lockOutpoint` or by a prepared send.
- `immature` is coinbase outputs that are not yet mature.
- `unconfirmed` has fewer confirmations than `minConfirmations`.
- `frozen` belongs to an XMSS key that is waiting for `burnXmssIndices`.

## Complete example

This program funds a wallet, sends from it with `rbf: true` and then raises the fee. It runs on `SimulatedChain` from `pearljs/testing`, which accepts and replaces transactions by pearld's mempool rules, so it needs no node:

```ts run
import { PearlWallet, createMemoryStore, formatPearl, parsePearl } from 'pearljs';
import { SimulatedChain, testAddress } from 'pearljs/testing';

const chain = new SimulatedChain();
const passphrase = 'a long passphrase';
// N = 2^12 keeps the example quick; leave kdf out for the default, N = 2^18.
const wallet = await PearlWallet.create({ store: createMemoryStore(), backend: chain, passphrase, kdf: { N: 2 ** 12 }, unlockTimeout: 0 });

chain.pay(await wallet.receiveAddress(), parsePearl('12'));
chain.mine();
await wallet.sync();

await wallet.unlock(passphrase, { timeout: 60_000 });
const sent = await wallet.send({
  recipients: [{ address: testAddress(1), amount: parsePearl('5') }],
  feeRate: 2000n, // grain/kvB
  rbf: true,
  label: 'supplier invoice 88',
});
console.log('sent', sent.txid, 'fee', formatPearl(sent.fee), 'PRL');

const faster = await wallet.bumpFee(sent.txid, { feeRate: 6000n });
console.log('replaced by', faster.txid, 'fee', formatPearl(faster.fee), 'PRL');
wallet.lock();

chain.mine();
await wallet.sync();
for (const entry of wallet.history()) console.log(entry.status, entry.direction, formatPearl(entry.amount), 'PRL');
```

## Next steps

- [Sign a wallet send elsewhere](wallet-sign-elsewhere.md) signs a send on a device or an offline machine.
- [Relay policy and fee bumping](relay-policy-and-fee-bumping.md) covers replacement and child-pays-for-parent in detail.
- [Troubleshooting](../reference/troubleshooting.md#wallets-and-stores) lists the wallet's error messages.
