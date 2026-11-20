# Blockbook reference

## REST methods

| Method | Request | Returns |
| --- | --- | --- |
| `getStatus()` | `GET /api/` | the indexer's and its pearld's state |
| `getBlockHash(height?)` | `GET /api/v2/block-index/{height}` | the hash at a height, the best block's without one, `null` past the server's tip |
| `getBlock(id, { page })` | `GET /api/v2/block/{id}` | a block by height or hash, with a page of up to 1000 transactions |
| `getRawBlock(id)` | `GET /api/v2/rawblock/{id}` | the serialized block, certificate included, in hex |
| `getTransaction(txid, { spending })` | `GET /api/v2/tx/{txid}` | a transaction, with its hex and the spender of each output a block has spent |
| `getTransactionSpecific(txid)` | `GET /api/v2/tx-specific/{txid}` | pearld's own `getrawtransaction` reply |
| `getAddress(address, query)` | `GET /api/v2/address/{address}` | balances and a page of history: txids, `txslight` or full transactions |
| `getXpub(descriptor, query)` | `GET /api/v2/xpub/{descriptor}` | the same for an xpub, with its derived addresses as `tokens` |
| `getUtxos(addressOrXpub, { confirmed })` | `GET /api/v2/utxo/{...}` | unspent outputs, mempool ones first |
| `getBalanceHistory(addressOrXpub, options)` | `GET /api/v2/balancehistory/{...}` | received and sent per interval of `groupBy` seconds (3600) |
| `getMempool({ page, pageSize })` | `GET /api/v2/mempool/` | the mempool's txids |
| `sendTransaction(tx)` | `POST /api/v2/sendtx/` | the txid |
| `estimateFee(blocks)` | `GET /api/v2/estimatefee/{blocks}` | pearld's `estimatefee`, in grain/kvB |

## Websocket methods

`BlockbookWsClient` has `getInfo`, `getBlockHash`, `getAccountInfo`, `getAccountUtxo`, `getTransaction` and `sendTransaction`, `call` for any other method, and two subscriptions, `subscribeNewBlock` and `subscribeAddresses`.

Fee estimates come from `BlockbookClient.estimateFee`. The websocket's `estimateFee` asks pearld for `estimatesmartfee`, which pearld does not have.

## Amounts

Amounts come back as `bigint` grain. Blockbook writes them as decimal strings of the smallest unit, and every one is read as such.

Fee estimates are the exception on the wire: PRL per kB as pearld gives them, which `estimateFee` converts. Pearl's desktop wallet asks `GET /api/v1/estimatefee/{blocks}`, which Blockbook answers from the same handler.

## Replies

These follow from the fork's code:

- A transaction in the mempool has `blockHeight` -1 and `confirmations` 0. A spent output has `spent`, `spentTxId` and `spentHeight` only once a block confirms the spend.
- An address's first page puts the mempool in front of the confirmed history and is then cut to the page size, so a confirmed transaction can fall off it.
- A query with `to` leaves the mempool out and pages the confirmed history alone. A query with `from` past the tip lists the mempool alone.
- A page past the last is answered with the last page again. Its `page` field says which page it is. `totalPages` is -1 for a query with `from` or `to`.
- Blockbook pages no further than 100,000 transactions into an address's history (`BLOCKBOOK_MAX_HISTORY_OFFSET`).
- `getUtxos` never flags a confirmed coinbase output as `coinbase`. Pearl's parser keeps Blockbook's default of 0 for the maturity it compares with. The backend reads coinbase from the transaction.
- `vout` is left out of an input when it is 0, as Go leaves out zero fields.
- A mempool transaction carries `confirmationETABlocks` and `confirmationETASeconds`, the server's guess from its fee rate.
- Blockbook answers HTTP 500 and "Internal server error" where pearld has no fee estimate, and for an xpub it cannot read.

## Xpub queries

- `getXpub` lists the derived addresses as `tokens` for `details` "tokens" and every level after it, never for "basic". Each has its path from the master key, such as `m/86'/808276'/0'/0/5`.
- `tokens` picks which addresses: "derived" for all of them, "used", or "nonzero" (the REST default).
- `transfers` counts an address's confirmed transactions only. The gap is counted from the last address with one, so an address paid only in the mempool neither counts as used nor moves the gap.
- `gap` is 20 unless given, and at most 10,000. The change chain is derived at least as far as the receive chain's last used index.
- A query with `from` leaves the mempool out of the list and still counts it in `unconfirmedTxs`. A query with `to` leaves it out of both.

## Websocket subscriptions

The websocket client checks block 0 on every connection, and after a drop it reconnects and subscribes again unless `reconnect` is false.

`subscribeAddresses` reports each mempool transaction that pays or spends from the addresses, and with `newBlockTxs` also each one that a new block confirms. The server writes a mempool transaction there with `blockHeight` 0 and no `blockHash`, and the client hands it on with `blockHeight` -1, as the REST API has it. A confirmed transaction arrives without `hex` or `size`.

Blockbook keeps one set of addresses per connection, of at most 1000 addresses, or 100 with `newBlockTxs`. A second call replaces the first once the server accepts it, and a call the server refuses leaves the first in place. A notification is the server's word, like everything else it sends, so a wallet should follow one with a `sync`, which checks.

Pearl's servers sit behind a proxy that closes a websocket after 30 seconds without a frame from the client. To keep the connection open, the client sends Blockbook's `ping` every `keepAlive` milliseconds while connected. A ping with no reply within `timeout` means the session is gone even if the socket hasn't said so, and the client then reports it to `onError`, closes the socket and, when it has subscriptions to keep, connects again and resubscribes.

## Client options

| Option | Default | Effect |
| --- | --- | --- |
| `maxConcurrentRequests` | 4 | Requests kept in flight |
| `timeout` | 60,000 ms | Time each request gets from when it is made, its wait for a slot included |
| `maxReplySize` | 64 MiB | Largest reply read |
| `retry` | off | Retries reads after a network failure or an HTTP 429 or 5xx, never a broadcast |
| `allowInsecureHttp` | off | Allows `http://` and `ws://` to a host other than loopback |
| `keepAlive` (websocket) | 20,000 ms | Interval of Blockbook's `ping` while connected; 0 for never |
| `reconnect` (websocket) | on | Reconnect and subscribe again after a drop |

The client refuses redirects.

A websocket frame longer than `maxReplySize` drops the connection too, but only once the WebSocket implementation has received all of it, since the WebSocket API has no limit of its own. The `ws` package takes one, `maxPayload` (100 MiB unless set), which `webSocketInit: { maxPayload }` passes to it, and which refuses a larger frame as it arrives.

## Outputs indexed

Blockbook keys its address index by output script and indexes every output except `OP_RETURN` (`IsAddrDescIndexable` in the fork's `bchain/coins/pearl/pearlparser.go`). It looks an address up by the script it encodes. P2TR and P2MR addresses are therefore both found, payments to them and spends from them alike.

The fork's replies also flag P2MR outputs as addresses (from its commit 19ce79c7). The backend reads scripts from the transactions and does not depend on that flag. `OP_RETURN` outputs belong to no address and are never listed.

The xpub queries (`getXpub`, and `getUtxos` and `getBalanceHistory` given an xpub or a `tr()` descriptor) derive BIP86 key-path P2TR addresses only. They use change chains 0 and 1 unless the descriptor names others, so they never cover a P2MR address. The backend uses `getXpub` only with `useXpub`, and only for the addresses of a wallet's BIP86 accounts ([Ask by account key](../guides/blockbook.md#ask-by-account-key)).

## Request costs

A first look at an address with N transactions costs:

- `GET /api/` and a `block-index` for the tip;
- one `address` page for every 1000 confirmed transactions, and one for the mempool;
- a `tx` for each transaction;
- with `verifyBlocks`, a `rawblock` for each block that holds one, its certificate included (a ZK proof of up to 62,000 bytes).

Transactions, checked blocks and checked placements are kept: the 10,000 transactions, 1,000 blocks and 100,000 placements used most recently. A later query then costs the `address` pages and whatever is new. A wallet's later syncs ask `getActivitySince`, which pages only the blocks after its last sync.

A new wallet's first sync asks `findUsed` about `gapLimit` addresses on each chain of each account, one `address` request apiece: 500 for one account at the default of 250.

With `useXpub`, discovery is one xpub request an account, two when the account has mempool transactions. A later sync asks one xpub request an account in place of one or two `address` requests a watched address. The addresses the hint calls used, and those holding coins, still cost their `address` requests.

For a wallet with six used addresses and a 250 gap on `simulatedBlockbook`:

| Sync | Requests without `useXpub` | With `useXpub` |
| --- | --- | --- |
| First | 551 | 41 |
| Later, nothing new | 62 | 12 |
| After a new block | 119 | 28 |

Calls made while a tip read is under way share it. An address's whole confirmed history is read once while the server's tip stays the same, since a sync reads it for the address's transactions and again for its coins.

## Pearl's servers

| Behaviour | Effect |
| --- | --- |
| No CORS headers on REST, and HTTP 400 for a CORS preflight | A page on another origin cannot use `BlockbookClient`; the websocket accepts any origin |
| Plain `http://` answered with a 301 to `https://` | Give the client the `https://` URL |
| A proxy closes a websocket after 30 seconds without a frame from the client | The client's `keepAlive` ping |
| The websocket's `estimateFee` answered with "EstimateSmartFee: not supported" | Fee estimates come from REST |
| The websocket's `getBlock` sends an empty `nonce` and no proof commitment | No block hash can be checked over the websocket |
| The testnet server runs without the extended index | A spent output does not name its spender, except through REST's `spending=true` |

Pearl's desktop wallet names its servers with `http://` (`apps/pearl-desktop-wallet/src/main/clients/blockbook-client.ts`). The error for a redirect names where it leads.

## Websocket-only backend

A web page on another origin can't use `BlockbookClient` against Pearl's public servers, because their REST endpoints send no CORS headers and answer a CORS preflight with HTTP 400. Their websocket accepts any origin, though ([Reach a node from a page](../guides/browsers-and-bundlers-node-access.md)), and `blockbookBackend` also takes a `BlockbookWsClient`, in which case it makes every query over the websocket:

```ts
import { BlockbookWsClient, blockbookBackend, networks } from 'pearljs';

const network = networks.mainnet;
const backend = blockbookBackend(new BlockbookWsClient({ url: 'wss://blockbook.pearlresearch.ai/websocket', network }), {
  verifyBlocks: false,
  crossCheck: [new BlockbookWsClient({ url: 'wss://another-blockbook.example/websocket', network })],
});
```

Over the websocket the backend uses `getInfo` for the tip, `getBlockHash`, `getAccountInfo` for addresses and account keys, `getTransaction`, `sendTransaction` and `estimateFee`.

It must be given `verifyBlocks: false`, and throws a `TypeError` when the option is left out or set to `true`. The reason is that the websocket serves no raw block: `getBlock` returns Blockbook's parsed block, whose fields can't rebuild the header (Pearl's servers send an empty `nonce` and no proof commitment), so no block hash can be checked. `crossCheck` takes websocket clients, REST clients or both. [Websocket-only mode](../concepts/blockbook-trust.md#websocket-only-mode) lists which checks this mode keeps and which it gives up.

## Simulated Blockbook

The test kit includes a Blockbook, so the same code runs in a test with no server:

```ts run
import { BlockbookClient, PearlWallet, blockbookBackend, createMemoryStore, formatPearl, parsePearl } from 'pearljs';
import { SimulatedChain, simulatedBlockbook } from 'pearljs/testing';

const chain = new SimulatedChain();
const server = simulatedBlockbook(chain);
const client = new BlockbookClient({ url: server.url, network: chain.network, fetch: server.fetch });
const wallet = await PearlWallet.create({
  store: createMemoryStore(),
  backend: blockbookBackend(client),
  passphrase: 'a passphrase for the test',
  kdf: { N: 2 ** 10 }, // quick, for tests only
});

chain.pay(await wallet.receiveAddress(), parsePearl('3'));
chain.mine();
await wallet.sync();
console.log(formatPearl(wallet.balance().confirmed)); // 3
```

`simulatedBlockbook(chain)` from `pearljs/testing` serves a `SimulatedChain` the way Pearl's Blockbook fork serves pearld. Its `fetch` answers the REST paths and its `WebSocket` answers the websocket. It pages, reports the mempool and marks spent outputs as listed in [Replies](#replies), and it answers the xpub query as the fork's `api/xpub.go` does with nothing cached.

Pass `extendedIndex: false` to serve it as a Blockbook without the extended index, which is how Pearl's testnet server runs. A spent output then says only that it is spent, and only REST's `spending=true` names the transaction that spent it. The server's `requests` lists the paths that were asked for, which is useful in tests of how many requests a flow costs.
