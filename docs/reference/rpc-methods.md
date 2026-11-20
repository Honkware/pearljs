# RPC methods

The [API reference](api.md) lists every method with its result type.

## Clients and mixins

The typed methods are one set, written as mixins over anything with `call`.

| Class | Carries the typed methods over |
| --- | --- |
| `PearldClient`, `OysterClient` | fetch |
| `PearlWsClient` | the websocket ([Websocket notifications](../guides/websocket.md)) |
| `PearldRpc`, `OysterRpc` | any other object with `call` |

The methods live on the abstract classes `PearldMethods` and `OysterMethods`. `pearldMethods(Base)` and `oysterMethods(Base)` put them on a class of your own that has `call`, such as a subclass of `JsonRpcClient`, the bare client the HTTP ones extend. `JsonRpcWsClient` is the same for the websocket: the connection, notifications and reconnects without the typed methods.

## pearld

| Group | Methods |
| --- | --- |
| Blocks | `getBlock` (with transaction ids), `getBlockWithTransactions`, `getRawBlock`, `getBlockHex`, `getBlockHeader`, `getHeaders`, `getBlockHash`, `getBlockCount`, `getBestBlockHash`, `getBestBlock`, `getBlockchainInfo`, `getChainTips`, `invalidateBlock`, `reconsiderBlock`, `verifyChain` |
| Transactions and outputs | `getRawTransaction`, `getRawTransactionHex`, `createRawTransaction`, `decodeRawTransaction`, `decodeScript`, `validateAddress`, `getTxOut`, `getTxSpendingPrevOut`, `searchRawTransactions`, `sendRawTransaction`, `testMempoolAccept`, `signMessageWithPrivKey` |
| Mempool and fees | `getMempoolInfo`, `getRawMempool`, `getRawMempoolVerbose`, `estimateFee` |
| Compact filters | `getCFilter`, which returns the filter decoded and checks it against `getCFilterHeader` when given the previous header ([Compact filters](../guides/compact-filters.md)) |
| The node | `getInfo`, `getNetworkInfo`, `getPeerInfo`, `getConnectionCount`, `getNetTotals`, `getNodeAddresses`, `getAddedNodeInfo`, `addNode`, `node`, `ping`, `getCurrentNet`, `uptime`, `version`, `debugLevel`, `stop` |
| Mining | `getMiningInfo`, `getNetworkHashPs`, `getDifficulty`, `getBlockTemplate`, `submitBlock`, `generate`, `getGenerate`, `setGenerate` |

That is every method in pearld's handler tables except `help`, and the websocket's commands are on `PearlWsClient`. A test compares the list with the tables read out of Pearl's source, so a method Pearl adds fails it until it is typed or listed as left out.

## Oyster

| Group | Methods |
| --- | --- |
| Addresses and accounts | `getNewAddress`, `getRawChangeAddress`, `getAccountAddress`, `listAccounts`, `createNewAccount`, `renameAccount`, `getAccount`, `getAddressesByAccount`, `validateAddress`, `keypoolRefill` |
| Balances | `getBalance`, `getUnconfirmedBalance`, `getReceivedByAddress`, `listReceivedByAddress`, `getReceivedByAccount`, `listReceivedByAccount` |
| Unspent outputs | `listUnspent`, `lockUnspent`, `listLockUnspent` |
| Sending | `sendToAddress`, `sendFrom`, `setTxFee`, and `sendMany`, which is what Pearl's desktop wallet sends with |
| Transaction lists | `listTransactions`, `listSinceBlock`, `getTransaction` |
| Signing and keys | `signRawTransaction`, `signMessage`, `verifyMessage`, `importPrivKey`, `dumpPrivKey` |
| Passphrase | `walletPassphrase`, `walletPassphraseChange`, `walletLock`, `walletIsLocked` |
| The wallet | `getInfo`, `getBestBlock`, `getBestBlockHash`, `getBlockCount`, `stop` |
| Pearl's additions | `getSyncProgress`, `chainSynced`, `removeTransaction`, `rebroadcastTransaction`, `listAddressTransactions`, `listAllTransactions` |

That is every method Oyster implements except `help`.

## Oyster methods without a wrapper

Oyster answers these eight with "unimplemented" or "unsupported", and they have no wrapper:

- `backupwallet`
- `dumpwallet`
- `encryptwallet`
- `getwalletinfo`
- `importwallet`
- `listaddressgroupings`
- `move`
- `setaccount`

## Transport options

### Timeouts

Three methods are slow by design and have no default timeout: `generate`, which proves every block it mines, `importprivkey`, which rescans, and `getblocktemplate`, which can long-poll. A call that runs out of time fails with kind `network` and a message such as `no reply from <host> within 60000 ms`.

### Retry

`retry` repeats a read-only method after a network failure or an HTTP 429 or 5xx answer, waiting twice as long before each new try. It is off by default and takes one of these values:

| Value | Retries |
| --- | --- |
| `true` | 2 retries, so three tries in all, starting at 250 ms and capped at 5 seconds |
| a number | that many retries |
| `{ retries, delay, maxDelay }` | all three set |

Methods that send, sign, hand out an address or change the server's state are never retried, because a request that timed out may still have reached the server. The one exception is an error whose `notSent` is true, which the transport sets only when it is certain no server received the request:

- `httpTransport` sets it when a connection timed out before it opened (`UND_ERR_CONNECT_TIMEOUT`, or `ETIMEDOUT` from `connect`), and only with the default fetch or `pearldFetch`. A custom `fetch` may have retried underneath, so its errors never set it.
- `fallbackTransport` sets it only when every server it tried set it.
- A custom transport passes `notSent: true` to the `PearlRpcError` it throws when it knows the request never left.

A call that fails with `notSent`, whatever its method, is tried again twice, after 250 and 500 ms, even when `retry` is off. A read whose connection timed out is retried the same way from any fetch. This matters on a busy host, which can hold new loopback connections for seconds, and pearld and Oyster close the connection after every reply, so each call opens its own.

### Requests in flight

A client keeps at most `maxConcurrentRequests` requests in flight, 4 by default (`DEFAULT_MAX_CONCURRENT_REQUESTS`), and further calls wait for a free slot. Set it to 0 to lift the limit.

A call's `timeout` and `signal` count while it waits. If it runs out of time or is aborted before a slot frees, it fails as it would on the wire (kind `network`) without being sent, and once it gets a slot it has whatever is left of its timeout.

Calls with no time limit use a second set of `maxConcurrentRequests` slots of their own so that they never hold up the rest, which means a client can have twice that many requests open. These are the `getblocktemplate` long polls, `generate`, `importprivkey`, `rescan` and `rescanblocks` when they have no `timeout`, and any call made with `timeout: 0`.

pearld turns away any request beyond its `--rpcmaxclients` limit (10 by default) with HTTP 503 before reading it, and one wallet sync can ask for 8 things at once. On a node that many clients share, raise that flag rather than lowering the limit here. A read-only call turned away with 503 is retried twice, 250 and 500 ms later, even without `retry`.

### Batching

`batch: true` gathers the calls made in one tick into a single JSON-RPC batch, and each call still gets its own result or error. `{ wait, maxSize }` collects calls for `wait` milliseconds and sends at most `maxSize` of them per request, 100 by default. A call with its own `signal` or `timeout` is sent on its own.

pearld accepts batches. Oyster reads one request per POST, so `OysterClient` rejects the option with `Oyster does not accept JSON-RPC batches`.

### Fallback

`fallbackTransport` tries each server in turn when one can't be reached or answers with an HTTP error, and stops at the first JSON-RPC reply, whether that reply is a result or an error. Pass `shouldFallback` to choose which failures move on to the next server.

A send that timed out on one server may still have arrived there, in which case the next server answers that it already has the transaction. Treat that answer as success.

### Reply size and redirects

The client reads at most `maxReplySize` bytes of a reply, 64 MiB by default (`DEFAULT_MAX_REPLY_SIZE`). That is enough for `getblock` with every transaction of a block at the 4 MB limit, but a verbose `getrawmempool` of a full mempool can need more. A longer reply fails with kind `response` before the client reads all of it.

The clients never follow an HTTP redirect, because following one would resend the request, credentials and passphrases included, to another address. A 3xx answer fails with kind `http` and its status.

### Custom transports

The `url` option is shorthand for `transport: httpTransport({ url, ... })`. A transport is any object with an `origin` and a `send(body, request)` method, so you can write one that signs requests, goes through a proxy or returns canned replies in tests.
