# Keys in a page

A web page or extension that holds keys faces everything any program holding keys faces, which [Security model](security.md#keys-in-memory) describes, and one exposure of its own: any script running on the page's origin can read what the page holds.

Keep recovery phrases out of `localStorage`, URLs and logs. A page that signs should hold the signing account only while it makes the signature, and then call `destroy()` to wipe its keys.

## XMSS keys in a page

An XMSS key can sign each of its indices only once, so a wallet has to remember which indices it has used. A page's wallet keeps that state in the IndexedDB store (`openIndexedDbStore`, [Wallet state and storage](../reference/wallet-storage.md#stores)), along with the rest of the wallet. The store handles the two dangers it can see:

- A crash. Each index is written durably before its signature is made, so a crash wastes an index and never repeats one.
- A second writer. The store holds a Web Lock, so a second tab cannot open it, and `compareAndSet` keeps two writers apart if one gets in anyway.

No store can tell when it has been copied, and browser storage is copied more readily than a server's disk. A profile synced or restored from a device backup, or site data copied to another profile, holds an older index state. A wallet resumed from that copy signs again with indices already used, which can lose the key's funds. The wallet freezes a key once the chain shows a signature past its state ([Hold XMSS keys in a wallet](../guides/wallet-xmss-keys.md)), but any signature made from the copy before then has already gone out.

> **Warning:** Keep XMSS keys in a page only where the browser profile is not synced or restored, and keep the funds such a key holds to what you could lose.

The memory store keeps nothing across a reload, so it is never a place for XMSS keys.

## The IndexedDB store

`openIndexedDbStore(name)` keeps a wallet in one IndexedDB database. It holds a Web Lock named after the database until `close`, and `close` resolves once the lock is free, so the same tab or another one can open the wallet straight afterwards. The store answers the common conflicts this way:

| Situation | Result |
| --- | --- |
| Two tabs on one wallet | The second gets `STORE_LOCKED` |
| Two wallets that get past the lock anyway (`unlocked: true`) send from one XMSS key at once | One sends, the other gets `XMSS_INDEX_REUSE` and signs nothing |
| A write past the storage quota | `STORE_WRITE_FAILED`, and the store is left as it was |
| A database at a later version than the store's (1) | Refused with `STORE_INVALID` |

The browser can also take the database away from an open store. When another tab upgrades or deletes it, the store closes its connection so that it doesn't block that tab. When the browser closes the connection itself, as it does when the site's data is cleared, the store loses the connection the same way.

In either case every later call fails with `STORE_UNAVAILABLE` and the wallet stops. Reload the page and open the wallet again. If the site's data was cleared, the wallet is gone (`WALLET_NOT_FOUND`), and `PearlWallet.restore` brings it back from its backups.

In a private window, IndexedDB lasts as long as the window does. A wallet created there works normally and disappears when the window closes.
