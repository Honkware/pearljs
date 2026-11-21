# Frequently asked questions

These questions came up while pearljs was tested against real pearld and Oyster nodes on regtest, testnet2 and mainnet, and on Windows. Each answer says what happened and where the full explanation is.

## Passphrases and recovery

### "wrong passphrase for this keystore" when sending

The wallet asks for its passphrase, the one chosen when the wallet was created, and the 24-word recovery phrase does not unlock it. Pass the passphrase to `wallet.unlock(passphrase)` before `send`. Any other text, the recovery phrase included, throws `KEYSTORE_BAD_PASSPHRASE`. The recovery phrase is only for rebuilding the wallet. [Send from a wallet](../guides/wallet-send.md) shows the unlock step.

### I forgot the passphrase I set when creating the wallet

The passphrase can't be recovered, but the recovery phrase rebuilds the wallet under a new one. Pass the phrase as `mnemonic` to `PearlWallet.create` with a new `passphrase` and an empty store, then sync, and the coins are at the same addresses as before. This brings back the accounts made from the phrase, but not imported keys or XMSS keys, which live only in the keystore. [Create a wallet and receive](../guides/wallet-create.md) covers `create`, and [Restart, back up and restore a wallet](../guides/wallet-restart-and-backup.md) covers restoring from backups.

### A restored wallet shows a zero balance

Run `diagnoseSeed` with the recovery phrase and a backend on the network the phrase was used on. It tries every derivation Pearl's wallets have used, scans further than a restore does, and reports what each one holds and why the restore missed it. [Recover a seed that shows zero](../guides/recovery.md) explains the report.

## Networks and keys

### Can I send mainnet PRL to a testnet address?

No. Mainnet and the test networks are separate chains, and a mainnet payment can only go to a mainnet address. Mainnet addresses start with `prl1`, testnet and testnet2 addresses with `tprl1`, and regtest and simnet addresses with `rprl1`, and passing an address for another network throws `address prefix tprl is not for mainnet` (`ADDRESS_WRONG_NETWORK`). The same recovery phrase also gives different addresses on mainnet than on the test networks, because the coin type in the derivation path is 808276 on mainnet and 1 elsewhere. [Networks and addresses](../guides/networks-and-addresses.md) has the prefixes and coin types of every network.

### Why does an exported key start with `K` or `L` on mainnet and `c` on testnet?

Each network has its own WIF byte, so the first character of an exported key depends on the network. `encodeWif` writes compressed keys as `dumpprivkey` does, and these start with `K` or `L` on mainnet, `c` on testnet, testnet2 and regtest, and `F` on simnet. A check that expects one of these prefixes holds on one group of networks only, so compare against the network's key or use `decodeWif(wif, network)`, which throws `WIF_WRONG_NETWORK` for a key made for another one. [Keys, mnemonics and accounts](../guides/keys-and-accounts.md) covers WIF keys.

## Nodes and environments

### "Address index must be enabled (--addrindex)" or "The transaction index must be enabled to query the blockchain (specify --txindex)"

`pearldBackend` looks coins up through pearld's address index, so the node must be started with `--addrindex`, which also turns on `--txindex`. Without them the backend throws a `MissingIndexError` whose `index` names the missing one. If you can't restart the node with the index, use `filterBackend`, which reads the chain through compact block filters and needs neither index, only the filter index that pearld keeps unless started with `--nocfilters`. `connectPearld` checks the node and returns whichever of the two it supports. [Choosing a backend](choosing-a-backend.md) and the [Wallet backend reference](../reference/wallet-backends-reference.md) list what each backend needs.

### "no WebSocket implementation available; pass one as WebSocket" on Node 20

Node 20 has no built-in WebSocket, and Node 22 does. On Node 20, install `undici` and pass its `WebSocket` as the client's `WebSocket` option. You need `undici` on Node 22 as well when connecting to pearld, since Node's built-in WebSocket can't be told to trust pearld's `rpc.cert`. [Receive websocket notifications](../guides/websocket.md) shows the connection.

### pearld exits straight away on Windows when started over SSH or from CI

Started from an SSH session or a CI job, pearld on Windows takes itself for a Windows service rather than a console program. Start it with `--nowinservice`. `startRegtest` from `pearljs/testing-regtest` adds the flag on Windows. [Test against regtest](../guides/testing-regtest.md) covers the launcher.

### `STORE_LOCKED` after a crash

The file store holds a lock file while it is open, and a process that is killed leaves the lock behind, so the next open throws `STORE_LOCKED`. Open the store with `createFileStore(dir, { breakStaleLock: true })`, which takes the lock over only when it was made on this host, its process isn't running and it hasn't been touched for `staleLockAfter` milliseconds. `breakLock: true` takes the lock whatever it says, so pass it only when you know the holder is gone, for example a lock made on another host that has stopped. [Restart, back up and restore a wallet](../guides/wallet-restart-and-backup.md) explains both options.

## Payments

### What does a payment cost, and how long does it take?

On mainnet a payment with one input and two outputs, the recipient and the change, was 154 vbytes and paid 155 grain at the relay floor of 1000 grain per 1000 vbytes (`DEFAULT_RELAY_FEE_RATE`). The fee is one grain above the signed size because coin selection prices inputs on Oyster's size estimate, which runs slightly above the real size. One PRL is 100,000,000 grain, so that fee is 0.00000155 PRL. A block arrives about every 3 minutes 14 seconds, the 194 seconds in each network's `targetSpacing`. [Relay policy and fee bumping](../guides/relay-policy-and-fee-bumping.md) covers the relay fee and size estimates, and [Fees and coin selection](../reference/payments-fees-and-coins.md) covers fee units.

### "No information available about transaction" after raising the fee

`bumpFee` sends a replacement that spends the same coins at a higher fee, and pearld removes the original from its mempool when it accepts the replacement. The original can then never confirm, so the node has nothing to report about it. Follow the `txid` that `bumpFee` returns instead, and the wallet shows the original as `replaced` in its history. [Send from a wallet](../guides/wallet-send.md) covers `bumpFee`, and [Relay policy and fee bumping](../guides/relay-policy-and-fee-bumping.md) the replacement rules.

### `INPUT_UNPREPARED` when signing a PSBT

`signInput` throws `INPUT_UNPREPARED` while any input of the PSBT is still missing its spent output. Call `prepareInput` on every input first, and sign only after all of them are prepared. [Build a payment for another signer](../guides/payments.md) shows the order.
