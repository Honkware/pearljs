# Recorded runs

These are runs of the checks in [Compatibility verification](verification.md), with their versions, counts and timings.

## fp8-scheme live run, 2026-11-18

At commit 1dd75a52 the live suite passed 242 of 245 tests on its first run. Three failed:

- A 20-block `generate` outlasted undici's 300-second wait for response headers.
- A test after it met the blocks that `generate` went on mining.
- One connection timed out on a machine busy proving.

With five blocks in that `generate`, both files passed when run again beside the blocks, consensus, node-access, kit-and-follower and simulated-fidelity files.

## Blockbook live test

The mainnet blocks checked were at heights 1, 71934, 71935, 91630, 96251, 98999, 99000 and 145341. The testnet2 blocks were around each of its forks, FP8 at 150283 included.

## Blockbook servers, 2026-11-19

Measured against Pearl's servers that day:

- Pearl's testnet server ran without the extended index.
- Both servers answered the websocket's `estimateFee` with "EstimateSmartFee: not supported".
- Pearl's public Blockbook sent no `Access-Control-Allow-Origin` header on its REST API, and answered a CORS preflight with HTTP 400.
- A new wallet's first sync, `findUsed` over 500 addresses, took 80 to 86 seconds against the mainnet server with one request in flight. A later sync of the same wallet took some 45 requests and 7 seconds.
- With `useXpub`, the first sync of a new, unused account took 5 requests and 1.4 seconds against mainnet, and 5 requests and 1.6 seconds against testnet2. A later sync took 5 requests on each.

## Websocket-only Blockbook backend, Chrome 157

The page ran from `http://localhost` against the simulated Blockbook, bridged to a real websocket. Its REST endpoint, like Pearl's, answered every request with HTTP 400 and no CORS headers. The page made no REST request, synced a wallet to the right balance, sent, and saw the send confirm.

## Mainnet walk, 2026-11-20

Against pearld 1.5.7, at heights 0 to 145833:

| Measure | Result |
| --- | --- |
| Transactions parsed, round-tripped and hashed | 1,226,430 |
| Inputs `verifyTransaction` accepted | 16,761,042: 16,742,722 key-path spends and 18,320 script-path spends over 11,856 distinct leaves |
| Mined transactions `checkStandard` passed | All 1,080,596 |
| Addresses checked through `filterBackend` | 30, among them a pool payout address with 1,311 coins |
| Addresses where `blockbookBackend` agreed | 23 |
| P2MR addresses checked through `pearldBackend` | 4 |
| `followChain` | 37 new blocks in 130 minutes |

## Mainnet proofs

In one process `verifyBlockProof` accepted 409 V1, 236 V2 and 484 V3 proofs, with medians of 66, 67 and 95 ms.

## Mainnet funded run, 2026-11-21

Against pearld 1.5.7, in blocks 146362 to 146404:

| Measure | Result |
| --- | --- |
| Tests | 33 passed and 3 skipped: Oyster's `verifymessage` and the two Blockbook comparisons |
| Transactions the files broadcast | 23: 22 confirmed, and one replaced by its own fee bump |
| Moved into the test wallet | 0.5 PRL |
| Returned at the end | 0.4999445 PRL, so the run cost 5,550 grain in fees |
| Time | 2 hours 41 minutes |

The run itself passed 32 tests. The other one checked that an exported key starts with `c`, which holds on the test networks and not on mainnet, where it starts with `K` or `L`. It failed before it reached the node. With that check corrected, the file passed when run again.

## Browser extensions

Both `worker` builds ran in Chrome 157 as an MV3 service worker; the esbuild build also ran as a Firefox 154 event page. In a worker on an Apple M2 Max, `PearlWallet.unlock` ran scrypt in 0.6 to 0.8 s at the default N = 2^18, and unlocking from a session took about 1 ms.

## Session unlock in an extension

In Chrome 157, a real MV3 extension's worker held a `PearlWallet` on IndexedDB:

- It unlocked and stored the session.
- DevTools' `ServiceWorker.stopAllWorkers` stopped the worker, and a message woke it.
- It unlocked from the session in 1 ms and sent a transaction.
- A session with another key or an altered wrap gave `KEYSTORE_SESSION_INVALID`, and one from before a passphrase change `KEYSTORE_SESSION_STALE`.
- After the browser was closed and started again on the same profile, `chrome.storage.session` was empty and the IndexedDB session still unlocked the wallet.

## Keystore unlock times

The unlock times in [Scrypt cost](../reference/wallet-storage.md#scrypt-cost) were measured with `Keystore.unlock`, timed with Node 22.17 on an Apple M2 Max under macOS 14.3. Each is the median of five unlocks at each cost. The machine had other work running. With more of it, the same unlocks took about 1.5 times as long, 1.1 s at the default.

## Websocket keep-alive

In Chrome 157, a worker subscribed to blocks on a pearld-shaped websocket that sent nothing of its own. Without `keepAlive` it was stopped within 75 seconds. With `keepAlive: 10_000` it was the same worker after 75 seconds, its subscription still open.

## Earlier versions

A 32-bit build of the verifier once mishandled the matrix sizes of 254 real testnet2 blocks; `test/network/proofs.test.ts` keeps three of them. `test/mainnet-blocks/` holds mainnet blocks and coinbase scripts an earlier pearljs got wrong, each the smallest case that shows it.
