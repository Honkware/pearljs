# Wallets

A `PearlWallet` is an object that keeps an application's coins in order from one run to the next. It holds the keys encrypted under a passphrase, remembers the addresses it has handed out and every transaction that touches them, and works out the balance and history from those records. It keeps those records right as the chain moves on, as blocks are replaced and as transactions confirm or fall away.

Functions such as `discoverAccount` and `payFromAccount` start from whatever they are given on each call and remember nothing afterwards. A wallet suits an application that holds its own coins for months, such as a shop or a service that takes deposits, because it carries that state for you.

Start with [Create a wallet and receive](../guides/wallet-create.md). The other tasks have their own pages:

- [Keep a wallet in sync](../guides/wallet-sync.md)
- [Send from a wallet](../guides/wallet-send.md)
- [Sign a wallet send elsewhere](../guides/wallet-sign-elsewhere.md)
- [Restart, back up and restore a wallet](../guides/wallet-restart-and-backup.md)
- [Hold XMSS keys in a wallet](../guides/wallet-xmss-keys.md)

[examples/wallet-lifecycle.ts](../../examples/wallet-lifecycle.ts) creates a wallet on a simulated chain, funds it, spends from it, restarts it and restores it. [examples/wallet-node.ts](../../examples/wallet-node.ts) keeps a wallet in a file and syncs it with a pearld node.

## Parts

A wallet is put together from three parts, and any one of them can be swapped without changing the other two:

| Part | What it is | Choices |
| --- | --- | --- |
| Store | A `WalletStore`, where the wallet keeps its records: addresses and labels, transactions, locked outputs, prepared sends and the index state of XMSS keys | memory, a directory of files, IndexedDB, or a store of your own ([Wallet storage](../reference/wallet-storage.md)) |
| Keystore | The encrypted record inside the store that holds the recovery phrase, the seed, imported keys and XMSS seeds | absent in a watch-only wallet |
| Backend | A `WalletBackend`, which reads the chain and broadcasts transactions | pearld, compact filters, Blockbook or Oyster ([Choosing a backend](../start/choosing-a-backend.md)) |

The store holds transactions, and the wallet works out coins, balances and history from them each time they are asked for rather than storing those too. The three views therefore always agree with the recorded transactions, and keeping the wallet right comes down to keeping that set of transactions right.

## Sync steps

Syncing is how the wallet keeps its transactions in step with the chain. A sync asks the backend what has happened to the wallet's addresses since it last asked, and then updates the records to match. It runs five steps in order:

1. Check that the blocks it recorded are still in the chain.
2. Ask about the wallet's addresses.
3. Fetch the transactions it hasn't seen.
4. Find out what spent the outputs it holds.
5. Settle the transactions that are still pending.

The wallet reports what changed through events, so an application can follow a sync without comparing balances before and after:

<!-- check-docs: declare const wallet: import('pearljs').PearlWallet; -->
```ts fragment
wallet.on('reorg', ({ forkHeight }) => console.log('blocks from height', forkHeight, 'left the chain'));
wallet.on('conflict', ({ txid, status }) => console.log(txid, 'is now', status));
await wallet.sync();
```

### Check the recorded blocks

A reorganization, or reorg, is the chain replacing some of its latest blocks with others. A transaction the wallet recorded in a replaced block may end up in a different block or in none, so the first step makes sure every recorded block still stands.

The wallet reads the tip, and when it has moved since the last sync, looks up its recorded blocks from the highest down. It checks every transaction within `reorgDepth` blocks (`DEFAULT_REORG_DEPTH`, 100) of the tip it last synced to, and below that keeps going until it reaches a block whose transactions are still placed in it. A block's hash commits to every block below it, so a block that still stands vouches for all the blocks beneath it. The check therefore finds a reorg at any depth, however many blocks were mined while the wallet wasn't running, and a quiet wallet pays a single lookup for it.

When a block no longer stands, the wallet rolls back to the lowest such height, and the transactions from there up go back to pending. Coinbase transactions become `orphaned` instead, because they can't exist outside their block, and a `reorg` event gives the height the rollback started from. A transaction that the backend no longer knows never stays confirmed.

### Ask about the addresses

An account hands out addresses from two chains, one for receiving and one for change. On each, the wallet asks about up to `lookahead` addresses (`DEFAULT_LOOKAHEAD`, 20) past the last one used. The first sync, and `sync({ full: true })`, go `gapLimit` addresses past it instead, and [Sync cost](#sync-cost) says how many questions that makes.

Another copy of the same seed can hand out addresses this wallet never did. When one of those is paid, the wallet moves the account's next index past it. A scan that runs 10,000 addresses (`DEFAULT_SCAN_LIMIT`) past the next index without reaching the end of the gap stops with `BACKEND_RESPONSE`, because the wallet takes that as a backend answering wrongly. For an account that really has that many used addresses, pass a larger `sync({ scanLimit })`.

### Fetch transactions and spends

The wallet fetches every transaction it hasn't seen and records the ones that pay it or spend from it, together with the scripts and values of their inputs. Then, for each output it holds that the backend no longer lists, it asks the backend what spent that output and records the spending transaction.

### Settle pending transactions

A transaction that isn't in a block yet is pending, and the last step decides where each one stands. It can be in one of four conditions:

| Condition | What the wallet records |
| --- | --- |
| A block now holds it | confirmed |
| The backend still has it in its mempool | still pending |
| Another transaction spends one of its inputs | `conflicted` |
| The backend has lost it | `missing` |

The last two need care, because a send that may still confirm must never look as if it failed. A lost transaction becomes `conflicted` only on proof, which comes in three parts: the backend names the transaction that spent one of its inputs, the wallet fetches that transaction and checks that it hashes to that txid and spends that input, and the backend places it in a block. Until all three hold, the lost transaction stays pending with `missing: true`, and its coins stay taken. If you know such a transaction will never confirm, `abandon` gives it up ([Send from a wallet](../guides/wallet-send.md#handle-a-failed-broadcast)).

A coin that the backend reports spent stays out of the balance.

## Statuses

A recorded transaction's status says whether it still counts toward the balance and history. [Stored records](../reference/wallet-storage.md#stored-records) lists the statuses, and two rules decide between them.

The first rule is that statuses follow spend chains. A transaction that spends an output of a conflicted, replaced, abandoned or orphaned transaction is conflicted too, in the same way that Oyster's transaction store removes a whole spend chain.

The second rule settles two transactions that spend the same output. The one the backend reports in a block wins over the recorded one, whatever the wallet thought of either before, and even when the recorded one was in a block too.

## Concurrency

A sync makes its network calls without holding up the wallet's other operations, which matters most for a long first scan. It works on a copy of the state in memory and remembers every answer the backend gives. When it is done, it applies its result to the real state as one operation that ends in one atomic write, and at that point asks the backend again only about what changed in the meantime, such as a send made during the sync. A `send` made during a long first scan therefore goes out at once, and the sync that finishes after it counts it. Neither a sync nor a refresh reads the store.

## Sync cost

How many questions a sync asks the backend depends on what the backend can answer, and there are two kinds.

Some backends can answer for many addresses at once. They implement the `ActivityScanner` interface, whose `getActivitySince(addresses, block)` returns every transaction touching those addresses in blocks after `block` and in the mempool, or `null` when the backend can't answer from that block. A sync asks such a backend one question, starting from the tip it last synced to, and fetches only what comes back. `filterBackend` and `blockbookBackend` work this way.

Even then, some addresses need their whole history asked for one at a time, because nothing is known about them yet. These are the addresses a payment brings into the lookahead window, and those of accounts and keys added since the last sync. An XMSS key added with its seeds is also checked against the transactions the wallet has already recorded, so that a signature of that key already on chain freezes it.

Every other backend is asked address by address, with one history query for each address. How many addresses a sync covers depends on which sync it is:

| Sync | Addresses asked about |
| --- | --- |
| The first after the wallet is opened, and `sync({ full: true })` | every address |
| Every other sync | each address that has never been paid, holds a coin or has a pending transaction, and each address within `lookahead` of the next index |
| Every `quietSyncInterval`-th sync | also the addresses that were paid and then emptied |

`quietSyncInterval` is `DEFAULT_QUIET_SYNC_INTERVAL`, 10, unless the wallet was opened with another value, and 1 asks about every emptied address every time. A payment to an emptied address is therefore found within that many syncs, or at once by `sync({ full: true })` or a notifier that reports it. Spends of the wallet's coins are found by every sync, whatever the address.

## Security properties

[Security model](security.md) summarizes a wallet's security properties alongside the rest of pearljs.

### At rest

The keystore is as strong as its passphrase against scrypt, run at the cost stored with the keystore ([Scrypt cost](../reference/wallet-storage.md#scrypt-cost)). The rest of the state, meaning addresses, labels, history and XMSS indices, is stored in the clear. Anyone who reads the store learns what the wallet owns and what it has done, but can't spend from it.

The wallet detects any change to a ciphertext, nonce, salt or parameter, and also a secret removed from or added to the keystore.

### Unlocked

While the wallet is unlocked, it holds the data key as a non-extractable WebCrypto key, whose bytes stay inside the platform's crypto implementation. Each secret is decrypted for one signing operation and overwritten when the operation ends, and derived account keys are destroyed after it. `lock()`, or the end of the unlock timeout, drops the data key.

As everywhere in JavaScript, this shortens the time a secret sits in memory but can't promise that no copy remains ([Keys in memory](security.md#keys-in-memory)). A phrase read with `mnemonic()` is a string, which can't be wiped.

### The accounts tag

The keystore also vouches for the wallet's accounts and keys. Its `auth` record is a tag under the data key over these values:

- the network;
- every account's id, kind, number, extended public key and origin;
- every imported address;
- every XMSS public key with its birth.

`unlock` checks the tag, and when it doesn't match, fails with `KEYSTORE_TAMPERED` and leaves the wallet locked. `restore` checks it before writing anything. A watch-only wallet has no keystore and so no tag to check.

From the first unlock on, the wallet holds its accounts and keys to the set it checked, for as long as the process lives, locked or not. If a later read of the store shows different ones, the wallet refuses every operation.

Before the first unlock, what a sync shows rests on records that nothing has checked yet. XMSS births are the one exception: the wallet passes none of them to the backend until it has been unlocked, so a sync before then scans every XMSS key from the backend's own start. An XMSS record's address is worked out again from its public key whenever the store is read.

### Someone who can write the store

Consider someone who can change the store's files or database but doesn't know the passphrase. Once the wallet has been unlocked, this is what they can and can't do:

| They try to | Possible |
| --- | --- |
| make the wallet hand out a receive address, or pay change to an address, that doesn't come from its own keys | no |
| add, remove or swap an account key, an imported address or an XMSS key | no |
| read a secret, or move one to another record | no |
| make it sign anything other than what `send` was asked for | no |
| destroy or damage the store | yes |
| change labels, locks and the address counters | yes |
| add or remove recorded transactions | yes, and the balance and history are wrong until `rescan()` rebuilds them from the chain |
| put back an older copy of the whole store | yes, because the copy is authentic in itself |

Putting back an older copy removes the accounts and keys added since the copy was made and moves XMSS indices back. Editing a record's `next` or clearing its freeze moves them back too. A moved-back XMSS index gets signed with a second time, which can lose the key's funds, and this is caught only once the chain shows the later signature.

Before the first unlock after `open`, they can also swap an account's key, because a wallet that only hands out addresses and is never unlocked has nothing to check it against. Unlock the wallet once after opening it and then `lock()` it, and keep the store where only the wallet can write, above all when it holds XMSS keys.

### Second writers and copies

The file and IndexedDB stores lock out a second writer, and the operations of one wallet run one at a time. A second writer can still get in, through a lock broken while its holder is alive or through a store with no lock. Even then the store gives each XMSS index to only one of them through `compareAndSet`, and the file store gives each revision to only one of them, so the other fails rather than overwriting.

A second copy of the store is a different matter, and no store can see one. A wallet directory copied to another machine, a restored snapshot, or a backup opened beside the original are two separate stores, and each hands out the same XMSS indices ([XMSS](xmss.md)).

### The backend

The wallet trusts its backend for what the chain holds. The exception is `filterBackend` or `blockbookBackend` held to an honest `crossCheck` endpoint or server ([Choosing a backend](../start/choosing-a-backend.md)). A backend that lies can hide payments or show false ones, but it can't make the wallet sign anything other than what you send.
