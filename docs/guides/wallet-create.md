# Create a wallet and receive

A `PearlWallet` suits an application that keeps its own coins, such as a shop or a service that takes deposits. Kept encrypted in a file and reading the chain from a pearld node, it can give out an address and read the payment that arrives at it.

## Prerequisites

- A pearld node with either its address index (`--addrindex`) or its compact filter index. [Choosing a backend](../start/choosing-a-backend.md) compares the two.
- Node.js, because the wallet below is kept in a file. A browser wallet uses the IndexedDB store instead ([Wallet storage](../reference/wallet-storage.md#stores)).

## Connect to the node

A wallet reads the chain through a backend, and it needs one that can also hand it full transactions. `connectPearld` checks which index the node keeps and returns the backend that matches, `pearldBackend` for the address index or `filterBackend` for the filter index:

```ts
import { PEARLD_RPC_PORTS, PearlWallet, PearlWsClient, connectPearld, networks } from 'pearljs';
import { createFileStore } from 'pearljs/store-file';

const network = networks.regtest;
const node = new PearlWsClient({
  url: `wss://127.0.0.1:${PEARLD_RPC_PORTS.regtest}/ws`,
  username: process.env.PEARLD_RPC_USER ?? '',
  password: process.env.PEARLD_RPC_PASS ?? '',
});
const connection = {
  store: createFileStore('/var/lib/shop/wallet', { create: true }),
  // birthday: the height to scan from when the node has no address index; 0 for a wallet with history from the start.
  backend: await connectPearld(node, { network, birthday: 0 }),
};
```

The node is a `PearlWsClient`, pearld's websocket connection, so the same client can later tell the wallet about new blocks and transactions as they happen. `createFileStore` keeps the wallet in a directory, and `create: true` starts a new store there and refuses one that already exists.

## Create the wallet

`PearlWallet.create` makes the keys, encrypts them under a passphrase and writes everything to the store:

```ts continues
const wallet = await PearlWallet.create({ ...connection, passphrase: process.env.WALLET_PASSPHRASE ?? '' });
console.log('write these words down:', await wallet.mnemonic());
wallet.lock();
```

`create` generates a new 24-word recovery phrase, keeps the phrase and its seed in the encrypted keystore, and adds the first BIP86 account, account 0. To create the wallet from a phrase that already exists, pass it as `mnemonic`, along with `bip39Passphrase` if it has one, or pass a raw `seed`, and give `create` an empty store in either case.

The wallet comes back unlocked so that the phrase can be read and written down, and it locks itself after five minutes (`DEFAULT_CREATE_UNLOCK_MS`). Call `lock()` as soon as the phrase is saved, as above, so the keys don't stay in memory any longer than needed. `unlockTimeout` sets a different period in milliseconds; `0` returns the wallet already locked, and `null` keeps it unlocked until `lock()`, and `restore` takes the same option.

`gapLimit` is how many unused addresses in a row a restore scans before it stops. It defaults to 250, the recovery window of Oyster, Pearl's own wallet. The wallet never hands out more unused receive addresses in a row than that, so a restore always finds every payment.

## Hand out an address

Give each payment its own address by calling `receiveAddress`, which hands out the next unused one and records it with an optional label:

<!-- check-docs: declare const wallet: import('pearljs').PearlWallet; -->
```ts fragment
const address = await wallet.receiveAddress({ label: 'order 1041' });
console.log('pay to', address);
```

Every call returns a new address, so for a page that shows a standing deposit address use `currentAddress`, which returns the last address handed out until something pays it. `addresses()` lists the addresses handed out, with their labels and whether each has been used, and `setLabel` changes a label.

## Receive the payment

`sync` asks the backend what has touched the wallet's addresses and records it. The wallet emits events as it records each change, so an application can react to a payment without polling its balance:

<!-- check-docs: declare const wallet: import('pearljs').PearlWallet; -->
```ts fragment
import { formatPearl } from 'pearljs';

wallet.on('transaction', (entry) => console.log(entry.direction, formatPearl(entry.amount), entry.txid));
wallet.on('confirmation', ({ txid, block }) => console.log(txid, 'confirmed at', block.height));
wallet.on('balance', (balance) => console.log('spendable', formatPearl(balance.confirmed)));

await wallet.sync();
```

A payment shows up first as a `transaction` event while it waits in the mempool, and then as a `confirmation` event once a block includes it. [Keep a wallet in sync](wallet-sync.md) keeps the wallet up to date with `watch`, which syncs again on every block and on each payment the node reports.

## Read the balance and history

`balance()` and `history()` read what the wallet has already recorded, so they return at once without asking the backend:

<!-- check-docs: declare const wallet: import('pearljs').PearlWallet; -->
```ts fragment
import { formatPearl } from 'pearljs';

const { confirmed, unconfirmed, immature, locked } = wallet.balance();
console.log(formatPearl(confirmed), formatPearl(unconfirmed), formatPearl(immature), formatPearl(locked));
for (const entry of wallet.history()) console.log(entry.status, entry.amount, entry.fee, entry.counterparties, entry.label);
```

The balance splits the wallet's unspent outputs into four parts that never overlap, and `total` is their sum:

- `confirmed` is what a send can spend.
- `unconfirmed` is still in the mempool, including the change from the wallet's own sends.
- `immature` is coinbase outputs that have fewer than 100 confirmations.
- `locked` is outputs kept out of sends with `lockOutpoint` ([Send from a wallet](wallet-send.md#choose-the-coins)).

`history({ account, address, offset, limit })` returns a page of transactions, newest first. With no filter it covers every transaction, and with `account` or `address` it covers the ones that pay to or spend from that account or address of the wallet. `historyCount({ account, address })` gives the total for the same filter, and `transaction(txid)` returns one entry together with its raw transaction.

Each history entry says what one transaction did for the wallet:

- `direction` is `incoming`, `outgoing`, or `self` when every output belongs to the wallet.
- `received` and `sent` are the amounts in and out, and `amount` is the net of the two.
- `fee` is set when the value of every input is known, which for most incoming payments it isn't.
- `counterparties` lists the addresses paid, or the addresses that paid the wallet.
- `addresses` lists the wallet's own addresses that the transaction pays or spends from.
- `status` is one of the statuses listed under [Stored records](../reference/wallet-storage.md#stored-records).

## Show the wallet in a UI

`wallet.getSnapshot()` returns the state a screen needs, `{ version, tip, balance, locked, watchOnly, syncing, transactions, pending }`, as one frozen object. It stays the same object until something changes, and `wallet.subscribe(listener)` calls the listener after every change, including a lock by timeout and the start and end of a sync. Together they are the pair that a framework's external store hook expects, such as React's `useSyncExternalStore`, and `wallet.version` counts the changes.

## Save amounts as JSON

Amounts are `bigint`, which `JSON.stringify` can't write. `balanceToJson`, `coinToJson` and `historyEntryToJson` write every amount as a decimal string of grain and every script as hex, and `balanceFromJson`, `coinFromJson` and `historyEntryFromJson` read them back. The readers throw `AMOUNT_INVALID` for an amount that isn't such a string.

## Create a watch-only wallet

A server that should hold no keys can watch an account by its extended public key. Pass `watchOnly: xpub` to `create` and leave out the passphrase. The wallet then follows the account's payments and balance in the same way, and its sends are signed somewhere else ([Sign a wallet send elsewhere](wallet-sign-elsewhere.md)).

When a hardware device or another wallet holds the key, also pass `watchOnlyOrigin: { masterFingerprint, path }`, so that the PSBTs the wallet prepares name the key the way that signer knows it. `addWatchOnlyAccount(xpub, { origin })` adds a further watch-only account with the same information.

## Complete example

This program creates a wallet, receives a payment and reads it back. It runs on `SimulatedChain` from `pearljs/testing`, a chain held in memory, with the wallet in a memory store, so it needs no node:

```ts run
import { PearlWallet, createMemoryStore, formatPearl, parsePearl } from 'pearljs';
import { SimulatedChain } from 'pearljs/testing';

const chain = new SimulatedChain();
// N = 2^12 keeps the example quick; leave kdf out for the default, N = 2^18.
const wallet = await PearlWallet.create({ store: createMemoryStore(), backend: chain, passphrase: 'a long passphrase', kdf: { N: 2 ** 12 } });
console.log('recovery phrase has', (await wallet.mnemonic())!.split(' ').length, 'words');
wallet.lock();

const address = await wallet.receiveAddress({ label: 'order 1041' });
chain.pay(address, parsePearl('12'));
await wallet.sync();
console.log('unconfirmed', formatPearl(wallet.balance().unconfirmed), 'PRL');

chain.mine();
await wallet.sync();
console.log('confirmed', formatPearl(wallet.balance().confirmed), 'PRL');
for (const entry of wallet.history()) console.log(entry.status, entry.direction, formatPearl(entry.amount), 'PRL');
```

## Next steps

- [Keep a wallet in sync](wallet-sync.md)
- [Send from a wallet](wallet-send.md)
- [Restart, back up and restore a wallet](wallet-restart-and-backup.md)
