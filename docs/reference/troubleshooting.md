# Troubleshooting

Look up an error message here to find what causes it and what to do. Messages are quoted as the code writes them; `<...>` marks a part that varies. In code, match on the `code` in the second column, not on the text: messages may gain detail, codes do not change ([Errors](errors.md)). A row without a code is a `TypeError` or `RangeError` for a mistake in the calling code, or something a node says.

## Connecting to pearld or Oyster

Every RPC failure is a `PearlRpcError`. Look at `code` (or `kind`, which says the same) first, then `rpcCode` or `status` ([Node and wallet RPC](../guides/rpc.md#errors)).

| Message | Code | Cause | Fix |
| --- | --- | --- | --- |
| `TLS certificate of <host> is not trusted (DEPTH_ZERO_SELF_SIGNED_CERT); pass a fetch or dispatcher that trusts the server's rpc.cert` | `RPC_NETWORK` | The server's self-signed certificate is not trusted | Pass `fetch: pearldFetch({ ca })` from `pearljs/tls-fetch` with the certificate, or set `NODE_EXTRA_CA_CERTS` ([TLS](../guides/rpc.md#trust-the-nodes-certificate)) |
| `connection refused by <host>; is the server running with RPC enabled on that port?` | `RPC_NETWORK` | Nothing listens there | Check the port against `PEARLD_RPC_PORTS` or `OYSTER_RPC_PORTS`. Oyster's regtest port is 18332 and pearld's 18334, which are easy to swap. pearld only enables RPC when it has an RPC user and password |
| `<host> rejected the RPC username or password (HTTP 401)` | `RPC_HTTP` | Wrong credentials | They are the server's `--rpcuser` and `--rpcpass` (Oyster: `--username`, `--password`). There are no cookie files |
| `<host> serves TLS; use an https:// URL (HTTP 400)` | `RPC_HTTP` | Plain HTTP sent to a TLS port | Use `https://` |
| `TLS handshake with <host> failed (ERR_SSL_WRONG_VERSION_NUMBER); if the server runs with notls or noservertls, use an http:// URL` | `RPC_NETWORK` | TLS sent to a plain port, such as the desktop wallet's Oyster | Use `http://`, or `desktopOysterClient` |
| `TLS handshake with <host> failed (ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION); the server needs a newer TLS version, and Oyster only speaks TLS 1.3` | `RPC_NETWORK` | The client offered TLS 1.2 to Oyster | Allow TLS 1.3 in the client |
| `refusing to send the RPC password to <host> over http://, which is not encrypted; use TLS or set allowInsecureAuth` |  | Basic auth over plain HTTP to a host that is not loopback | Use TLS. Set `allowInsecureAuth` only on a network you trust |
| `invalid RPC URL (not shown, since it may hold credentials)` |  | The URL does not parse | Check for an unencoded character in a password written into the URL; pass `username` and `password` separately |
| `<host> has too many RPC clients connected (HTTP 503)` | `RPC_HTTP` | pearld's client limit (`--rpcmaxclients`, 10 by default) is reached | Reuse one client, turn on `batch`, or raise the limit |
| `<host> is limiting the rate of requests (HTTP 429)` | `RPC_HTTP` | A public endpoint's per-IP rate limit is reached | Turn on `retry`, send one request at a time, and leave `batch` off |
| `no reply from <host> within 60000 ms` | `RPC_NETWORK` | The default timeout ran out | Raise `timeout` on the client or the call. `generate`, `importprivkey` and `getblocktemplate` have none by default |
| `Oyster does not accept JSON-RPC batches` |  | `batch` given to `OysterClient` | Remove it; Oyster reads one request per POST |
| `limited user not authorized for this method`, code -32603 | `RPC_ERROR` | The limited user (`--rpclimituser`) called a method outside its read-only list, `PEARLD_LIMITED_METHODS`. Among the methods pearljs uses it leaves out `sendrawtransaction`, `gettxspendingprevout`, `getblockchaininfo`, `getmempoolinfo`, `testmempoolaccept` and the `stopnotify` commands; `isLimitedUserRefusal` recognizes the refusal | The backends read with the limited user already. To broadcast, give the backend a `broadcast` endpoint with full credentials; for the rest, use the admin user ([Choosing a backend](../start/choosing-a-backend.md)) |
| `Chain RPC is inactive`, code -1 | `RPC_ERROR` | Oyster runs in SPV mode, as the desktop wallet does, and the method needs its pearld connection: `getinfo`, `listsinceblock`, `signrawtransaction`, and everything passed through | Use the wallet's own methods, such as `sendMany`, or point Oyster at a pearld |
| A `fetch` failure in a browser with no reply |  | CORS. Neither server sends CORS headers | Go through a same-origin proxy ([Browsers and bundlers](../guides/browsers-and-bundlers-node-access.md)) |
| `no WebSocket implementation available; pass one as WebSocket` |  | Node 20 has no global `WebSocket` | Pass `undici`'s or the `ws` package's constructor ([Websocket notifications](../guides/websocket.md#connect-from-node)) |

## pearld and Oyster through pearljs

| What you see | Why |
| --- | --- |
| `this backend needs pearld's address index; start pearld with --addrindex (...)`, a `MissingIndexError` | `searchrawtransactions` needs `--addrindex`. Wallet backends, discovery and the invoice adapter all use it |
| Code -5 from `getRawTransaction` for a transaction you know confirmed | pearld finds confirmed transactions only with `--txindex` (which `--addrindex` turns on). Without it, -5 says nothing about the transaction; `isUnknownTransaction` knows the difference |
| `estimateFee` returns 0n, or fails with code -1 | pearld has not seen transactions confirm yet, or has connected fewer than three blocks. Use a backend's `estimateFeeRate`, which never goes under the relay fee, or floor it yourself at `DEFAULT_RELAY_FEE_RATE` |
| `getTxOut` still reports an output you just spent | `gettxout` does not count spends that are in the mempool. Ask `getTxSpendingPrevOut`, or a backend's `getSpendStatus` |
| `getBlockWithTransactions` has no `tx` field | pearld puts decoded transactions under `rawtx` |
| `sendToAddress` fails without a fee rate | Oyster requires one, in grain/kvB |
| `submitBlock` throws code -25 with `rejected: ...` | pearld returns a refusal as a successful string; the client turns it into an error |
| `generate` takes minutes on regtest | Regtest has no mining shortcut. Every block carries a real ZK certificate, a few seconds each |
| Oyster's `listUnspent` is missing coins | It leaves out immature coinbase outputs and outputs locked with `lockUnspent` |
| A send through `fallbackTransport` fails saying the node already has the transaction | The first server took it before timing out. Treat it as sent |
| Amounts off by a factor of 100,000,000 through `call` | A bare bigint param is sent as an integer. Wrap amounts in `prlAmount(grain)`, and name result keys in `amounts` to get grain back |

## pearld and Oyster behaviour

These come from pearld and Oyster themselves, not from pearljs. The paths in the second column are in Pearl's source.

| What you see | Why | What to do |
| --- | --- | --- |
| `searchrawtransactions` accepts a P2MR address, then fails with an internal error | pearld's address index holds Taproot addresses only (`addrToKey`, `node/blockchain/indexers/addrindex.go:520`) | Use `pearldBackend`, which scans block filters for P2MR addresses |
| A `rescan` leaves out its end block | pearld's `rescan` stops before its end block (`scanBlockChunks`, `node/rpcwebsocket.go:2410`) | Name the block after the last one you need, or leave the end out to scan to the tip |
| `recvtx` or `redeemingtx` for a mined transaction arrives before `blockconnected` for its block | pearld sends them to a websocket client in that order (`node/rpcwebsocket.go:447`) | Take the block from the notification's own `block` field, which a mined transaction carries |
| Blocks given to pearld do not reach its fee estimator | Once the tip is more than a day old, pearld no longer counts itself as caught up (`node/blockchain/chain.go:1388`) | Do not rely on `estimateFee` on such a chain. A backend's `estimateFeeRate` never goes under the relay fee |
| `sendrawtransaction` refuses a transaction with -25 where you expected -26 | pearld answers a transaction that breaks a chain rule (sanity, input amounts, coinbase maturity, scripts) with -25. It also uses -25 for an orphan and for an internal failure. Only the mempool's own policy refusals get -26 (`handleSendRawTransaction`, `node/rpcserver.go:3577`) | Read the message to tell them apart. `PearlWallet` reads a -25 that is not an orphan as uncertain. It cannot meet one with a transaction it built, since it checks maturity and its own signatures first ([Send a payment](../guides/wallet-send.md#send-a-payment)) |
| A key-path spend is refused with no reason in the text | pearld reports a failed key-path signature as `scriptError(ErrTaprootSigInvalid, "")` (`node/txscript/taproot.go:118`) | Run the spend through `verifyInput`, which names `ErrTaprootSigInvalid` ([Script interpreter](../guides/interpreter.md)) |
| `testmempoolaccept` says `missing-inputs` | That is its name for an orphan (`node/rpcserver.go:3967`) | Treat it as an orphan |
| A standardness refusal starts with the transaction, not the rule | Standardness refusals name the transaction in front of the rule (`node/mempool/mempool.go:1636`) | Read past the transaction to the rule |
| `getaddednodeinfo` does not list a node you added | It lists an added node only once it is connected (`node/server.go:2237`) | Wait for the connection |
| Oyster answers a send it cannot fund with -32603 | Oyster reports insufficient funds as an internal error, -32603, never with the -6 its own command line tool looks for (`wallet/rpc/jsonrpc/methods.go:234`, `wallet/cmd/oystercli/ui.go:192`) | Do not match on -6. Read the message, since -32603 alone does not say the funds are short |
| `close()` on an Oyster websocket takes three seconds | Oyster answers a websocket close frame without ever closing the connection | Nothing to do. `close()` stops waiting after three seconds |

## Addresses and keys

| Message | Code | Cause | Fix |
| --- | --- | --- | --- |
| `invalid pearl address: <reason>` | `ADDRESS_MALFORMED`, `ADDRESS_BAD_CHECKSUM` | Not bech32m, a wrong checksum, mixed case, or not an address at all | Pearl has only bech32m P2TR and P2MR addresses. Use `isValidAddress` to check input without throwing |
| `address prefix tprl is not for mainnet` | `ADDRESS_WRONG_NETWORK` | An address for another network | Pass the network the address belongs to. `addressInfo(address)` lists the candidates |
| `unsupported witness version: <n>` | `ADDRESS_UNSUPPORTED_VERSION` | A witness version other than 1 or 2 | Not a Pearl address |
| An address validates on testnet when it was made for testnet2 |  | The two share the `tprl` prefix; regtest and simnet share `rprl` | Keep the network next to the address in your records ([Networks and addresses](../guides/networks-and-addresses.md#testnets)) |
| `invalid BIP39 mnemonic` | `MNEMONIC_INVALID` | A word outside the English list or a bad checksum | `parseSeedInput` returns the specific reason |
| `seed must be between 16 and 64 bytes (128 to 512 bits), got <n>` |  | Not a seed. Often a mnemonic string or entropy passed where the seed belongs | Pass `mnemonicToSeed(phrase)` |
| `extended key is invalid or its version bytes do not match network "<name>"` | `EXTENDED_KEY_INVALID` | An extended key for another network, or a Bitcoin `xpub` | Pearl mainnet keys start with `zpub`, testnet and regtest with `vpub` |
| `account node must sit at depth 3 (m/86'/coinType'/account'), got depth <n>` | `EXTENDED_KEY_INVALID` | Not an account-level key | Export the key with `extendedPublicKey()` |
| `watch-only accounts cannot be imported from an extended private key` | `EXTENDED_KEY_INVALID` | A private key given to `importWatchOnlyAccount` | Give it the public key; derive signing accounts from the seed |
| `key is not intended for <network>` | `WIF_WRONG_NETWORK` | A WIF key for another network | Mainnet and simnet have their own WIF bytes; the testnets and regtest share one |
| `Address index must be an integer between 0 and 2147483647; hardened indices are not permitted` |  | A negative, fractional or hardened index | |
| `this signing account has been destroyed` | `SIGNER_DESTROYED` | A signing method called after `destroy()` | Derive a new account from the seed |
| The first address differs from the one another wallet shows for the same phrase |  | A different network (the coin type is 808276 on mainnet and 1 elsewhere), a BIP39 passphrase, or a wallet that does not use BIP86 | Check `account.path` |

## Building payments

| Message | Code | Cause | Fix |
| --- | --- | --- | --- |
| `insufficient funds: <x> short (<y> spendable, <z> needed including a fee of <f>); <n> unspent outputs were left out as unconfirmed, immature or empty` | `INSUFFICIENT_FUNDS` | `InsufficientFundsError`. The outputs that may be spent do not cover the recipients and the fee | The last part names outputs that exist but were held back. Wait for confirmations, or pass `minConfirmations: 0`. Coinbase outputs need 100 confirmations |
| `insufficient funds` although the outputs listed cover the payment | `INSUFFICIENT_FUNDS` | An output with no `confirmations` counts as unconfirmed and is left out. Outputs written by hand often omit it | Set `confirmations`, or pass `minConfirmations: 0` |
| `unspent output <txid>:<n> does not pay the account's child 0/<i>` | `UTXO_INVALID` | The `index` or `change` on an `AccountUtxo` names the wrong child | Use the outputs `discoverAccount` returns, or fix the index |
| ``unspent output <txid>:<n> is P2MR and needs `p2mr` to name its tree and leaf`` | `UTXO_INVALID` | `payFromAccount` cannot spend a P2MR output without its tree | Add `p2mr: { tree, leafIndex }` ([P2MR](../guides/p2mr.md#spend-through-an-account)) |
| ``unspent output <txid>:<n> is P2MR and needs `spend` to say which leaf will be used`` | `UTXO_INVALID` | `buildPayment` cannot price a P2MR input without knowing the leaf | Add `spend: { type: 'scriptPath', tree, leafIndex, p2mr: true }` |
| `unspent output <txid>:<n> does not commit to the script tree given for it` | `UTXO_INVALID` | The tree is not the one behind that output | Rebuild the tree from the same scripts in the same order |
| `a change address is needed unless a recipient takes the maximum` | `PAYMENT_INVALID` | No `changeAddress` | Pass one, or use `amount: 'max'` |
| `the fee of <f> grain is under the <r> grain pearld requires to relay <v> vbytes; raise the fee rate` | `POLICY_FEE_TOO_LOW` | The fee rate is under the relay minimum of 1000 grain/kvB | Raise `feeRate`, or pass `relayFeeRate` if the node really runs lower. A rate given in grain per vbyte where grain/kvB is expected is 1000 times too low |
| `transaction output <n>: payment is dust: <value>` | `POLICY_DUST` | An output under the dust limit, 333 grain for P2TR and P2MR at the default relay fee | Send more, or drop the output |
| `nothing above the dust limit is left to send: ...` | `PAYMENT_INVALID` | A `max` payment whose fee eats everything | Nothing to sweep at this fee rate |
| `the unspent outputs contain duplicates` | `PAYMENT_INVALID` | The same outpoint twice in `utxos` | Deduplicate by `txid:vout` |
| `the signed transaction is not the one this payment built` | `TRANSACTION_MISMATCH` | `finalizePayment` was given a `signed` transaction with other inputs or outputs | Sign `payment.transaction` without changing it |
| `PSBT input <n> is not prepared: it has no witness UTXO. Prepare every input before signing any` | `INPUT_UNPREPARED` | An input was signed before every input was prepared | Call `prepareInput` for all inputs, then `signInput` for each |
| `PSBT input <n> names no child of this account in its tapBip32Derivation; pass index and change` | `DERIVATION_NOT_FOUND` | `signInput` was given no `index` and the input was not prepared for this account | Prepare the input with `prepareInput`, or pass the child |
| `PSBT witness UTXO does not match the account child` | `INPUT_MISMATCH` | `signInput` was told a child that does not hold that input | Pass the `index` and `change` of the child that received the output |
| The node rejects a transaction built by hand as spending a missing output |  | The `Transaction` class's own `addInput` takes the txid bytes reversed | Use `addInputByTxid` |
| The node rejects a multisig spend finalized with `psbt.finalizeAllInputs()` |  | That method leaves out the empty witness items Pearl requires | Finalize with `finalizePsbt` |

## P2MR, PSBT and script paths

| Message | Code | Cause | Fix |
| --- | --- | --- | --- |
| `this spend needs the previous transactions (previousTransactions) to check input values before signing; set trustPrevouts to skip the check` | `PREVIOUS_TRANSACTIONS_MISSING` | Every input is P2MR and no previous transactions were given | Pass the transactions that created the spent outputs ([P2MR](../guides/p2mr.md#previous-transactions)) |
| `this spend needs the previous transaction (nonWitnessUtxo) of every input to check input values before signing; set trustPrevouts to skip the check` | `PREVIOUS_TRANSACTIONS_MISSING` | The same, in a PSBT | Give `previousTransaction` to `prepareP2mrScriptPathInput` for every input |
| `input <n> is missing the previous transaction it spends` | `PREVIOUS_TRANSACTIONS_MISSING` | `previousTransactions` lacks the one for that input | Add it |
| `prevout <n> does not match its previous transaction` | `PREVOUT_MISMATCH` | The script or value in `prevouts` is not what that transaction's output holds | Fix the value; it is in grain |
| `transaction pays a fee of <f> grain, above the <l> grain that maxFeeRate (...) allows for <v> vbytes; check for a missing change output, or raise maxFeeRate to sign it` | `FEE_TOO_HIGH` | The fee guard of the raw-transaction P2MR and XMSS signers | Usually a missing change output. Otherwise pass a higher `maxFeeRate` |
| `transaction outputs (<o> grain) exceed its inputs (<i> grain)` | `OUTPUTS_EXCEED_INPUTS` | Outputs add up to more than `prevouts` | Check the values |
| `the leaf script does not contain the signer key` | `INPUT_MISMATCH` | The signer's key is not pushed by that leaf | Sign with the child whose `derivePublicKey` is in the leaf; that is the untweaked key |
| `PSBT input <n> asks for sighash type 0x<t>, which is not in allowedSighashTypes` | `SIGHASH_NOT_ALLOWED` | The PSBT names a sighash type other than SIGHASH_DEFAULT | Only if you mean to sign with it, list it in `allowedSighashTypes` ([PSBT workflows](psbt-checks.md#sighash-types-a-signer-accepts)) |
| `multi_a leaf has <a> of the <k> signatures it needs` | `SIGNATURES_MISSING` | Not enough co-signers have signed | Collect more signatures before finalizing |
| `PSBT input <n> has an invalid script-path signature for key <key>` | `SIGNATURE_INVALID` | A signature in the PSBT does not verify, usually because the transaction changed after it was made | Have that signer sign again |
| `PSBT input <n> has no tap leaf with that hash` | `INPUT_MISMATCH` | The leaf was never added to the input | Call the prepare function for that leaf first |
| `invalid PSBT: <n> bytes follow the last map`, `invalid PSBT: a length is a non-canonical varint` | `PSBT_MALFORMED` | A PSBT that Pearl's parser would refuse | Have the sender produce a canonical PSBT |
| `PSBT must be canonical padded base64` | `PSBT_MALFORMED` | Hex, base64url, or missing padding | Convert to standard base64 |
| Pearl's own tools reject a PSBT that pearljs wrote |  | It has a P2MR input, which Pearl's psbt package cannot parse or finalize | Finalize with pearljs and hand Pearl the transaction |
| `psbt.txOutputs[i].address` shows an address with another chain's prefix |  | The `Psbt` class knows no Pearl network | Use `psbtOutputs(psbt, network)` |
| `script word "12" is ambiguous: write OP_12 for the number or 0x12 for a one-byte push` | `SCRIPT_INVALID` | `scriptFromAsm` was given `decodescript` output containing 10 to 16 | Print with `scriptToAsm(script, { unambiguous: true })`, or edit the word |

## XMSS

| Message | Code | Cause | Fix |
| --- | --- | --- | --- |
| `this XMSS key has used all 31 of its signatures` | `XMSS_INDEX_EXHAUSTED` | The key is spent | Nothing more can be signed with it. See [the limit](../concepts/xmss.md#signature-limit) |
| `XMSS index state file <path> is locked by process <pid> on <host>; ...` | `XMSS_STORE_LOCKED` | Another store has the file open, or a process died holding the lock | Do not delete the lock file. Open with `breakStaleLock: true` when the message says the process is gone, or with `breakLock: true` once you are certain it is ([XMSS](../guides/xmss-store.md#recover-from-a-crash)) |
| `XMSS index state file <path> does not exist; pass create: true only for a key that has never signed` | `XMSS_STORE_INVALID` | A wrong path, or a lost state file | Fix the path. If the file is lost, do not recreate it for a key that has signed ([After a crash](../guides/xmss-store.md#recover-from-a-crash)) |
| `XMSS index state file <path> already exists; open it without create` | `XMSS_STORE_INVALID` | `create: true` on an existing file | Drop `create` |
| `XMSS index state file <path> belongs to a different key` | `XMSS_STORE_INVALID` | One file used for two keys | One file per key |
| `XMSS index state file <path> is not valid; refusing to guess the next index` | `XMSS_STORE_INVALID` | The file is damaged | Treat the state as lost |
| `XMSS index store returned index <i> after index <j>; refusing to reuse a one-time index` | `XMSS_INDEX_REUSE` | The store went backwards: restored from a backup, or two stores for one key | Stop signing with the key and find out which indices were used |
| `XMSS index <i> already signed a different message for this key; a key must have exactly one index store` | `XMSS_INDEX_REUSE` | Two signers in one process were given separate stores | Share one store |
| `the leaf script is not the XMSS leaf of the signer key` | `INPUT_MISMATCH` | The leaf belongs to another XMSS key | Use the signer whose `publicKey` is in the leaf |

## Wallets and stores

| Message | Code | Cause | Fix |
| --- | --- | --- | --- |
| `the transaction would pay a fee of <f> grain, above the <l> grain that maxFeeRate (<r> grain per 1000 vbytes) allows for <v> vbytes; pass a lower feeRate, or raise maxFeeRate to pay it` | `FEE_TOO_HIGH` | A wallet `send`, `bumpFee`, `sweep` or `prepareSend` would pay more than the fee ceiling, 5,000,000 grain/kvB unless given. Nothing was signed | Check the `feeRate` passed. To pay that much on purpose, pass a higher `maxFeeRate` with the call ([Send a payment](../guides/wallet-send.md#send-a-payment)) |
| `the backend estimates a fee rate of <r> grain per 1000 vbytes, above maxFeeRate <m>; pass feeRate, or raise maxFeeRate to pay it` | `FEE_TOO_HIGH` | No `feeRate` was given and the backend's estimate is above the ceiling | Pass `feeRate` yourself, or find out why the node estimates so high |
| `broadcasting <txid> failed and it may have reached the node; it stays recorded as not broadcast. ...` | `WALLET_BROADCAST_UNCERTAIN` | The connection dropped or the node answered with something that proves nothing. The send's coins stay taken | Call `refresh()` to see whether the backend has it, then `rebroadcast()`. Do not pay the same recipient again with other coins until you know ([Handle a failed broadcast](../guides/wallet-send.md#handle-a-failed-broadcast)) |
| `transaction <txid> is in the backend's mempool and may still confirm, so its coins stay spent` | `WALLET_TRANSACTION_KNOWN` | `abandon` of a transaction the backend holds, in its mempool or a block | Nothing to abandon: it may confirm. To replace it, `bumpFee` it if it signalled replace-by-fee |
| `prepared transaction <txid> was broadcast and the backend holds it, so its coins stay held; the next sync records it` | `WALLET_TRANSACTION_KNOWN` | `cancelPrepared` after the signer already broadcast the signed transaction | Sync; the wallet records it as a send |
| `wallet store <path> is locked by process <pid> on <host>; ...` | `STORE_LOCKED` | Another process or store has the wallet open, or a process that was killed left its lock | Close the other one. The message says whether `breakStaleLock: true` would take the lock; use `breakLock: true` only when you are certain its holder is gone. Never delete the lock file ([Restart](../guides/wallet-restart-and-backup.md)) |
| `wallet store <path> is no longer locked by this store: its lock was removed or taken over. Nothing was written; reopen the store` | `STORE_LOCKED` | Something took the lock while this store held it | Find the other writer before reopening; two writers must never share a wallet |
| `wallet <name> is open in another tab or worker; two writers must never share a wallet` | `STORE_LOCKED` | The IndexedDB store is open in another tab | Use the wallet from one tab, and have the others ask it |
| `wallet store <path> already has revision <n>, which this store did not write: ...` | `STORE_CONFLICT` | A second writer got into the store | Nothing was written. Stop the other writer, then reopen |
| `wallet store <path> has moved past revision <n>, which this store held: ... This write may or may not have been applied; reopen the store to see` | `STORE_CONFLICT` | Another writer committed while this store was writing, and the store cannot tell whether its own write was built on | Stop the other writer, reopen the store and read back what you wrote before writing it again |
| `the wallet was unlocked from a session; give the passphrase to read the recovery phrase` | `KEYSTORE_PASSPHRASE_REQUIRED` | `wallet.mnemonic()` on a wallet unlocked with `unlockWithSession` | Pass the passphrase, `wallet.mnemonic(passphrase)` ([Sessions](../concepts/security.md#sessions)) |
| `XMSS key <key> was restored from a backup and may have signed since it was taken; call burnXmssIndices ...` | `XMSS_KEY_RESTORED` | Every XMSS key comes out of `restore` frozen | Sync, then `burnXmssIndices(id, { nextIndex })` past every index the key may have used ([XMSS keys](../guides/wallet-xmss-keys.md)) |
| `XMSS key <key> was restored and the wallet has not synced since; sync first, ...` | `XMSS_KEY_RESTORED` | `burnXmssIndices` before the first sync after a restore | Call `sync()` first, so the indices on chain are known |
| `XMSS key <key> has signed on chain with index <i>, at or past its stored next index; the wallet state is older than the key. ...` | `XMSS_KEY_BEHIND` | The store is older than the key: a backup, a copied store or a snapshot | Burn past `highestOnChain` with a margin, and find out where the newer copy of the store went |

## Wallet backends

| Message | Code | Cause | Fix |
| --- | --- | --- | --- |
| `the node's tip is at height <h> and the cross-check endpoints' at <h...>, more than crossCheckLag (<n>) blocks apart` | `CROSS_CHECK_FAILED` | A `crossCheck` endpoint of `filterBackend` is behind the node, or ahead of it | Usually passes once the slower node catches up. If it persists, check that endpoint, or raise `crossCheckLag` |
| `cross-check endpoint <n> could not be asked: ...` | `CROSS_CHECK_FAILED` | The endpoint is down, refuses the credentials, or lacks the filter index | Fix the endpoint; the backend does not scan without it ([Trust](../concepts/compact-filters-scan.md#trust)) |
| `cross-check endpoint <n> has block <hash> at height <h>, where the node has <hash>` | `CROSS_CHECK_FAILED` | The node and the endpoint are on different chains: a reorganization still spreading, or one of them is lying | Sync again in a few blocks. A disagreement that stays is the case `crossCheck` exists for: trust neither until you know which is right |
| `cross-check endpoint <n> has filter header <h> for block <hash>, where the filters chain to <h>` | `FILTER_HEADER_MISMATCH` | The node's filters are not the ones the endpoint holds for the same block | Treat the node as untrustworthy |
| `block <hash> at height <h> does not follow block <hash> at height <h-1>` | `BLOCK_HEADER_INVALID` | Headers that do not chain. From the P2MR scan of `pearldBackend`, a reorganization during the scan; from `filterBackend`, which retries across a reorganization, a node contradicting itself | Query again. From `filterBackend`, stop trusting the node |
| `block <hash> at height <h> has bits <bits>, outside the network's proof-of-work limit`, `... has time <t>, not after its parent's <t>` | `BLOCK_HEADER_INVALID` | A header pearld would refuse, from a node on another network or one that makes up blocks | Check that the backend's network is the node's |

## Messages

| Message | Code | Cause | Fix |
| --- | --- | --- | --- |
| `message is <n> bytes, more than the 80 Oyster can sign` | `MESSAGE_INVALID` | The UTF-8 encoding is over 80 bytes | Sign a hash of the text |
| `message has a lone surrogate, which has no UTF-8 encoding` | `MESSAGE_INVALID` | A malformed JavaScript string | Pass `message.toWellFormed()` if you want Oyster's reading |
| `verifyMessage` returns false for a signature you believe is good |  | It answers false for anything that is not a valid key-path signature for that address on that network: a P2MR address, another network's address, a script-path signature | Check the address and the network; only P2TR addresses sign messages |
| A signature from a standard BIP-322 tool returns false |  | Oyster's format is not standard BIP-322 | Sign with Pearl software |
| Two signatures of the same message differ |  | Fresh auxiliary randomness in each | Verify them; do not compare text |

## Websocket

| What you see | Why |
| --- | --- |
| A `PearlRpcError` of kind `http`, status 401, on the first call | Wrong credentials. pearld disconnects without a reply, and the client reports it this way |
| The connection fails at once with `auth: 'header'` | pearld refused the credentials with HTTP 401 before the upgrade, which a WebSocket reports only as a failed connection |
| Calls fail with kind `network` in the middle of a session | The connection dropped. The client reconnects and resubscribes; calls in flight are not repeated |
| Notifications are missing after a reconnect | Those sent while the client was away are lost. Catch up with `rescanBlocks` ([Reconnecting](../guides/websocket.md#handle-reconnects)) |
| A notification command is refused on Oyster | Oyster's websocket only answers calls. Notifications come from pearld, and `OysterWsClient` refuses those commands. Do not send them through `OysterClient.call` either: Oyster passes them to pearld on the connection its own notifications arrive on. After `stopnotifyblocks` Oyster no longer follows the chain, and `notifyblocks` does not bring it back, because the next block does not connect to the last one it stored |

## Blocks

| What you see | Why |
| --- | --- |
| `checkCertificateBinding` throws for a genesis block | The five genesis blocks are hardcoded in Pearl and do not carry a bound certificate |
| `parseBlock` throws `<n> unexpected bytes after the last transaction` | The data continues after the block. Pass exactly the bytes `getRawBlock` returns |
| Regtest difficulty is tiny next to mainnet's | Regtest and simnet use a different `powLimitBits`, so the numbers are not comparable |

## Bundling and importing

| What you see | Why |
| --- | --- |
| A bundler error on a `.wasm` import | The secp256k1 code pearljs signs with is WebAssembly. Add the bundler's WebAssembly support; with Vite, vite-plugin-wasm ([WebAssembly](../guides/browsers-and-bundlers.md#load-the-webassembly)) |
| `node:fs` cannot be resolved in a browser build | `pearljs/xmss-file-store`, `pearljs/store-file` or `pearljs/testing-regtest` was imported. They are for Node only |
| TypeScript cannot find `pearljs/amount` or its types | `moduleResolution` is `node10`. Use `node16`, `nodenext` or `bundler` |
| `ERR_REQUIRE_ESM` | `require()` of an ES module on a Node older than 20.19 or 22.12 |

## Invoices

| What you see | Why |
| --- | --- |
| An invoice stays `awaiting` although it was paid | The chain view does not see the payment: pearld without `--addrindex`, a different network, or an Oyster backend asked about an address that is not in its wallet |
| `invoice address is not valid on <network>: ...` | The address belongs to another network than the monitor's |
| A `confirmed` invoice went back to `confirming` | A reorganization. Confirmations are recomputed on every refresh |
| `conflicted` | A payment that counted has disappeared: replaced, or dropped from the mempool. Look at it by hand |
| `chain backend returned ... without a valid height` | A custom `ChainClient` returned a malformed tip or block |
