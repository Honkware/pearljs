# Live regtest suite

`npm run test:live` runs the tests in `test-live/` against a real pearld on regtest, and against Oyster when one is given. Every test talks to the servers through `PearldClient` and `OysterClient`. The suite runs against either branch of Pearl.

## Build and run

The suite builds nothing. Build the binaries from a Pearl checkout as its Taskfile.yml does, with Rust and Go 1.26.10:

```sh
cd /path/to/pearl
(cd zk-pow && cargo run --release --no-default-features --bin build_cache src/circuit/v2_cache.bin src/v1/v1_cache.bin)
(cd zk-pow/bindings/go && cargo build --release)
make -C xmss
export CGO_ENABLED=1 CGO_LDFLAGS_ALLOW='.*zk_pow_ffi.*'
go build -tags xmss,zkpow -o bin/pearld ./node
go build -tags xmss,zkpow -o bin/oyster ./wallet
```

With Task installed, `task build:pearld build:oyster` does the same.

Build from a path without spaces. jemalloc's `configure`, which the first cargo step runs, fails on one. Build a checkout under such a path through a symlink to it, with `CARGO_TARGET_DIR` set to the `target` directory of each crate through that symlink, so that cgo finds the library where `node/zkpow/verify.go` looks.

For the fp8-scheme branch, build the same way from that branch. Its cache step is `cargo run --release --no-default-features --bin build_cache src/v4/api/v4_cache.bin src/v2/circuit/v2_cache.bin src/v1/v1_cache.bin`.

Then point the tests at the binaries:

```sh
PEARLD=/path/to/pearl/bin/pearld OYSTER=/path/to/pearl/bin/oyster npm run test:live
```

Without `PEARLD` the tests are skipped with a message, and without `OYSTER` only the wallet tests are.

Three variables control the run's files:

- `PEARL_LIVE_DIR` picks where the temporary directory goes.
- `PEARL_LIVE_KEEP=1` keeps it, logs included.
- `PEARL_LIVE_CHAIN=/path/to/blocks.json` saves the 101 setup blocks on the first run and submits them again on later ones, which needs no proving.

pearld wipes its regtest database on every start, so a kept data directory would not do. The saved blocks are used for 20 hours and then mined again. pearld treats a chain whose tip is more than a day old as not caught up, and its fee estimator then ignores the blocks it is given.

## Harness

- pearld starts in a temporary directory, with RPC and P2P on 127.0.0.1 and no DNS seeds.
- It runs with `--txindex`, `--addrindex`, a limited RPC user and `--rejectnonstd`. Regtest relays non-standard transactions by default; mainnet does not.
- It runs with `--rpcmaxclients=64`. pearld answers HTTP 503 past 10 requests in flight, and one wallet sync sends 8 at once.
- Both servers run with their default TLS and the certificates they generate. The clients use an undici dispatcher that trusts those certificates.
- The harness mines 101 blocks to a pearljs address so the first coinbase matures.
- It stops pearld and Oyster when the run ends, failed or not.
- Each file makes its wallets from phrases of its own, since the files share one chain.

Several tests start a second pearld that peers only with the first:

- the reorganization;
- `--rejectreplacement`;
- nodes without indexes, for `filterBackend`, prevouts and cross-checks;
- nodes restarted under a websocket client;
- `startRegtest`'s own test.

A few start a second Oyster: restored seeds, SPV mode and an invoice account.

Global setup reads the certificate of block 1, and the tests take regtest as that pearld runs it. A pearld built from master needs V3 from block 1, and the network is then `customNetwork(networks.regtest, { forkHeights: { fp8: 0 } })`. One built from the fp8-scheme branch needs V4 from block 1.

## Run time

Regtest has no mining shortcut. `generate` runs pearld's built-in prover, and every block carries a real ZK certificate.

- On master each block carries a V3 certificate and takes about 3.5 seconds on an idle Apple M-series CPU. Setup takes around 6 minutes.
- The tests then mine some 370 blocks more on the suite's node and a few on others, and take about 28 minutes.
- On the fp8-scheme branch, blocks carry real V4 proofs of about 61 KB and take some 20 seconds each to prove. A full run there takes over three hours.

## Order of the files

Files run one at a time, in this order:

1. `fresh-chain.test.ts`.
2. `timelocks.test.ts`, while the median time past is still that of the setup blocks. On a freshly mined chain its 512-second lock is waited out, up to nine minutes.
3. The files that fill blocks, then the files that walk every block.
4. `reorg.test.ts` and the files that invalidate blocks.
5. The interpreter check.
6. `oyster-feed.test.ts`, which leaves Oyster without its block feed.
7. `coinbases.test.ts`, which reads every block of the run.

## Results

The vectors and the live tests together show what follows.

### Signing

- pearld accepts and mines BIP86 key-path spends pearljs builds.
- It mines P2TR script paths through PSBT, with checksig and multi_a leaves.
- It mines P2MR checksig leaves signed on the transaction, in single and multi-leaf trees.
- It mines P2MR script paths through PSBT: a single leaf, a leaf of a five-leaf tree and a 2-of-3 multi_a leaf.
- It mines P2MR inputs next to P2TR inputs, and XMSS leaves.
- `estimateVsize` matches pearld's vsize for each of these.
- Every non-default sighash type (ALL, NONE and SINGLE, each with and without ANYONECANPAY) verifies on key-path and P2MR checksig spends.
- pearld refuses those spends once the outputs change, unless the type is NONE. A SINGLE|ANYONECANPAY signature survives another input and output being added.
- The async signers produce P2TR and P2MR spends pearld mines, through PSBT and on the transaction. A hand-built two-key leaf signs through `signTapscriptUncheckedAsync`.
- One XMSS key signs at indices 0, 1, 2, 29 and 30, and pearld accepts each. pearljs refuses index 31 before anything is broadcast.

### Leaves and PSBT flows

- pearld holds `cltvScript` and `csvScript` leaves until the block where the lock matures, and mines them in it.
- The locks tried are a height and a median-time CLTV, a three-block CSV, and a 512-second CSV from `encodeSequence`. Each comes with pearld's refusal before maturity, and the script's own refusal of a lock of the wrong kind or length.
- `multiAScript` leaves spend through P2TR and P2MR for 1-of-1, 2-of-3, 3-of-5 and 17-of-18, whose threshold is a pushed number. They also spend with a signature too many.
- pearld relays and mines P2TR and P2MR script-path spends whose witness ends with an annex. It refuses them when the annex is changed, dropped or added after signing.
- Leaves with one and with two `OP_CODESEPARATOR`s are mined through P2TR and P2MR when each signature is made for the separator `codeSeparatorPositions` gives for its check. Every other assignment tried is refused.
- A BIP86 payment of three inputs is mined, signed through `signInputAsync` with `keyPathSigner()` as the device at SIGHASH_ALL.
- A key-path spend with an annex is mined.
- A two-signature hash lock, a CLTV leaf with a preimage and an OP_CAT leaf are mined on `p2trScriptOnly` and P2MR outputs. Each is co-signed through base64 and finalized with `finalizeScriptPathInput`.
- The second of two leaves a P2TR input lists is mined.
- The cold flow with `changeFrom` and `checkPsbtPayment` is mined. Its change lands on the recorded child, and change past `nextChangeIndex` plus `gapLimit` is refused.

### Relay policy and replacement

`checkStandard` gives the reason `testmempoolaccept` gives for each of these (`test-live/policy.test.ts`):

| Kind | Cases |
| --- | --- |
| Outputs | Dust, an unsupported output, two OP_RETURNs, an output or output total above the maximum amount, outputs above the inputs |
| Fee and size | A fee one grain under the relay fee, a transaction under 65 bytes, 100001 vbytes |
| Version and locks | Versions 0 and 3, height and time locks that are not final |
| Signature script | Not push-only, or over 1650 bytes |
| Inputs | Duplicate inputs, a null previous output, a lone coinbase |

- pearld accepts the standard counterparts. Among them are a transaction at exactly `relayFeeRate`, one of exactly 100000 vbytes, and an 80-byte `embed` output that it mines.
- A pearljs replacement replaces a signaling transaction at exactly `replacementFee`.
- `checkReplacement` gives pearld's reason one grain under that fee, at an equal fee rate, and when the original does not signal.
- pearld's block template orders a low-fee parent, its high-fee child and an unrelated transaction by each one's own fee rate. A child does not lift its parent there.
- The `maxFeeRate` guard refuses a P2MR spend that forgot its change, before a Schnorr signature is made or an XMSS index used.
- Signed on purpose, that transaction is flagged by `testmempoolaccept` only as `max-fee-exceeded`, and `sendrawtransaction` takes it.

`checkReplacement` and `checkPackageLimits` give pearld's reason, word for word, in each of these cases:

- A child signals only through its unconfirmed parent. pearld replaces it at exactly `replacementFee`.
- A replacement brings a new unconfirmed input, or spends what it replaces.
- A replacement would evict 101 transactions. pearld evicts 100.
- A 26th transaction joins an unconfirmed chain, or a 25th child joins one parent.
- A child takes its unconfirmed ancestors one vbyte past 101000. pearld takes the one that lands on it.
- Any replacement reaches a pearld started with `--rejectreplacement`.

pearld answers `sendrawtransaction` like this, and Oyster's `sendrawtransaction` passes each answer on with the same code and text:

| Case | Code and text |
| --- | --- |
| A duplicate in its mempool | -26, "already have transaction" |
| A duplicate in a block | -27, "transaction already exists" |
| An orphan | -25, "orphan transaction" |
| A broken rule | -26 |

The wallet counts the first two as sent and the last two as refused, and takes a refused send back out. `rebroadcast` gets a send pearld never received to it.

### Error codes

- Every `PolicyError` those comparisons raise carries the stable code [Errors](../reference/errors.md) gives it, next to pearld's own refusal.
- The codes seen are 17 `SANITY_*` and `POLICY_*` codes, six `RBF_*` codes and `PACKAGE_TOO_LONG`.
- `PearlRpcError` is `RPC_ERROR` with the number pearld or Oyster sent, for eleven kinds of refusal from pearld and six from Oyster.
- It is `RPC_HTTP` with the status, and `RPC_NETWORK` for a refused, untrusted, timed-out or aborted call.
- It is `RPC_RESPONSE` for a search told to stop short.
- These hold over HTTPS and over the websocket.
- An error survives `JSON.stringify` and `PearlError.fromJSON` with its code.

### Payments

- `payFromAccount` builds, signs and gets mined payments from key-path coins with change, a send-max, and a signalling payment and its replacement.
- It does the same for P2MR checksig coins, alone and next to a key path, with the vsize and fee `testmempoolaccept` reports.
- `InsufficientFundsError` names amounts pearld confirms at the grain.
- A coinbase is held back at 99 confirmations with pearld's own refusal, and spent at 100.
- `sweepWif` empties a key Oyster imported.
- `buildPayment`, fed Oyster's `listunspent`, picks the inputs, fee and change Oyster's `sendtoaddress` picks. This holds for one input, for several, and when a dust remainder goes to the fee.
- `inspectTransaction` agrees with `testmempoolaccept` and `getrawtransaction` on ids, sizes, fee, fee rate, inputs, outputs and addresses.
- The transactions inspected are a key-path spend, P2TR checksig and multi_a leaves, P2MR checksig and XMSS leaves, and transactions Oyster built.

### Hash timelocks

- An HTLC in a P2TR tree is claimed with its preimage, and another is refunded after its CLTV lock, refused one block earlier.
- The same holds for a P2MR tree with a CSV lock.
- The preimage is read back from the mined claim.

### Messages

- Legacy signatures equal pearld's byte for byte.
- Oyster's `verifymessage` refuses the other two formats. Its own format is under [Oyster interoperability](#oyster-interoperability).

### Oyster interoperability

- Oyster verifies pearljs message signatures, and signs messages pearljs verifies.
- Oyster derives the same BIP86 addresses from a mnemonic.
- Oyster imports a pearljs WIF at the address `keyPathAddress` predicts.
- Oyster lists and counts a pearljs payment (`listunspent`, `getbalance`).
- Oyster builds a `sendtoaddress` transaction that pearljs parses byte for byte, sizes exactly and finds standard.
- Wallets Oyster creates from a pearljs mnemonic of 12 or 24 words, or from a hex seed, hand out the receive and change addresses pearljs derives.

### Wallet sends

- `PearlWallet` in a file store over `pearldBackend` shows a payment pending and confirmed, with the node's fee, counterparties, block and balance.
- It sends with change it recognises, at the fee, inputs and outputs `getrawtransaction` shows.
- Two sends fired at once get different coins, and a third is refused for lack of one.
- `bumpFee` replaces a signalling send, and the wallet shows the original replaced.
- `bumpFee` replaces a send-max by paying the recipient less, and an exact send without change by bringing in another coin. pearld takes both replacements.
- A send pearld refuses is taken back out (`WALLET_BROADCAST_REFUSED`, with pearld's -26 as the cause).
- The wallet sends while a sync is held up.
- `PearlWallet` refuses a send (`FEE_TOO_HIGH`) at a rate above `maxFeeRate`, from the caller or from the backend's estimate, before anything is signed or recorded. It refuses an estimate that is not a positive rate.
- With `maxFeeRate` raised, it pays an absurd rate on purpose, at the fee and vsize `estimateSend` gave and pearld's mempool shows.
- `estimateSend` charges each rate on Oyster's size estimate, between the signed vsize and one vbyte more per input.

### Prepared sends and uncertain broadcasts

- `prepareSend` holds its coins and change address.
- `submitSigned` refuses a changed transaction. It takes the PSBT signed elsewhere, which pearld mines at the prepared fee.
- A watch-only wallet sends through `signingAccount.keyPathSigner()`.
- Payments signed elsewhere spend account coins only.
- `cancelPrepared` refuses once the signer has broadcast (`WALLET_TRANSACTION_KNOWN`), and the next sync records the send.
- A send whose reply is lost after pearld took it is `WALLET_BROADCAST_UNCERTAIN`. It cannot be abandoned while pearld holds it, and its coins are never offered again.
- A send abandoned while pearld never had it counts again once it is mined.

### Wallet sync, restore and reorganizations

- The wallet opens with the same balance and history after its process is killed mid-sync, once the stale lock is broken on purpose (`STORE_LOCKED` before).
- It restores from the keystore alone, and with a state backup, to the same coins.
- `watch()` over a `PearlWsClient` records a payment and its confirmation from pearld's notifications, with no sync in between.
- A reorganization takes a wallet's confirmed receive back to pending with a `reorg` event, and confirms it in the new block.
- The same reorganization orphans the replaced block's coinbase in a wallet watching the miner's account. A websocket client hears `blockdisconnected` and then the two blocks that replaced it.
- A payment double-spent in a reorganization made with `invalidateblock`, while the wallet's process was not running, is conflicted when the wallet is opened again. Its block is gone and the balance is pearld's, with the fork inside `reorgDepth` and nine blocks below it.
- A wallet finds a payment to an emptied old address within `quietSyncInterval` incremental syncs over `pearldBackend`, and at once from a websocket notifier.
- History pages, and their account and address filters, list what the address index lists.
- A backup whose account record names another key, with its origin or without, is refused (`WALLET_BACKUP_INVALID`), and nothing is written.

### Stores and XMSS keys

- With two Node processes on one store directory, the second is refused (`STORE_LOCKED`, naming the holder).
- A killed holder's lock is taken with `breakStaleLock` once its heartbeat is overdue, and not before.
- `breakLock` takes the store from a live holder, whose next send then fails before signing. The XMSS spends of all three holders are mined at indices 0, 1 and 2.
- The file-backed XMSS index store carries a key on at the next index when a new signer opens the same file, with every signature mined.
- A wallet's XMSS key is funded and spent twice over `pearldBackend`, which finds a P2MR address by block filters.
- Restored from a backup taken before the spends, the key is frozen (`XMSS_KEY_RESTORED`). A sync reads index 1 from the mined witnesses.
- Burning to an index on chain is refused. Burning past it lets the key sign a spend pearld mines.
- A copy of the old store file opened as current freezes as `behind`.

### A wallet beside Oyster

- Beside an Oyster holding the same mnemonic, a wallet restored from its keystore, with and without a backup, has Oyster's balance and coins.
- A send of Oyster's conflicts a pearljs send that never reached the node (`WALLET_BROADCAST_UNCERTAIN`). The wallet records Oyster's transaction as its own.
- A wallet over `oysterBackend` and `oysterTransactionSource` receives, sends, sends twice at once and bumps a fee.
- After each block Oyster's balance and coins equal the wallet's, once Oyster has been asked for each change address.

### Backends

- `pearldBackend` lists unspent outputs and balances before, during and after a mempool spend, and counts the last 99 coinbases as immature.
- `getSpendStatus` tells unspent, mempool-spent, block-spent and never-existed outputs apart.
- A pearld without `--addrindex` fails with `MissingIndexError`.
- `oysterBackend` gives the same outputs and balances for Oyster's addresses.
- `discoverAccount` on Oyster's mnemonic finds Oyster's addresses, outputs, balance and next change address. `payFromAccount` and `backend.broadcast` then spend from the account, and pearld mines it.
- A watch-only account made from an extended public key, with its origin and without, finds its coins through `pearldBackend`.
- It prepares a PSBT that crosses to the signing account as base64, is signed there with no index given, and is mined. An account for other keys finds none of its own in it (`DERIVATION_NOT_FOUND`).
- `oysterBackend` over an Oyster in SPV mode reads the wallet's coins, balance and history, and answers `unknown` for an output it does not hold.
- It falls back to Oyster's default fee rate, and refuses a raw broadcast with `BACKEND_UNSUPPORTED`.

### Filter backend and cross-checks

- `probePearld` reports what the admin and the limited user may do, on a node with indexes and on one without. `connectPearld` picks `pearldBackend` or `filterBackend` accordingly.
- `filterBackend`, as the limited user on the node without indexes, follows a payment and its spend through the mempool, a block and a reorganization.
- It goes on from a file store without fetching a block again, and broadcasts through the admin endpoint.
- It gives a wallet the balance, coins and history of the same wallet on `pearldBackend`. The exception is the fee of a payment received, which needs the parents that node cannot give.
- Real regtest blocks pass `filterBackend`'s header links, bits, timestamps, witness commitment and certificate checks.
- The limited user reads raw headers (`getRawBlockHeader`) over HTTP and the websocket.
- `crossCheck` scans to a second pearld's lower tip. It fails (`CROSS_CHECK_FAILED`) for one more than `crossCheckLag` behind, one on another fork and one that is down.
- An account, an imported key and an XMSS key added after a sync have their earlier payments found.

### RPC clients

- Every typed method of `PearldClient` and `OysterClient` returns what its types say from the real servers over TLS, with amounts in grains.
- `PearlRpcError` names a wrong password, an unknown method, and a limited user calling an admin method.
- It also names plain HTTP to a TLS port, a refused connection, an untrusted certificate and TLS 1.2 offered to Oyster.
- In the second RPC round, `getBlock` and `getBlockWithTransactions` on a block with a spend, and `getTxSpendingPrevOut` for a mempool spend, return what their types say.
- So do `getCFilter` with its header check, `getHeaders`, `getPeerInfo` with a real peer, and `getBlockTemplate`.
- `submitBlock` throws for a duplicate and for an altered block.
- A batch goes out as one request, and its failing entries fail alone. Oyster refuses a batch.
- `generate` runs past the 60-second default timeout, while a per-call timeout or abort gives up on it. pearld goes on proving, and refuses a second `generate` meanwhile.
- `fallbackTransport` answers from the second node once the first is stopped.
- A redirect in front of pearld, and a reply over `maxReplySize`, are refused.

These methods answer as typed:

| Server | Methods |
| --- | --- |
| pearld | `invalidateBlock`, `reconsiderBlock`, `getNetTotals`, `uptime`, `version`, `addNode` with `getAddedNodeInfo`, `getNodeAddresses`, `verifyChain`, `getGenerate` with `setGenerate`, `createRawTransaction` signed and sent, `signMessageWithPrivKey` |
| Oyster | `getAccountAddress`, `getReceivedByAccount`, `listReceivedByAccount`, `sendFrom` |

Oyster's own methods:

- `sendMany`, `getTransaction` and `listTransactions` carry the amounts and fee signs their types document after a real send.
- `lockUnspent` keeps an output out of a send.
- `rebroadcastTransaction` and `removeTransaction` work on a pending transaction. pearld keeps what Oyster forgets, and Oyster takes it back once mined.
- `getSyncProgress` answers from an Oyster in SPV mode, and with an error from one that follows pearld over RPC.

### Websocket

- `PearlWsClient` logs in to pearld over wss both ways, and reports a wrong password and an untrusted certificate.
- It delivers block, filtered-block and mempool notifications.
- It follows a payment to a watched address from the mempool into a block and on to its spend (recvtx, relevanttxaccepted, redeemingtx).
- It rescans blocks, serves the limited user, and gives the typed methods' results over the socket.
- It reconnects to a restarted node and resubscribes.
- The limited user drops its last block watcher, though pearld refuses it `stopnotifyblocks`.
- `rescan` replays a payment and its spend as `recvtx` and `redeemingtx` with their blocks, and ends with `rescanfinished`. It stops before the end block it is given.
- Against Oyster's `/ws`, the client answers calls with header auth and refuses notification commands. It closes although Oyster never ends the connection.

The client is also tested against frames written by pearld's own notification code (`vectors/wsfixtures_test.go`).

### Blocks and consensus

For every block of a run:

- `difficultyForBits` matches getblockheader and getdifficulty.
- `requiredCertVersion` and `checkCertificateRules` match the certificate.
- Each coinbase pays `blockSubsidy` plus the block's fees to the grain, and `totalSupply` is the sum.
- Every coinbase claims exactly its subsidy and fees, and starts with its height. A watch-only wallet over the miner's account keeps every one confirmed.
- getblocktemplate agrees about the next block.
- A filter pearljs builds from the raw block and the scripts it spends is pearld's `getcfilter`, byte for byte.
- The filter headers chain from genesis as `getcfilterheader` reports them, and `matchFilter` finds every script paid or spent.

`parseBlock` reads regtest blocks from getblock with the hash, merkle root, witness commitment, certificate binding and sizes pearld reports.

On an fp8-scheme pearld:

- Every V4 certificate it mines is keyed by the parent, with no ancestor headers. It binds, meets the certificate rules and has the size getblock counts.
- `checkCertificateBinding` refuses one given a wrong ancestor, at the depth Pearl's verifier names.
- getblocktemplate offers the four most recent headers, parent first, and asks for version 4.
- `SimulatedChain` mines certificates of the same version, length and ancestry.

### Mining and pearl-gateway

On a regtest pearld, `test-live/mining.test.ts` builds a skeleton from a template holding a witness spend, lets pearld mine the same template, and gets pearld's block byte for byte once pearld's certificate is sealed in; it then has pearld accept a block pearljs assembled, with its own payout and text, around a proof of its header from `zkpow.Mine`, the prover pearld itself uses (`vectors/mining/prove/main.go`, run when `PEARL_PROVER` names it).

`test-live/gateway.test.ts` runs Pearl's own pearl-gateway on that pearld, when `PEARL_GATEWAY` names its executable, with pearljs as the miner on its socket:

- The job the gateway hands out is the one `miningJob` builds from pearld's template.
- The gateway's answers to an unknown method and to bad parameters decode to its error codes.
- A plain proof mined for the job by `pearl_mining.mine` passes `verifyPlainProof`, and fails it at a harder target.
- The gateway turns the proof `submitPlainProof` sent into a block pearld accepts, whose proof `verifyBlockProof` accepts.

The same test runs against the fp8-scheme branch's gateway and pearld with V4 jobs: the ancestor headers the gateway sends are the ones `miningJob` gives, and the `PlainProofV4` is mined by zk-pow's CPU miner (`test-live/gateway-mine-v4.rs`, run when `PEARL_GATEWAY_MINER_V4` names it).

### Script interpreter

- The interpreter gave pearld's verdict on every transaction the suite put to its node: 367 that pearld accepted and 22 that its script engine refused.
- Each refusal was on the same input, with the engine's message (`ErrNullFail`, `ErrTaprootSigInvalid`, `ErrUnsatisfiedLockTime`).
- `debugInput` steps through a mined key-path spend, one step per opcode. It does the same for mined checksig, multi_a, XMSS, timelock, annex and code-separator leaves.
- The signature budget falls by 50 for a Schnorr check and 1000 for an XMSS one.

### Invoices

- `pearldChainClient` and `InvoiceMonitor` follow an invoice on a real node through unpaid, underpaid, seen in the mempool, confirming, confirmed and overpaid. They also expire one.
- They find every payment of an address across several `searchrawtransactions` pages, in the chain and the mempool.
- They take a confirmation back when a second node's longer chain replaces the block, then see it confirm again.
- An invoice paid in a block stamped before `expiresAt` counts, though the first refresh comes long after. One stamped at `expiresAt` does not.
- A payment moved by `invalidateblock` goes back to pending, and confirms in the replacing block.
- `watchInvoices` over a second pearld's websocket follows a payment from the mempool to confirmed across that pearld's restart.
- `fetchPayerInputs` names the inputs pearld has.
- `InvoiceIndexAllocator` stays within its gap, reuses an expired unpaid index and resumes from its stored state. An Oyster created from the same mnemonic finds every paid index.
- A P2MR invoice gets its block time from `pearldBackend`'s filter scan.

### Test kit and helpers

- `startRegtest` starts and stops pearld alone, and with Oyster on a given mnemonic.
- `trustingFetch` reaches pearld and refuses another certificate.
- `followChain` catches up, and hands back a block a reorganization took before the new branch.
- `followChain` is woken by the limited user's websocket ten minutes before its poll. It resumes from a stored cursor after a reorganization it did not see.
- `resolvePrevouts`, `prevoutsFromSearch` and `fetchMempool` answer with `--txindex`.
- Without `--txindex`, `resolvePrevouts` fails with `MissingIndexError` for a confirmed parent, while `fetchMempool` still works.
- One script of payments and refusals gets the same results from pearld and from `SimulatedChain`. The results compared are acceptance, RPC code, `sendrawtransaction` text, `testmempoolaccept` reason and websocket notifications.

The script's cases:

| Kind | Cases |
| --- | --- |
| Payments | A payment, a spend of a watched output |
| Conflicts | A duplicate, a double spend, an orphan, a mined duplicate |
| Replacement | A replacement one grain short, and one that pays enough |
| Refusals | A fee under the relay floor, a bad signature, a sequence lock, outputs above the inputs, duplicate inputs, version 3, an immature coinbase |

## Node quirks

The live tests found behaviours of pearld and Oyster that users run into; [Troubleshooting](../reference/troubleshooting.md#pearld-and-oyster-behaviour) lists them. Where each one sits in Pearl's source:

| Behaviour | Source |
| --- | --- |
| pearld's address index holds Taproot addresses only | `addrToKey`, node/blockchain/indexers/addrindex.go:520 |
| `rescan` stops before its end block | `scanBlockChunks`, node/rpcwebsocket.go:2410 |
| `recvtx` and `redeemingtx` for a mined transaction come before `blockconnected` | node/rpcwebsocket.go:447 |
| A tip more than a day old no longer counts as caught up | node/blockchain/chain.go:1388 |
| `sendrawtransaction` answers a chain-rule break with -25, and only mempool policy refusals with -26 | `handleSendRawTransaction`, node/rpcserver.go:3577 |
| A failed key-path signature carries no reason in the text | `scriptError(ErrTaprootSigInvalid, "")`, node/txscript/taproot.go:118 |
| `testmempoolaccept` calls an orphan `missing-inputs` | node/rpcserver.go:3967 |
| Standardness refusals name the transaction in front of the rule | node/mempool/mempool.go:1636 |
| `getaddednodeinfo` lists an added node only once it is connected | node/server.go:2237 |
| Oyster reports insufficient funds as -32603, never the -6 its command line tool looks for | wallet/rpc/jsonrpc/methods.go:234, wallet/cmd/oystercli/ui.go:192 |
