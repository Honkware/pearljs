# Changelog

## 0.1.0 (2026-11-21)

The first version. This lists what the library does.

### Behavior to know about

#### Signing and fees

- The PSBT signers sign SIGHASH_DEFAULT only, unless `allowedSighashTypes` lists another type (`SIGHASH_NOT_ALLOWED`). [PSBT workflows](docs/reference/psbt-checks.md#sighash-types-a-signer-accepts)
- A spend whose inputs are all P2MR is checked against its inputs' previous transactions before it is signed, unless `trustPrevouts` is set (`PREVIOUS_TRANSACTIONS_MISSING`). [P2MR](docs/guides/p2mr.md#previous-transactions)
- Signers and the wallet refuse a fee above `maxFeeRate` (`DEFAULT_MAX_FEE_RATE`, 5,000,000 grain per 1000 vbytes). [Building and sending payments](docs/guides/payments.md)
- `checkPsbtPayment` accepts change only on the account's change chain, below `nextChangeIndex` plus `gapLimit`. [PSBT workflows](docs/guides/psbt.md)
- `verifyMessage` accepts key-path signatures with SIGHASH_DEFAULT or SIGHASH_ALL only, unless `anySighashType: true` is set. [Messages](docs/reference/messages-formats.md#verification-results)

#### Parsing and clients

- Parsers are as strict as Pearl's, and return copies, never views of the caller's bytes. `parsePearl` and fee rate parsing refuse leading zeros. [Errors](docs/reference/errors.md#parsing)
- Among the params of `call`, a bare bigint is sent as an integer, so wrap amounts in `prlAmount(grain)`. [Node and wallet RPC](docs/guides/rpc.md#read-amounts)
- The RPC, websocket and Blockbook clients refuse plain `http://` or `ws://` to a host other than loopback unless told to, and read at most `maxReplySize` bytes of a reply. [Security model](docs/concepts/security.md#credentials-on-the-wire)
- RPC clients try any call again when its connection timed out before it opened. Nothing was sent, so a send is not repeated. [Node and wallet RPC](docs/guides/rpc-transports.md#retry-batch-and-fall-back)

#### Wallet

- `PearlWallet.create` and `restore` return the wallet unlocked, and it locks itself after five minutes (`DEFAULT_CREATE_UNLOCK_MS`). [Wallet state and storage](docs/guides/wallet-create.md#create-the-wallet)
- XMSS keys come out of `restore` frozen until `burnXmssIndices` moves them on (`XMSS_KEY_RESTORED`), and a key whose signatures on chain are ahead of its store freezes (`XMSS_KEY_BEHIND`). [XMSS keys](docs/guides/wallet-xmss-keys.md)
- `PearlWallet` frees the coins of a signed send only on proof that it failed (`WALLET_BROADCAST_REFUSED`, `WALLET_BROADCAST_UNCERTAIN`). [Send](docs/guides/wallet-send.md#send-a-payment)
- `wallet.mnemonic()` on a wallet unlocked from a session needs the passphrase (`KEYSTORE_PASSPHRASE_REQUIRED`). [The keystore](docs/reference/wallet-storage.md#the-keystore)
- `Keystore` gains `unlockedBySession` and `checkPassphrase`.
- `PearlWallet.close` closes the store of a wallet whose store failed, so the store's lock is let go.
- The IndexedDB store refuses every call once another tab or the browser has closed its database (`STORE_UNAVAILABLE`). [The IndexedDB store in a browser](docs/concepts/browsers-and-bundlers-keys.md#the-indexeddb-store)

#### Backends and recovery

- `filterBackend` and `blockbookBackend` with `crossCheck` fail the sync when their servers disagree (`CROSS_CHECK_FAILED`). [Trust](docs/concepts/compact-filters-scan.md#trust)
- `blockbookBackend` over a `BlockbookWsClient` needs `verifyBlocks: false`. [Over the websocket alone](docs/reference/blockbook-api.md#websocket-only-backend)
- `diagnoseSeed` and `diagnoseAccount` send a backend addresses only, unless `shareAccountKeys: true` is set. [Account keys sent to a backend](docs/concepts/security.md#account-keys-sent-to-a-backend)
- `BEYOND_RECOVERY_WINDOW` names payments Oyster's restore misses, found by replaying its walk of the chain. [Reading the report](docs/guides/recovery.md#read-the-report)
- `discoverAccount`, `diagnoseSeed` and `diagnoseAccount` stop at `scanLimit` addresses of a chain (`BACKEND_RESPONSE`). [Recovering a seed that shows zero](docs/guides/recovery.md)

#### Proof verification

- `pearljs/verify-proof` refuses a module or circuit cache whose SHA-256 is not the pinned one (`PROOF_VERIFIER_UNAVAILABLE`). [Loading](docs/guides/verify-proof.md#load-the-verifier-ahead-of-time)
- `pearljs/verify-proof` keeps one verifier instance, whose memory stays at what the largest proof so far needed. [Verifying proofs](docs/guides/verify-proof.md)

### Features

- Keys, accounts and addresses derive as Oyster derives them, on all five of Pearl's networks.
- Payments go from unspent outputs to a signed transaction checked against pearld's relay policy.
- Script-path signing for P2TR and P2MR on the transaction (`signP2mrInput`, `signTapscriptUnchecked`, `tapscriptSighash`) and through PSBT, with taproot annexes and `OP_CODESEPARATOR`. Every signature is checked against its leaf and key before it is returned.
- XMSS keys sign byte for byte as Pearl's library signs, with crash-safe index stores.
- PSBTs carry payments to cold, hardware and co-signers, with change the signer can prove.
- `PearlWallet` keeps an encrypted wallet in step with the chain through reorgs, restarts and restores.
- Typed clients and wallet backends reach pearld, Oyster and Blockbook over HTTP and websocket.
- Invoices follow a payment request from unpaid to confirmed.
- Blocks parse with V1 to V4 certificates, and Pearl's verifier checks their proofs in WebAssembly.
- A simulated chain, node and Blockbook serve an application's tests.

Every guide is listed in the [documentation index](docs/README.md).
