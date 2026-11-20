# Keep XMSS index state

An XMSS key needs a record of the one-time indices it has used, kept for the key's whole life, because signing twice at one index exposes the key ([Index state](../concepts/xmss.md#index-state)). For Node, pearljs provides a file store that keeps this record, and a store of your own can keep it in a database instead. A key held in a `PearlWallet` needs none of this, since the wallet reserves each index in its own store ([Hold XMSS keys in a wallet](wallet-xmss-keys.md)).

## Use the file store

`createFileXmssIndexStore` keeps a key's next index in a file, one file per key. It lives in its own module, `pearljs/xmss-file-store`, because it imports `node:fs`, and the main `pearljs` entry does not re-export it. Open the store, give it to a signer, and close both when the signing is done:

```ts run
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createXmssSigner } from 'pearljs';
import { createFileXmssIndexStore } from 'pearljs/xmss-file-store';

// In practice a fixed path on durable local storage, such as /var/lib/wallet/key-1.xmss-index.
const path = join(mkdtempSync(join(tmpdir(), 'xmss-')), 'key-1.xmss-index');
const seeds = { privateSeed: new Uint8Array(64).fill(1), publicSeed: new Uint8Array(32).fill(2) };

async function signOnce(sighash: Uint8Array, newKey: boolean): Promise<Uint8Array> {
  // `create: true` starts a file at index 0 and fails if the file exists.
  const store = createFileXmssIndexStore(path, { create: newKey });
  const signer = createXmssSigner(seeds.privateSeed, seeds.publicSeed, store);
  try {
    return await signer.sign(sighash);
  } finally {
    signer.destroy();
    store.close();
  }
}

const first = await signOnce(new Uint8Array(32).fill(1), true);
const second = await signOnce(new Uint8Array(32).fill(2), false);
// An XMSS signature starts with its index, big-endian.
console.log(first.subarray(0, 4), second.subarray(0, 4)); // index 0, then index 1
```

Pass `create: true` once, the first time you open the store for a key that has never signed, and leave it out every time after. The option exists so that a store never starts again at index 0 by accident. Without it the file has to exist already, so a mistyped or lost path is an error rather than a fresh start, and with it the file must not exist yet. The store throws `XmssError` with code `XMSS_STORE_INVALID` in these cases:

| Message | Cause |
| --- | --- |
| `... does not exist; pass create: true only for a key that has never signed` | The path is wrong, or the state file is lost |
| `... already exists; open it without create` | `create: true` on a key that already has a file |
| `... is not valid; refusing to guess the next index` | The state file is damaged |
| `... belongs to a different key` | One file used for two keys |

A lost or damaged state file is covered under [Recover from a crash](#recover-from-a-crash).

## State file

The state file is one line of JSON, such as `{"version":1,"publicKey":"<128 hex characters>","next":3}`, created with mode 0600 so that only its owner can read it. It binds itself to the first key that reserves an index from it, and refuses any other key after that.

To read the next unused index, call `store.peek()` on an open store. A monitoring job can call `readXmssIndexFile(path)` instead, which reads the same value from the file without taking the lock, so it works while a signer has the file open. It returns `{ publicKey, next, remaining, locked }`. Once index 30 has been handed out, `reserve` throws `XMSS_INDEX_EXHAUSTED` and leaves the file as it is.

## Index markers

Each index the store hands out also gets a marker file beside the state file, named `<path>.index-00` to `<path>.index-30`. `reserve` creates the marker for the next index exclusively, syncs it and its directory to disk, and only then returns the index. After that it rewrites the state file through a temporary file and a rename.

The markers are what keep an index to one use. A file can be created exclusively only once, so however many stores or processes end up on one state file, and whatever happened to the lock, each index goes to at most one of them. The others get `XMSS_INDEX_REUSE` and refuse every later call. A store that opens a file takes the higher of the index in the state file and the one the markers show. Keep the markers with the state file and leave them in place for the life of the key.

## Lock file

While a store is open it holds a lock file, `<path>.lock`, which names the process and host that hold it. The lock is released by `close` or when the process exits normally, and while it is held, a second store or a second process that opens the same file gets `XMSS_STORE_LOCKED`.

The holder touches the lock every couple of seconds and checks that the lock is still its own before every reservation. If the lock was removed or taken over, the store reserves nothing more, and `close` removes the lock only if it is still the store's own.

These guarantees rest on the filesystem honouring fsync, atomic rename and exclusive creation, and some network filesystems do not. Keep the files on local storage.

## Recover from a crash

If the process dies between reserving an index and using the signature, that index is recorded as used and is simply lost. The next signature takes the next index, so nothing is repeated, and the cost is one of the key's 31 signatures.

A process that is killed leaves its lock file behind, and the next store to open the file gets `XMSS_STORE_LOCKED`. Leave the lock file in place and open the store with `breakStaleLock: true`, which takes the lock over under the same three conditions as the wallet's file store ([Break a stale lock](wallet-restart-and-backup.md)):

- The lock was made on this host.
- Its process is no longer running.
- It has not been touched for `staleLockAfter`, which is 10 seconds unless you set it.

When pearljs cannot tell whether the holder is gone, as with a lock from another host, `breakLock: true` takes the lock whatever it says, so pass it only when you know the holder has stopped. If the holder is in fact still running, its next reservation is refused, and the markers still keep the two from sharing an index.

If the state file itself is lost or damaged, leave the key alone rather than recreating the file with `create: true`, because a new file starts at index 0 and hands out every index the key has already used ([Index state](../concepts/xmss.md#index-state)). pearljs has no way to learn which indices a key has used. The index of each signature that reached the chain can be read from its first four bytes, but a signature that was made and never broadcast leaves no trace, and that one signature plus a new one at the same index is enough to forge. The safe course for a key whose state is lost is to stop signing with it, and if the output has another leaf, to spend through that one.

## Write your own store

Any object with `reserve` and `peek` methods works as a store, and either method may be synchronous or return a promise. A store kept in a database reserves an index in one atomic step that is committed before `reserve` returns, and it should refuse to go past index 30. `peek` reads the next index without changing it. This sketch shows the shape for a table with one row per key:

```ts
import { type XmssIndexStore } from 'pearljs';

interface Database {
  /** Runs one statement in its own committed transaction and returns the first row. */
  queryOne(sql: string, params: unknown[]): Promise<{ reserved: number } | undefined>;
}

function databaseStore(db: Database): XmssIndexStore {
  return {
    async reserve(publicKey) {
      const key = Buffer.from(publicKey).toString('hex');
      // The row for a key is inserted once, when the key is made, with next_index 0.
      const row = await db.queryOne(
        'UPDATE xmss_keys SET next_index = next_index + 1 WHERE public_key = $1 AND next_index <= 30 RETURNING next_index - 1 AS reserved',
        [key],
      );
      if (row === undefined) throw new Error('no index state for this XMSS key, or the key is used up');
      return row.reserved;
    },
    async peek(publicKey) {
      const key = Buffer.from(publicKey).toString('hex');
      const row = await db.queryOne('SELECT next_index AS reserved FROM xmss_keys WHERE public_key = $1', [key]);
      if (row === undefined) throw new Error('no index state for this XMSS key');
      return row.reserved;
    },
  };
}
```

When a store finds no state for a key it should throw, as this one does, rather than start at 0. It should read the index from the database on every call rather than cache it in memory, since another process may have moved it, and it should throw when it cannot write, so that the signer never signs at an index that was not recorded.
