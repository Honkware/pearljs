# Wallet storage

## Stores

A `WalletStore` has seven methods: `get`, `set`, `delete`, `list(prefix)`, `batch(operations)`, `compareAndSet(expected, operations)` and `close`. Values are JSON. A write is durable when its promise resolves, and a batch applies entirely or not at all.

`compareAndSet` is a batch that applies only if every key in `expected` holds exactly the expected value (`undefined` for absent) in the durable state at that moment. Otherwise it resolves `false`, having written nothing.

Three stores come with pearljs:

| Store | Where | compareAndSet | Lock against a second writer |
| --- | --- | --- | --- |
| `createMemoryStore()` | memory, lost with the process | checks and writes with nothing in between | none; tests and wallets rebuilt on every start, never XMSS keys |
| `createFileStore(path)` from `pearljs/store-file` | a directory holding the whole state as numbered revision files; each write goes to a temporary file, is written to the last byte, fsynced, and hard-linked to the next revision's name, and the directory fsynced | every write is one: the link fails if another writer made that revision | the `lock` file in the directory, held until close |
| `openIndexedDbStore(name)` | an IndexedDB database; each batch is one transaction with strict durability | reads and writes in one readwrite transaction | an exclusive Web Lock where the platform has one, so a second tab fails to open it |

`pearljs/store-file` imports `node:fs` and is not re-exported by the main entry. The other two are. A page that keeps XMSS keys in the IndexedDB store should read [XMSS keys in a page](../concepts/browsers-and-bundlers-keys.md#xmss-keys-in-a-page) first.

## File store layout

The file store's directory holds the newest two revisions, `<16 digits>.json`, each `{"format":"pearljs-wallet-store","version":2,"revision":N,"id":"<32 hex>","entries":{...}}`. The highest is the state. A crash leaves the last revision that was linked, whole.

The directory must be on a file system with hard links (`STORE_UNAVAILABLE` otherwise) that honours fsync. Keep it on local storage.

[Restart, back up and restore a wallet](../guides/wallet-restart-and-backup.md#break-a-stale-lock) covers the lock file.

## Other stores

Anything else (SQLite, a key-value service) works if it keeps those promises. `compareAndSet` needs the most care. The check and the write must be one step in the store itself, a transaction or a conditional write, against every other writer. A store that answers the check from a cache, or reads and then writes, lets two writers sign with one XMSS index.

Every operation that changes a wallet ends in one batch or one `compareAndSet`. If it fails, the wallet reloads its state from the store. If the store can no longer be read, the wallet refuses further operations.

## Stored records

The schema version is 1 (`WALLET_SCHEMA_VERSION`). Amounts are decimal strings and bytes lowercase hex.

| Key | Value |
| --- | --- |
| `meta` | `{format: "pearljs-wallet", version, network, gapLimit, lookahead, reorgDepth, createdAt, scanned}` |
| `account:<id>` | `{id, kind: "seed" or "xpub", number, xpub, origin: {masterFingerprint, path} or null, label, receive, change}`, the last two the next index of each chain |
| `address:<address>` | `{account, change, index, label, issuedAt}`, for addresses handed out or labelled |
| `tx:<txid>` | `{hex, block: {height, hash} or null, status, seenAt, prevouts: [[script, value] or null], broadcast, missing, label, by, changeOutput, maxOutput}`, the last two for the wallet's own sends: the position of the change output and of the recipient sent the maximum, or -1 |
| `spent:<txid>:<vout>` | `{by}`: an output the backend reports spent by a transaction the wallet could not fetch |
| `lock:<txid>:<vout>` | `{until}`, milliseconds or null |
| `prepared:<id>` | `{hex, prevouts, changeAccount, changeIndex, changeOutput, maxOutput, label, maxFeeRate, expiresAt}`: a prepared send and what it holds until `expiresAt` |
| `imported:<address>` | `{address, label}` |
| `xmss:<public key>` | `{publicKey, address, next, label, frozen, seenOnChain, createdAt, synced, birth}`, `synced` false from a restore until a sync has finished, `birth` `{height, parent}` where the key's history can begin, without `parent` for a stated `birthHeight` ([Births](../concepts/xmss.md#births)) |
| `sync` | `{height, hash, at}`, the tip of the last sync |
| `keystore` | the encrypted keystore below |
| `auth` | `{nonce, tag}`: the keystore's tag over the accounts and keys, absent in a watch-only wallet |

`status` is `active` (pending or confirmed, by `block`), `conflicted`, `replaced`, `abandoned` or `orphaned`. Coins, balances and history are not stored. They are worked out from the transactions every time, so they cannot drift from them.

## The keystore

The keystore encrypts in two layers. scrypt turns the passphrase into a key-encryption key, which wraps a random 32-byte data key; the data key encrypts each secret and tags the set of them. Changing the passphrase (`changePassphrase`, with the wallet unlocked) makes a new data key, encrypts every secret again under it and wraps it under the new passphrase.

```json
{
  "format": "pearljs-keystore",
  "version": 1,
  "kdf": { "name": "scrypt", "N": 262144, "r": 8, "p": 1, "salt": "<32 bytes>" },
  "cipher": "aes-256-gcm",
  "key": { "nonce": "<12 bytes>", "ciphertext": "<32-byte data key and 16-byte tag>" },
  "secrets": { "seed": { "kind": "seed", "nonce": "<12 bytes>", "ciphertext": "<secret and tag>" } },
  "manifest": { "nonce": "<12 bytes>", "ciphertext": "<16-byte tag>" }
}
```

The passphrase goes through scrypt with N = 2^18, r = 8, p = 1 (`DEFAULT_KEYSTORE_KDF`), a 32-byte random salt and a 32-byte output, Oyster's default parameters. A stored keystore that asks for more than 1 GiB, or for N under 2^10, is refused, so a crafted file cannot exhaust memory. The cipher is AES-256-GCM from WebCrypto, which Node 20 and every current browser have, with a random 12-byte nonce per encryption; no cipher code ships with pearljs.

Every ciphertext is bound to what it is. The wrapped key's associated data is `pearljs-keystore:1:key:scrypt:<N>:<r>:<p>:<salt>`, so changing the parameters fails authentication rather than deriving another key, and each secret's is `pearljs-keystore:1:secret:<kind>:<id>`, so a ciphertext cannot be moved to another record or kind. `manifest` is the tag of an empty message under the data key whose associated data is `pearljs-keystore:1:manifest:` followed by the JSON list of `[id, kind, nonce]` for every secret, sorted by id; `unlock` checks it, so a secret that was removed, added, or put back from an older ciphertext fails the unlock (`KEYSTORE_TAMPERED`). `keystore.authenticate(context, message)` makes such a tag over `pearljs-keystore:1:mac:<context>:<message>` and `verify` checks one; the wallet stores one under `auth` over its accounts and keys.

The secrets are `mnemonic` (the phrase, UTF-8), `seed` (the BIP39 seed), `wif:<address>` (the WIF string) and `xmss:<public key>` (the 64-byte private seed, then the 32-byte public seed). The passphrase is read as UTF-8 after NFKD normalization, so either Unicode form of the same text opens it, and an empty one is refused.

A session lets a process that lost its memory, such as an extension's worker, unlock without the passphrase or scrypt. An unlock with `allowSessionExport` lets `exportSession()` hand out a session. `unlockWithSession(session)` on the wallet or the keystore turns it back into an unlocked keystore. A passphrase change makes every earlier session stale (`KEYSTORE_SESSION_STALE`).

A wallet unlocked from a session shows the recovery phrase only when given the passphrase, `wallet.mnemonic(passphrase)` (`KEYSTORE_PASSPHRASE_REQUIRED` without it). [Unlocking a new worker from a session](../guides/browsers-and-bundlers-extensions.md#unlock-a-new-worker-from-a-session) shows the flow and [Sessions](../concepts/security.md#sessions) what a session exposes.

`keystore.unlockedBySession` is true while the keystore is unlocked from a session, so without anyone having typed the passphrase. `keystore.checkPassphrase(passphrase)` runs scrypt and rejects with `KEYSTORE_BAD_PASSPHRASE` unless it is the keystore's passphrase, and changes nothing.

`unlock(passphrase, { timeout })` locks again after at most 2^31 - 1 ms (`MAX_UNLOCK_TIMEOUT_MS`), about 24 days; a longer timeout is a `RangeError`. `lock()` during an unlock that is still deriving the key wins, and that unlock rejects with `KEYSTORE_LOCKED`. After a passphrase change, the old passphrase and a copy of the keystore from before the change still open the secrets that copy holds, and nothing added afterwards, because the data key is new. Changing a passphrase that has leaked therefore protects what comes after; move funds if the old copy and passphrase may both be in other hands.

A wrong passphrase and a damaged wrapped key look the same: `KEYSTORE_BAD_PASSPHRASE`. A damaged or moved secret, a changed set of secrets, and wallet records that are not the ones the keystore tagged are `KEYSTORE_TAMPERED`. No error carries a passphrase or a secret; [Errors](errors.md#wallets-stores-and-keystores) lists every wallet, store and keystore code.

## Scrypt cost

The cost is paid at every unlock and is set when the keystore is made, with `kdf: { N }` on `PearlWallet.create` or `createKeystore`. `changePassphrase` takes a new one. Memory is 128 × N × r bytes, and time grows with it.

Time the unlock on the slowest device you support, under the load it will really have. Pick the largest N that keeps it acceptable there. A phone or a mobile webview is slower than the machine measured below, and may refuse a page that asks for 256 MiB at once. Do not go below 2^14 for real funds. A lower N makes a stolen keystore cheaper to attack in proportion, so pair it with a longer passphrase.

| N | Memory | Unlock |
| --- | --- | --- |
| 2^14 | 16 MiB | 46 ms |
| 2^15 | 32 MiB | 89 ms |
| 2^16 | 64 MiB | 181 ms |
| 2^17 | 128 MiB | 360 ms |
| 2^18 (default) | 256 MiB | 708 ms |

The unlock times are medians of five unlocks on one machine, described in [Keystore unlock times](../project/verification-runs.md#keystore-unlock-times).
 Under heavier load the same unlocks took about 1.5 times as long, 1.1 s at the default.

## Oyster's keystore

Oyster's address manager also has two layers. scrypt derives a master key from the passphrase (`snacl.NewSecretKey`, wallet/snacl/snacl.go:225) with N = 2^18, r = 8, p = 1 (`DefaultScryptOptions`, wallet/waddrmgr/manager.go:122). The master key encrypts the crypto keys that encrypt the account keys. The differences:

| | Oyster | pearljs |
| --- | --- | --- |
| Passphrase check | compares a SHA-256 digest of the derived key, stored next to the salt (snacl.go:200-210) | stores no digest; the wrapped key's authentication tag is the check |
| Cipher | NaCl secretbox (XSalsa20-Poly1305, 24-byte nonces; snacl.go:48-78), no associated data | AES-256-GCM with 12-byte nonces, every ciphertext bound to what it is |
| Storage | the parameters in a binary layout in its bolt database (snacl.go:138-188) | JSON |
| Encrypted | account extended keys and imported private keys | the seed, the mnemonic, WIF strings and XMSS seeds; account keys are derived from the seed for each signing operation |

The two formats do not read each other. An Oyster wallet moves to pearljs through its mnemonic, which restores the same BIP86 accounts.
