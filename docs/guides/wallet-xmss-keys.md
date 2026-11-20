# Hold XMSS keys in a wallet

XMSS keys are Pearl's post-quantum keys, and a `PearlWallet` can hold them alongside its ordinary accounts. Read [XMSS](../concepts/xmss.md) first: an XMSS key signs at most 31 times and must never sign twice at the same index, and the wallet's handling of these keys follows from that.

## Add a key and spend from it

`addXmssKey` generates a key, stores it, and returns its address. Spending from it is an ordinary `send` with `from: { xmss: id }`:

<!-- check-docs: declare const wallet: import('pearljs').PearlWallet; -->
```ts fragment
const key = await wallet.addXmssKey({ label: 'vault' });
console.log('pay to', key.address, key.remaining, 'signatures left');

// Later, once the key has been paid and the payment has confirmed:
await wallet.send({ recipients: [{ address: 'rprl1p8dhv8twyj9ezfvk62vvsfgw39s4dgl9t42y0549dc4d2947jj4cs30wfpz', amount: 'max' }], from: { xmss: key.id } });
```

The key's address is a P2MR address whose only leaf is the key. Its seeds go into the encrypted keystore and its next index into the wallet's store, so both calls need the wallet unlocked, and generating the key takes about a second. Back up the keystore again after adding one ([Back up](wallet-restart-and-backup.md#back-up)), since the seeds aren't derived from the recovery phrase and the keystore is the only copy of them.

Only the wallet's own `send` spends an XMSS key's coins. `prepareSend` and a send through a `signer` leave them out, because the wallet has to reserve the index before anything signs ([Sign a wallet send elsewhere](wallet-sign-elsewhere.md)). Change from an XMSS spend goes to the account rather than back to the XMSS address. When every input of the spending transaction is a P2MR output, the signers look up each input in the previous transactions and check that the output it points at has the script and value given, before anything is signed. The wallet supplies those previous transactions from its own records.

## Check the keys

`xmssKeys()` returns every XMSS key in the wallet:

<!-- check-docs: declare const wallet: import('pearljs').PearlWallet; -->
```ts fragment
wallet.on('xmss', ({ id, reason, remaining }) => console.log(id, reason, remaining));
for (const key of wallet.xmssKeys()) {
  console.log(key.label, key.nextIndex, key.remaining, key.highestOnChain, key.frozen, key.birthHeight);
}
```

`nextIndex` is the index the next signature will take and `remaining` how many signatures are left. `highestOnChain` is the highest index the wallet has seen in a signature on chain, or -1. `frozen` says why the key refuses to sign, or is null. `birthHeight` is the lowest height that can hold a payment to the key, and the wallet passes it to a backend that scans blocks so that the key's address is scanned from there ([XMSS](../concepts/xmss.md)).

An `xmss` event with reason `low` fires when a key has three or fewer signatures left, which is the time to move its coins to a new key. One with reason `behind` fires when a key freezes, as described below.

## Index reservation

Before each signature, the wallet writes the key's next index with the store's `compareAndSet`, a write that applies only if the store still holds the record this wallet last wrote. It waits for that write to be durable, and only then makes the signature.

The store makes that check and write as one step against every other writer, so two wallets on one store, in one process or two, with or without a lock, can't both be given the same index. The second gets `XMSS_INDEX_REUSE` and signs nothing. Every other write of an XMSS record is conditional in the same way, so a second writer can't move an index back either. A crash can waste an index, but never repeats one.

## Restored and copied keys

A backup of the wallet's state ([Back up](wallet-restart-and-backup.md#back-up)) is always older than its XMSS keys, and a key resumed from it would sign again at indices it has already used ([XMSS](../concepts/xmss.md)). A copy of the store's files and a disk or virtual machine snapshot have the same problem. The wallet treats every such case as an error that someone has to resolve, in two ways.

First, every XMSS key comes out of `restore` frozen, with `frozen: 'restored'`, and throws `XMSS_KEY_RESTORED` when asked to sign until `burnXmssIndices` moves it forward.

Second, the wallet reads the index out of every XMSS signature that spends its outputs, both in the transactions the backend shows it and in its own sends when they confirm. A verified index at or past the stored next index means the state is older than the key. The key then freezes with `frozen: 'behind'`, signing throws `XMSS_KEY_BEHIND`, and an `xmss` event with reason `behind` fires, which is how the wallet catches a copied store.

The wallet believes an index only after running the input through the script engine against its own record of what the input spends. A signature that verifies under the key proves the index was used, whether or not it is in a block. A witness that merely has the shape of one is ignored, as is any index above 30, and a signature in a transaction whose other inputs the wallet can't look up can't be verified and doesn't count.

## Burn indices

`burnXmssIndices(id, { nextIndex })` moves a frozen key forward past the indices it may have used, and unfreezes it. After a restore, sync first, so that the wallet knows which signatures of the key the chain holds:

<!-- check-docs: declare const wallet: import('pearljs').PearlWallet; -->
```ts fragment
await wallet.sync();
for (const key of wallet.xmssKeys().filter((k) => k.frozen !== null)) {
  const margin = 2; // for spends that may have been signed and never broadcast
  await wallet.burnXmssIndices(key.id, { nextIndex: Math.max(key.nextIndex, key.highestOnChain + 1) + margin });
}
```

Choose an index past every signature the key may have made since the backup. That includes signatures that were made and never broadcast, which the chain can't show, so go past `highestOnChain` and add a margin for spends that may have been signed and dropped. Burning too many costs some of the key's 31 signatures, while burning too few can cost its funds.

`burnXmssIndices` only moves forward. It throws `XMSS_INDEX_REUSE` for an index below the key's next index or at or below one seen in a signature, and `XMSS_KEY_RESTORED` when a restored wallet hasn't finished a sync yet.

An index equal to the one the key already stands at burns nothing, and is refused unless you pass `nothingSigned: true`. Pass it only when the key has made no signature beyond those this wallet knows of. It is the only way to unfreeze a restored key that really hasn't signed since its backup without giving up an index.

## Import a key with seeds

A key that already exists can be added from its seeds with `addXmssKey({ privateSeed, publicSeed, nextIndex })`. The wallet can't learn which indices such a key has used, so `nextIndex`, the first index it has never signed with, is required, and leaving it out throws `XMSS_KEY_INVALID`.

The wallet checks the key at once against the signatures in the transactions it has already recorded, and its next sync asks for the whole history of the key's address. A signature on chain at or past `nextIndex` therefore freezes the key as `behind` before it can sign. Pass `birthHeight`, the lowest height that can hold a payment to the key, if it is known, so a backend that scans blocks can start there. A height above a real payment hides that payment.

## Complete example

This program adds an XMSS key to a wallet, spends from it, then restores the wallet from its backups and burns the restored key's indices. It runs on `SimulatedChain` from `pearljs/testing`, so it needs no node:

```ts run
import { PearlWallet, createMemoryStore, formatPearl, parsePearl } from 'pearljs';
import { SimulatedChain, testAddress } from 'pearljs/testing';

const chain = new SimulatedChain();
const passphrase = 'a long passphrase';
// N = 2^12 keeps the example quick; leave kdf out for the default, N = 2^18.
const wallet = await PearlWallet.create({ store: createMemoryStore(), backend: chain, passphrase, kdf: { N: 2 ** 12 } });
await wallet.sync();

const key = await wallet.addXmssKey({ label: 'vault' });
const backup = await wallet.exportState(); // taken before the key signs
chain.pay(key.address, parsePearl('10'));
chain.mine();
await wallet.sync();

const sent = await wallet.send({ recipients: [{ address: testAddress(1), amount: parsePearl('4') }], from: { xmss: key.id } });
console.log('spent from the key, fee', formatPearl(sent.fee), 'PRL');
chain.mine();
await wallet.sync();
console.log('signatures left', wallet.xmssKeys()[0]!.remaining);

// Restore from the keystore and the older state backup.
const restored = await PearlWallet.restore({ store: createMemoryStore(), backend: chain, keystore: wallet.exportKeystore(), backup, passphrase });
await restored.sync();
const frozen = restored.xmssKeys()[0]!;
console.log('restored key', frozen.frozen, 'next', frozen.nextIndex, 'seen on chain', frozen.highestOnChain);
const burned = await restored.burnXmssIndices(frozen.id, { nextIndex: Math.max(frozen.nextIndex, frozen.highestOnChain + 1) + 2 });
console.log('after burning, next', burned.nextIndex, 'frozen', burned.frozen);
restored.lock();
wallet.lock();
```
