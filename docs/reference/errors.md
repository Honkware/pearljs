# Errors

Every failure a program can act on is a `PearlError` with a `code`. Branch on the code; the message is for people and may gain detail between releases.

```ts run
import { AddressError, PearlError, decodeAddress, encodeAddress, networks } from 'pearljs';

const testnetAddress = encodeAddress({ version: 1, program: new Uint8Array(32).fill(1) }, networks.testnet);
try {
  decodeAddress(testnetAddress, networks.mainnet);
} catch (err) {
  if (err instanceof AddressError && err.code === 'ADDRESS_WRONG_NETWORK') console.log('that address is for another network');
  else if (err instanceof PearlError) console.log(err.code, err.message);
  else throw err;
}
```

A wrong argument type is a `TypeError` and an index or length out of range a `RangeError` or a plain `Error`. Those are mistakes in the calling code and have no code.

## Classes

| Class | Thrown by |
| --- | --- |
| `PearlError` | The base. Everything below extends it, and codes without a class of their own are thrown as it |
| `AddressError` | `decodeAddress`, `toOutputScript`, `fromOutputScript`, `encodeAddress` |
| `PolicyError` | `checkSanity`, `checkStandard`, `checkReplacement`, `checkPackageLimits`, and the builders that call them. The message is pearld's own text |
| `SigningError` | Signers, `finalizePsbt` and `finalizePayment`, when they refuse or a signature does not verify |
| `XmssError` | XMSS keys, signers and index stores |
| `InsufficientFundsError` | `selectCoins`, `buildPayment`, `payFromAccount`. Has `available`, `required`, `fee` and `missing` in grain |
| `WalletInsufficientFundsError` | `PearlWallet`'s sends. An `InsufficientFundsError` that also has `locked`, `immature`, `unconfirmed` and `frozen` in grain |
| `ScriptRejectedError` | `assertAccepted`. Has `scriptCode` and `scriptMessage`, the engine's ErrorCode name and text, and `at` and `inputIndex` when known |
| `PearlRpcError` | Every RPC client. Has `kind`, `method`, `rpcCode` (the number the server sent), `status` and `notSent` |
| `MissingIndexError` | The pearld wallet backend and `resolvePrevouts`. Has `index`: `addrindex` or `txindex` |
| `UnsupportedMethodError` | A backend whose server refuses a method for its credentials or mode. Has `method` |
| `InvoiceGapError` | `InvoiceIndexAllocator`, at its gap limit |
| `StoreError` | The wallet stores: `createFileStore`, `openIndexedDbStore`, `createMemoryStore` |
| `KeystoreError` | `createKeystore`, `openKeystore` and a `Keystore`'s methods |
| `WalletError` | `PearlWallet` |

## Workers and processes

`JSON.stringify(err)` gives `{ name, code, message }`, and `PearlError.fromJSON` turns that back into a `PearlError`. `structuredClone` and `postMessage` keep an error's message and drop its other fields, so send `err.toJSON()` instead of the error:

```ts run
import { PearlError, parsePearl } from 'pearljs';

try {
  parsePearl('1.123456789');
} catch (err) {
  if (!(err instanceof PearlError)) throw err;
  const wire = JSON.stringify(err); // {"name":"PearlError","code":"AMOUNT_INVALID","message":"..."}
  console.log(PearlError.fromJSON(JSON.parse(wire)).code); // AMOUNT_INVALID
}
```

No error holds a private key, a WIF, a recovery phrase or an RPC password, so logging one is safe.

## Codes

### Addresses, amounts and keys

| Code | Class | When |
| --- | --- | --- |
| `ADDRESS_MALFORMED` | `AddressError` | The text is not bech32m at all: wrong characters, mixed case, no separator, bad padding |
| `ADDRESS_BAD_CHECKSUM` | `AddressError` | The checksum does not match. A mistyped address, or a bech32 (witness v0) address, which Pearl does not have |
| `ADDRESS_WRONG_NETWORK` | `AddressError` | A valid address with another network's prefix |
| `ADDRESS_UNSUPPORTED_VERSION` | `AddressError` | A witness version other than 1 (P2TR) or 2 (P2MR) |
| `ADDRESS_WRONG_LENGTH` | `AddressError` | A witness program that is not 32 bytes |
| `ADDRESS_UNSUPPORTED_SCRIPT` | `AddressError` | `fromOutputScript` was given a script that is not P2TR or P2MR |
| `AMOUNT_INVALID` | `PearlError` | Text that is not a decimal PRL amount with at most 8 decimals |
| `AMOUNT_OUT_OF_RANGE` | `PearlError` | An amount that is negative where it cannot be, or above `MAX_GRAIN` |
| `FEE_RATE_INVALID` | `PearlError` | A fee rate that is negative, not a bigint, or text with more than three decimals |
| `KEY_INVALID` | `PearlError` | Bytes that are not a valid private or x-only public key |
| `WIF_MALFORMED` | `PearlError` | A WIF of the wrong length or with a character outside base58 |
| `WIF_BAD_CHECKSUM` | `PearlError` | A WIF whose checksum does not match |
| `WIF_WRONG_NETWORK` | `PearlError` | A WIF for another network |
| `MNEMONIC_INVALID` | `PearlError` | A phrase with a word outside the BIP39 list or a bad checksum |
| `SEED_INVALID` | `PearlError` | `seedFromInput` or `diagnoseSeed` was given neither a valid phrase nor a hex seed of 16 to 64 bytes, or `PearlWallet.create` both a `mnemonic` and a `seed` |
| `EXTENDED_KEY_INVALID` | `PearlError` | An extended key that does not parse, belongs to another network, is private where a public one is needed, or is not at account depth |

### Parsing

| Code | Class | When |
| --- | --- | --- |
| `TX_MALFORMED` | `PearlError` | `parseTransaction` was given text that is not a transaction, or one with an output above `MAX_GRAIN` |
| `PSBT_MALFORMED` | `PearlError` | `parsePsbt` or `createPsbt` refused its input |
| `BLOCK_MALFORMED` | `PearlError` | `parseBlock` was given bytes that are not one canonical block |
| `CERTIFICATE_MALFORMED` | `PearlError` | A certificate with an unknown version or a field over its size limit, or public data, a mining configuration or a V4 statement that `pearljs/mining` cannot read or that breaks Pearl's structure rules |
| `FILTER_MALFORMED` | `PearlError` | A compact filter that is empty or has a bad item count |
| `SIGNATURE_MALFORMED` | `PearlError` | A message signature that is not base64 of a witness stack. `verifyMessage` returns false instead |
| `MESSAGE_INVALID` | `PearlError` | A message `signMessage` cannot sign: over 80 bytes in Oyster's format, or with a lone surrogate |

### Scripts and blocks

| Code | Class | When |
| --- | --- | --- |
| `SCRIPT_MALFORMED` | `PearlError` | `decompileScript` met a push that runs past the end |
| `SCRIPT_INVALID` | `PearlError` | A script, script number, asm text or multi_a leaf that cannot be built or read |
| `PREIMAGE_INVALID` | `PearlError` | `htlcStack` was given no preimage, or one that is not 32 bytes or does not hash to the claim leaf's hash |
| `SCRIPT_TREE_INVALID` | `PearlError` | A tree with no leaves, duplicate leaves, or more than 128 levels |
| `CONTROL_BLOCK_INVALID` | `PearlError` | A control block of the wrong size or with an invalid key or parity bit |
| `LEAF_COMMITMENT_MISMATCH` | `PearlError` | A leaf and control block that do not open the output they are used on |
| `SCRIPT_REJECTED` | `ScriptRejectedError` | `assertAccepted`, `finalizePsbt` and `finalizeScriptPathInput`, for a spend the script interpreter refused. `scriptCode` is the name of Pearl's txscript ErrorCode |
| `BLOCK_CERTIFICATE_INVALID` | `PearlError` | `checkCertificateBinding` or `checkCertificateRules` refused a block's certificate |
| `BLOCK_MERKLE_ROOT_MISMATCH` | `PearlError` | `checkMerkleRoot`: the header's root is not that of the transactions |
| `BLOCK_WITNESS_COMMITMENT_INVALID` | `PearlError` | `checkWitnessCommitment` refused the coinbase commitment |
| `BLOCK_HEADER_INVALID` | `PearlError` | `filterBackend` or the P2MR scan of `pearldBackend`: a header that does not hash to its block's hash, does not follow the block before it, or has bits or a time pearld would refuse |
| `FILTER_HEADER_MISMATCH` | `PearlError` | `checkFilterHeaders`: a filter does not hash to its header; `filterBackend`: the node's or a cross-check endpoint's filter header differs from the one the filters chain to |
| `CROSS_CHECK_FAILED` | `PearlError` | `filterBackend`: a cross-check endpoint has another block at a height, could not be asked, or its tip and the node's are further apart than `crossCheckLag`; `blockbookBackend`: the same of a cross-check server, or one that lists other confirmed transactions for an address or, without `verifyBlocks`, places a transaction in another block |
| `CROSS_CHECK_UNSUPPORTED` | `PearlError` | `connectPearld` was given `crossCheck` endpoints for a node with the address index, whose `pearldBackend` cannot be cross-checked |

### Relay policy

The message of a `PolicyError` is what pearld would answer. `SANITY_*` codes are consensus rules from `checkSanity`; `POLICY_*` are standardness rules from `checkStandard`.

| Code | Class | When |
| --- | --- | --- |
| `SANITY_NO_INPUTS` | `PolicyError` | The transaction has no inputs |
| `SANITY_NO_OUTPUTS` | `PolicyError` | The transaction has no outputs |
| `SANITY_TX_TOO_LARGE` | `PolicyError` | Larger than a block |
| `SANITY_OUTPUT_SCRIPT` | `PolicyError` | An output that is not P2TR, P2MR or OP_RETURN |
| `SANITY_OUTPUT_NEGATIVE` | `PolicyError` | An output with a negative value |
| `SANITY_OUTPUT_TOO_LARGE` | `PolicyError` | An output above `MAX_GRAIN` |
| `SANITY_TOTAL_TOO_LARGE` | `PolicyError` | Outputs that add up to more than `MAX_GRAIN` |
| `SANITY_DUPLICATE_INPUTS` | `PolicyError` | The same outpoint spent twice |
| `SANITY_COINBASE_SCRIPT` | `PolicyError` | A coinbase whose script is not 2 to 100 bytes |
| `SANITY_COINBASE` | `PolicyError` | A coinbase transaction on its own |
| `SANITY_NULL_INPUT` | `PolicyError` | An input that spends the null outpoint |
| `SANITY_INPUTS_BELOW_OUTPUTS` | `PolicyError` | The spent outputs are worth less than the new ones |
| `POLICY_NO_WITNESS` | `PolicyError` | No input has a witness |
| `POLICY_TX_TOO_SMALL` | `PolicyError` | Under 65 bytes without witnesses |
| `POLICY_VERSION` | `PolicyError` | A version outside 1 to `maxTxVersion` |
| `POLICY_NOT_FINAL` | `PolicyError` | A locktime the next block does not satisfy |
| `POLICY_TX_TOO_LARGE` | `PolicyError` | Over 100,000 vbytes |
| `POLICY_SIGSCRIPT_SIZE` | `PolicyError` | A signature script over 1650 bytes |
| `POLICY_SIGSCRIPT_NOT_PUSH_ONLY` | `PolicyError` | A signature script with an opcode that is not a push |
| `POLICY_DUST` | `PolicyError` | An output under the dust threshold |
| `POLICY_MULTIPLE_NULLDATA` | `PolicyError` | More than one OP_RETURN output |
| `POLICY_NONSTANDARD_INPUT` | `PolicyError` | A spent output of an unknown script class |
| `POLICY_FEE_TOO_LOW` | `PolicyError` | A fee under the relay minimum |
| `POLICY_FEE_TOO_HIGH` | `PolicyError` | A fee rate above the `maxFeeRate` given to `checkStandard` |
| `RBF_NOT_REPLACEABLE` | `PolicyError` | A conflict that does not signal replacement, or a node that rejects replacement |
| `RBF_TOO_MANY_EVICTIONS` | `PolicyError` | The replacement would evict more than 100 transactions |
| `RBF_SPENDS_CONFLICT` | `PolicyError` | The replacement spends an output of a transaction it evicts |
| `RBF_FEE_RATE_TOO_LOW` | `PolicyError` | A fee rate not above that of every evicted transaction |
| `RBF_FEE_TOO_LOW` | `PolicyError` | A fee under the evicted fees plus the replacement's own relay fee |
| `RBF_NEW_UNCONFIRMED_INPUT` | `PolicyError` | The replacement adds an unconfirmed input its conflicts did not spend |
| `PACKAGE_TOO_LONG` | `PolicyError` | Too many unconfirmed ancestors or descendants, or too large an ancestor set |

### Payments and signing

| Code | Class | When |
| --- | --- | --- |
| `PAYMENT_INVALID` | `PearlError` | `buildPayment` options that cannot make a payment: no recipients, two `max` recipients, duplicate unspent outputs, no change address, nothing left after the fee |
| `UTXO_INVALID` | `PearlError` | An unspent output that cannot be used as given: wrong owner, unsupported script, a P2MR output without its leaf, a value out of range |
| `INSUFFICIENT_FUNDS` | `InsufficientFundsError` | The spendable outputs do not cover the recipients and the fee |
| `INPUT_UNPREPARED` | `SigningError` | A PSBT input has no witness UTXO yet. Prepare every input before signing any. `verifyFinalizedPsbt` says it too for an input with no UTXO to verify against |
| `INPUT_MISMATCH` | `SigningError` | The input is not what this signer signs: another child's output, the wrong output type, a leaf that does not push the signer's key, a leaf that is not in the input |
| `DERIVATION_NOT_FOUND` | `SigningError` | `signInput` was given no child and the input's `tapBip32Derivation` names none of this account's |
| `SIGHASH_NOT_ALLOWED` | `SigningError` | The PSBT asks for a sighash type that is not in `allowedSighashTypes` |
| `SIGHASH_UNSUPPORTED` | `SigningError` | Not a Taproot sighash type, or SIGHASH_SINGLE without a matching output |
| `PREVIOUS_TRANSACTIONS_MISSING` | `SigningError` | An all-P2MR spend without the previous transactions and without `trustPrevouts` |
| `PREVOUT_MISMATCH` | `SigningError` | A spent output's script or value is not what its previous transaction holds |
| `FEE_TOO_HIGH` | `SigningError` | The fee is above the ceiling: `maxFeeRate` in a P2MR or XMSS signer and in a wallet `send`, `bumpFee`, `sweep`, `prepareSend`, `submitSigned` or `estimateSend`, which also refuse a backend estimate above it; `maxFee` in `checkPsbtPayment`. Usually a missing change output, or a fee estimate that is far too high |
| `OUTPUTS_EXCEED_INPUTS` | `SigningError` | The outputs add up to more than the inputs |
| `SIGNATURE_INVALID` | `SigningError` | A signature that was just made, or one found in a PSBT, does not verify |
| `SIGNATURES_MISSING` | `SigningError` | A leaf has fewer signatures than it needs to be finalized |
| `WITNESS_ITEMS_NEEDED` | `SigningError` | `finalizePsbt` met a leaf its signatures alone do not satisfy; pass the leaf's other items to `finalizeScriptPathInput`. `cause` is the `ScriptRejectedError` |
| `INPUT_NOT_FINALIZED` | `SigningError` | `finalizePsbt` met an input with no key-path signature and no tap leaf to spend through, or `verifyFinalizedPsbt` met an input that is not finalized |
| `OUTPUT_MISMATCH` | `SigningError` | `prepareOutput` was given a child the output does not pay |
| `PSBT_RECIPIENT_MISSING` | `SigningError` | `checkPsbtPayment`: no output pays an expected recipient its amount |
| `PSBT_OUTPUT_UNEXPECTED` | `SigningError` | `checkPsbtPayment`: an output is neither an expected recipient nor proven to be the account's own |
| `TRANSACTION_MISMATCH` | `SigningError` | `finalizePayment` was given a signed transaction other than the one the payment built |
| `SIGNER_DESTROYED` | `SigningError` | A signing method was called after `destroy()` |

### XMSS

| Code | Class | When |
| --- | --- | --- |
| `XMSS_INDEX_EXHAUSTED` | `XmssError` | The key has made its 31 signatures |
| `XMSS_INDEX_REUSE` | `XmssError` | An index would be used twice, and nothing was signed: the store handed out an index that is not new, the index already signed a different message in this process, or the stored index is not the one this wallet or file store last wrote, because another writer is using it. From a wallet also: `submitSigned` given a signature at an index the wallet has handed out, and `burnXmssIndices` asked to move a key back, to an index seen on chain, or to where it already stands without `nothingSigned` |
| `XMSS_STORE_LOCKED` | `XmssError` | Another store holds the state file's lock, or a store's lock was removed or taken over before a reservation: no index was reserved |
| `XMSS_STORE_INVALID` | `XmssError` | The state file is missing, damaged, already exists, belongs to another key, cannot be written, or the store is closed |
| `XMSS_KEY_INVALID` | `XmssError` | A secret key whose root does not match its seeds |
| `XMSS_SIGNATURE_INVALID` | `XmssError` | A signature that was just made does not verify |
| `XMSS_KEY_RESTORED` | `XmssError` | A wallet's XMSS key came back from a backup and refuses to sign until `burnXmssIndices` moves it past every index it may have used; also `burnXmssIndices` on such a key before a sync has finished |
| `XMSS_KEY_BEHIND` | `XmssError` | The chain, or a transaction the wallet recorded, shows a signature of a wallet's XMSS key at or past its stored next index: the state is older than the key. Burn forward with `burnXmssIndices` before signing |

### RPC, backends and invoices

| Code | Class | When |
| --- | --- | --- |
| `RPC_ERROR` | `PearlRpcError` | The server answered with an error. `rpcCode` is its number; compare with `RPC_ERROR_CODES` |
| `RPC_HTTP` | `PearlRpcError` | An HTTP error status, in `status` |
| `RPC_NETWORK` | `PearlRpcError` | The server could not be reached, the connection dropped, or the call timed out or was aborted |
| `RPC_RESPONSE` | `PearlRpcError` | A reply that is not what the method returns |
| `BACKEND_MISSING_INDEX` | `MissingIndexError` | pearld runs without the index the query needs |
| `BACKEND_UNSUPPORTED` | `UnsupportedMethodError`, `PearlError` | The server will not do this for these credentials or in this mode: a broadcast as pearld's limited user or through an Oyster in SPV mode (`UnsupportedMethodError`, whose `method` names the refused method); `connectPearld` on a node with neither index; a notification command on Oyster's websocket; and from `blockbookBackend`, a raw block over the websocket, or an address or account with more history than Blockbook pages through (100,000 confirmed transactions) or more mempool transactions than one page lists (1000) |
| `BACKEND_RESPONSE` | `PearlError` | A backend or chain client answered wrongly: a malformed value, a transaction or block that does not hash to the id asked for, an output for an address not asked about, a fee estimate that is not a positive rate, a Blockbook reply that fails `blockbookBackend`'s checks, or addresses reported used past `scanLimit` in a sync, `discoverAccount` or a seed diagnosis |
| `BACKEND_WRONG_NETWORK` | `PearlError` | A Blockbook serves another network than its client's: another chain name or another block 0 |
| `INVOICE_INVALID` | `PearlError` | `createInvoice` was given a bad id, address, amount or time |
| `INVOICE_JSON_INVALID` | `PearlError` | `invoiceFromJson` or `invoicePaymentFromJson` was given something `invoiceToJson` did not write: another format or version, a bad field, or totals that do not match the payments |
| `INVOICE_GAP_LIMIT` | `InvoiceGapError` | `InvoiceIndexAllocator` would have to hand out an index further past the last paid one than its gap limit, where a wallet restore would not find a payment |
| `INVOICE_PAYER_UNKNOWN` | `PearlError` | `fetchPayerInputs` could not get the payment or a transaction it spends from its source |

### Chain reads and test chains

| Code | Class | When |
| --- | --- | --- |
| `SIMULATION_INVALID` | `PearlError` | A `SimulatedChain` from `pearljs/testing` was asked for a step it cannot take: a reorg deeper than the chain, a double spend it cannot sign, an invalid transaction to mine, more than the faucet holds |
| `REGTEST_FAILED` | `PearlError` | `startRegtest` could not run a binary, or its RPC server did not come up. The message ends with the server's log |
| `INSPECT_PREVOUTS` | `PearlError` | `inspectTransaction` was given prevouts that do not match the inputs or are worth less than the outputs, or any at all for a coinbase |
| `PREVOUT_NOT_FOUND` | `PearlError` | `resolvePrevouts`: the node has no such parent transaction, or the parent has no such output |
| `FOLLOW_REORG_TOO_DEEP` | `PearlError` | `followChain`: the chain changed at or below the oldest block the follower remembers, or under a cursor that carries no ancestors. Start again from an earlier block |
| `FOLLOW_START_UNKNOWN` | `PearlError` | `followChain`: `from.hash` names a block the node does not know or that is not on its best chain |

### Wallets, stores and keystores

| Code | Class | When |
| --- | --- | --- |
| `STORE_LOCKED` | `StoreError` | Another process, store or tab holds the wallet store's lock; the message says whether `breakStaleLock` would take it. Also a write by a file store whose lock was removed or taken over: nothing was written, and the store refuses every later call |
| `STORE_NOT_FOUND` | `StoreError` | `createFileStore` without `create` for a path that does not exist or holds no store |
| `STORE_EXISTS` | `StoreError` | `createFileStore` with `create` for a store that exists |
| `STORE_INVALID` | `StoreError` | A store revision that is not JSON, not a pearljs store, or of another format version, a path that is a file, or an IndexedDB database at a later version than the store's |
| `STORE_CLOSED` | `StoreError` | A store used after `close` |
| `STORE_UNAVAILABLE` | `StoreError` | `openIndexedDbStore` where there is no IndexedDB, or `createFileStore` on a file system without hard links. Also every call to an IndexedDB store once another tab upgraded or deleted its database or the browser closed it (site data cleared), and an IndexedDB request that failed |
| `STORE_CONFLICT` | `StoreError` | A file store found a revision it did not write: another writer is using the store. The message says whether the write was left out or may have been applied, and the store refuses every later call; reopen it |
| `STORE_WRITE_FAILED` | `StoreError` | A file store could not write its next revision whole (a full disk, an I/O error), or the browser refused an IndexedDB write past the storage quota. The stored state is unchanged and the cause is attached |
| `KEYSTORE_BAD_PASSPHRASE` | `KeystoreError` | The passphrase does not open the keystore, or the wrapped key or its parameters were changed: the two cannot be told apart |
| `KEYSTORE_TAMPERED` | `KeystoreError` | A secret's ciphertext fails authentication (altered, damaged or moved from another record); the keystore's set of secrets is not the one it tagged; or, on `wallet.unlock`, the wallet's accounts, imported addresses or XMSS keys are not the ones the keystore tagged, or the keystore lacks a key the wallet holds. The wallet stays locked |
| `KEYSTORE_INVALID` | `KeystoreError` | Not a pearljs keystore, another version, scrypt parameters out of bounds, or an empty passphrase |
| `KEYSTORE_LOCKED` | `KeystoreError` | A secret was read or added while the keystore is locked, or `lock()` was called while an `unlock` was still deriving the key: that unlock fails and the keystore stays locked |
| `KEYSTORE_NO_SECRET` | `KeystoreError` | The keystore has no secret of that id |
| `KEYSTORE_SESSION_INVALID` | `KeystoreError` | `unlockWithSession` with something that is not a session, a session key that is not a 32-byte or AES-256-GCM unwrapping key, or a session its key does not open (another session's key, an altered wrap). The keystore stays locked |
| `KEYSTORE_SESSION_STALE` | `KeystoreError` | `unlockWithSession` with a session of another keystore, or of this one before its passphrase changed. Unlock with the passphrase |
| `KEYSTORE_SESSION_DISABLED` | `KeystoreError` | `exportSession` on a keystore or wallet unlocked without `allowSessionExport` |
| `KEYSTORE_PASSPHRASE_REQUIRED` | `KeystoreError` | `wallet.mnemonic()` without the passphrase on a wallet unlocked from a session. `wallet.mnemonic(passphrase)` checks the passphrase (`KEYSTORE_BAD_PASSPHRASE`) |
| `WALLET_LOCKED` | `WalletError` | Signing, adding a key or account, or changing the passphrase while the wallet is locked |
| `WALLET_WATCH_ONLY` | `WalletError` | Signing with a watch-only wallet or account, a keystore operation on a wallet that has none, or `prepareSend` or a send with a `signer` asked to spend an XMSS or imported key's coins, which only the keystore signs for |
| `WALLET_NOT_FOUND` | `WalletError` | `PearlWallet.open` on a store that holds no wallet |
| `WALLET_EXISTS` | `WalletError` | `create` or `restore` into a store that is not empty |
| `WALLET_WRONG_NETWORK` | `WalletError` | The wallet or backup is for another network than the backend |
| `WALLET_SCHEMA` | `WalletError` | The store was written by a newer pearljs, or holds an older schema and no `migrate` was given |
| `WALLET_UNKNOWN` | `WalletError` | An account, address, transaction, output or key the wallet does not have |
| `WALLET_DUPLICATE` | `WalletError` | An account, imported key or XMSS key the wallet already has |
| `WALLET_GAP_LIMIT` | `WalletError` | Another receive address would leave more unused addresses in a row than the gap limit, past which a restore stops looking |
| `WALLET_NOT_REPLACEABLE` | `WalletError` | `bumpFee` on a transaction that is not a pending send of this wallet, did not signal replacement, has children, cannot reach the fee replacement needs, or has no change and no other confirmed coin to pay a higher fee with |
| `WALLET_BROADCAST_REFUSED` | `WalletError` | The node refused a send in a way that leaves it out of its mempool (a rule rejection, an orphan, undecodable bytes) or a backend's policy check failed; it was taken back out and its coins are free. The node's error is the cause. A node that answers that it already has the transaction has not refused it. Only a backend whose refusals are final (`broadcastRefusalsFinal`) gives it; from any other, a refusal is `WALLET_BROADCAST_UNCERTAIN` |
| `WALLET_BROADCAST_UNCERTAIN` | `WalletError` | A broadcast failed without a certain refusal (a dropped connection, an HTTP error, an error code that proves nothing). The send stays recorded as not broadcast; call `refresh`, then `rebroadcast` |
| `WALLET_TRANSACTION_KNOWN` | `WalletError` | `abandon` or `cancelPrepared` of a transaction the backend holds in its mempool or a block: it may still confirm, so its coins stay spent |
| `WALLET_BACKUP_INVALID` | `WalletError` | `restore` was given something that is not a wallet backup, holds a record a wallet cannot read, or whose accounts and keys are not the ones the keystore authenticated. Nothing was written |
| `WALLET_NOT_PREPARED` | `WalletError` | `submitSigned` was given a transaction that is not a prepared send this wallet still holds: never prepared here, cancelled, expired, changed after it was prepared, or spending an output that is no longer the wallet's |
| `WALLET_CLOSED` | `WalletError` | A wallet used after `close` |

### Mining and proofs

| Code | Class | When |
| --- | --- | --- |
| `MINING_TEMPLATE_INVALID` | `PearlError` | `blockSkeleton`: a block template that disagrees with itself (a transaction that does not hash to its id, a witness commitment or target other than the one computed, a certificate version the network does not need at that height, ancestor headers that do not chain), or one without `coinbasevalue` |
| `JACKPOT_ABOVE_TARGET` | `PearlError` | `checkJackpot`, `checkRankPenalty` or `checkBlockWork`: a certificate's hash_jackpot is above the bound for the bits it was checked against. For a share, it is not a share |
| `GATEWAY_MESSAGE_INVALID` | `PearlError` | The `pearljs/gateway` codec was given a line that is not a message of pearl-gateway's protocol, or a field of the wrong type or size |
| `PROOF_VERIFIER_UNAVAILABLE` | `PearlError` | `pearljs/verify-proof` could not read, compile or load its WebAssembly module or a circuit cache, or a file's SHA-256 is not the one pinned in the package |
