# Restart, back up and restore a wallet

A wallet kept in a file store survives restarts of the program, and two backups, one of its keys and one of its state, bring it back on another machine. The examples continue from [Create a wallet and receive](wallet-create.md).

## Open the wallet

`PearlWallet.open` reads a wallet back from its store:

<!-- check-docs: declare const backend: import('pearljs').WalletChain; -->
```ts fragment
import { PearlWallet } from 'pearljs';
import { createFileStore } from 'pearljs/store-file';

const wallet = await PearlWallet.open({ store: createFileStore('/var/lib/shop/wallet'), backend });
await wallet.sync(); // catches up on whatever happened while the program was down
await wallet.unlock(process.env.WALLET_PASSPHRASE ?? '', { timeout: 60_000 });
```

The store is opened without `create`, so a mistyped path fails instead of starting an empty wallet. `open` reads every record back and returns the wallet locked. Unlock it once after opening, even if the program only hands out addresses, because that is when the wallet checks its accounts and keys against the tag the keystore keeps over them, and until then nothing has checked them ([Security properties](../concepts/wallet.md#security-properties)). It can be locked again straight afterwards.

If `open` throws, the code says what to do:

| Code | Cause | What to do |
| --- | --- | --- |
| `WALLET_NOT_FOUND` | The store holds no wallet | Create or restore one in it |
| `WALLET_WRONG_NETWORK` | The store holds a wallet for another network than the backend's | Open it with a backend for its own network |
| `WALLET_SCHEMA` | A newer pearljs wrote the store | Upgrade pearljs |
| `WALLET_SCHEMA` | The store has an older schema version | Pass `migrate`, a function that `open` calls with the store before it reads anything |
| `STORE_LOCKED` | Another process, or another store in this one, has the store open | Close the other one, or see [Break a stale lock](#break-a-stale-lock) |

## Close the wallet

`wallet.close()` stops `watch`, locks the keystore and closes the store. It also closes a wallet whose store has failed, so the store always lets go of its lock.

The file store takes a lock file in its directory when it opens ([File store layout](../reference/wallet-storage.md#file-store-layout)) and holds it until `close`, touching it every couple of seconds to show that its holder is alive. While it is held, a second process, or a second store in the same process, can't open the store and gets `STORE_LOCKED`.

## Break a stale lock

A process that is killed leaves its lock behind, and the store won't open until the lock is dealt with. Rather than deleting the lock file by hand, let the store take it over:

```ts
import { createFileStore } from 'pearljs/store-file';

const store = createFileStore('/var/lib/shop/wallet', { breakStaleLock: true });
```

`breakStaleLock: true` takes over the lock only when all three of these hold:

- the lock was made on this host;
- its process isn't running;
- it hasn't been touched for `staleLockAfter` milliseconds, 10 seconds unless given.

All three are needed because a process id alone says nothing about a holder in another container, which looks gone from here while it keeps touching its lock. When pearljs can't tell, as with a lock made on another host, `breakLock: true` takes the lock whatever it says. Passing it is your statement that the holder is gone.

A store whose lock has been removed or taken over from under it writes nothing more and throws `STORE_LOCKED` on every later call. When it closes, a store removes the lock only if the lock is still its own.

## Back up

A wallet has two parts to back up, and they are best kept apart. The keystore is encrypted and holds the keys. The state isn't secret, and holds everything else: accounts, addresses, labels, transactions, locks and XMSS indices.

<!-- check-docs: declare const wallet: import('pearljs').PearlWallet; -->
```ts fragment
import { writeFileSync } from 'node:fs';

const keystore = wallet.exportKeystore();
const state = await wallet.exportState();
writeFileSync('keystore.json', JSON.stringify(keystore));
writeFileSync('state.json', JSON.stringify(state));
```

Back up the keystore when the wallet is created and again whenever its secrets change: after importing a key, adding an XMSS key or changing the passphrase. The state, a plain JSON object like the keystore, can be backed up as often as labels and history matter to the application. A watch-only wallet has no keystore, so `exportKeystore` throws `WALLET_WATCH_ONLY`.

A state backup is always older than the wallet's XMSS keys, because each signature moves a key's index on after the backup was made. [Restored and copied keys](wallet-xmss-keys.md#restored-and-copied-keys) explains what a restore does about that.

## Restore

`PearlWallet.restore` brings a wallet back into an empty store from the two backups:

<!-- check-docs: declare const backend: import('pearljs').WalletChain; -->
```ts fragment
import { readFileSync } from 'node:fs';
import { PearlWallet } from 'pearljs';
import { createFileStore } from 'pearljs/store-file';

const restored = await PearlWallet.restore({
  store: createFileStore('/var/lib/shop/wallet', { create: true }),
  backend,
  keystore: JSON.parse(readFileSync('keystore.json', 'utf8')),
  backup: JSON.parse(readFileSync('state.json', 'utf8')),
  passphrase: process.env.WALLET_PASSPHRASE ?? '',
});
await restored.sync();
```

`restore` checks everything before it writes anything. It reads the backup's records the way a wallet reads them, and the backup's accounts, imported addresses and XMSS keys must be the ones the keystore vouched for when the backup was made ([Security properties](../concepts/wallet.md#security-properties)). A backup that fails these checks throws `WALLET_BACKUP_INVALID` and leaves the store empty, so the same store can take a good backup afterwards. The store must be empty to begin with (`WALLET_EXISTS` otherwise), and the backup must be for the backend's network (`WALLET_WRONG_NETWORK`).

The restored wallet comes back unlocked, with the same `unlockTimeout` option as `create`, and every XMSS key comes back frozen until its indices are burned ([Hold XMSS keys in a wallet](wallet-xmss-keys.md#burn-indices)).

Without `backup`, `restore` starts from the keys alone: BIP86 account 0, or the account numbers given as `accounts`, together with the imported keys and the XMSS keys in the keystore. The first sync then scans the chain as far as the gap limit and finds the transactions again, so only the labels and the locks are lost.

The recovery phrase on its own restores the same accounts, without imported or XMSS keys: pass it as `mnemonic` to `PearlWallet.create` and sync.

## Store errors

The lock keeps a second process out, but it isn't what protects the file store from two writers. Every write is a new revision file, committed by an exclusive hard link, so of two writers that hold the same revision, exactly one writes the next, whatever has happened to the lock. The other gets `STORE_CONFLICT` having written nothing, and has to reopen the store.

`STORE_WRITE_FAILED` means a write couldn't reach the disk whole, for example because the disk is full. The stored state is as it was before, and the wallet operation that needed the write has failed. [Errors](../reference/errors.md#wallets-stores-and-keystores) lists the other store codes.

## Complete example

This program creates a wallet, receives a payment, backs the wallet up, and restores it into a new store. It runs on `SimulatedChain` from `pearljs/testing` with memory stores, so it needs no node:

```ts run
import { PearlWallet, createMemoryStore, formatPearl, parsePearl } from 'pearljs';
import { SimulatedChain } from 'pearljs/testing';

const chain = new SimulatedChain();
const passphrase = 'a long passphrase';
const store = createMemoryStore();
// N = 2^12 keeps the example quick; leave kdf out for the default, N = 2^18.
const wallet = await PearlWallet.create({ store, backend: chain, passphrase, kdf: { N: 2 ** 12 } });
chain.pay(await wallet.receiveAddress({ label: 'order 1041' }), parsePearl('12'));
chain.mine();
await wallet.sync();

const keystore = wallet.exportKeystore();
const state = await wallet.exportState();
wallet.lock();

// A restart: the same store, opened again.
const reopened = await PearlWallet.open({ store, backend: chain });
console.log('reopened, locked:', reopened.locked, 'balance', formatPearl(reopened.balance().confirmed), 'PRL');

// A new machine: an empty store and the two backups.
const restored = await PearlWallet.restore({ store: createMemoryStore(), backend: chain, keystore, backup: state, passphrase });
await restored.sync();
restored.lock();
console.log('restored', formatPearl(restored.balance().confirmed), 'PRL, labels', restored.addresses().map((a) => a.label));
```
