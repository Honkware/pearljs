# Use the Blockbook client

Blockbook is an indexer that serves a chain's blocks, transactions and address histories over HTTP and a websocket. `pearljs/blockbook` is a client for its REST API v2 and its websocket API, for an application that wants to read the chain from a Blockbook directly. To run a wallet over a Blockbook, use the backend in [Run a wallet over a Blockbook](blockbook.md), which is built on this client.

Pearl's team runs a fork of Blockbook for Pearl, [pearl-research-labs/blockbook](https://github.com/pearl-research-labs/blockbook), on the branches `feat/pearl-coin-support` and `feat/pearl-fp8-testnet`. Its public servers are `https://blockbook.pearlresearch.ai` for mainnet and `https://blockbook.testnet2.pearlnetwork.net` for testnet2.

## Create a client

`BlockbookClient` takes the server's base URL and the network the server must serve:

```ts
import { BlockbookClient, formatPearl, networks } from 'pearljs';

const client = new BlockbookClient({ url: 'https://blockbook.pearlresearch.ai', network: networks.mainnet });
const address = await client.getAddress(process.env.ADDRESS ?? '');
console.log(formatPearl(address.balance), 'PRL confirmed in', address.txs, 'transactions');
```

Before its first request, the client checks once that the server is on the right network. The chain name of the pearld behind the server (`backend.chain` in `GET /api/`) and the hash of block 0 must both be the network's, and a server for another network fails every call with `BACKEND_WRONG_NETWORK`. Regtest and simnet share a block 0, so for those two only the chain name tells them apart.

Amounts come back as `bigint` grain. [Blockbook reference](../reference/blockbook-api.md) lists every method, the client's options and how the server's replies behave.

## Use HTTPS

Over plain HTTP, anyone on the network path can read and rewrite every reply and drop or replace a broadcast. The client therefore refuses an `http://` or `ws://` URL for any host other than loopback unless you set `allowInsecureHttp`. The backend's checks still hold over such a connection, but anyone on the path can then do everything a lying server can ([Limits of the checks](../concepts/blockbook-trust.md#limits-of-the-checks)).

Pearl's servers redirect plain `http://` to `https://`, and the client follows no redirects, so give it the `https://` URL ([Pearl's servers](../reference/blockbook-api.md#pearls-servers)).

## Handle errors

Errors are `PearlRpcError`s, the same class the RPC clients throw. Blockbook answers an error with `{"error": text}` and HTTP 400, or 500 for an error whose details it keeps to itself, and both arrive as kind `"rpc"` with the status in `status`. Anything else is kind `"http"`, `"network"` or `"response"`.

When pearld refuses a transaction, its code and message reach that error text, and `sendTransaction` puts the code in `rpcCode`, so a wallet can tell a refused broadcast from an uncertain one as it does with pearld. To check whether the server answered that a transaction or block isn't there, use `isBlockbookNotFound(err)`:

```ts continues
import { isBlockbookNotFound } from 'pearljs';

async function findTransaction(txid: string) {
  try {
    return await client.getTransaction(txid);
  } catch (err) {
    if (isBlockbookNotFound(err)) return null;
    throw err;
  }
}
console.log(await findTransaction(process.env.TXID ?? ''));
```

## Subscribe over the websocket

`BlockbookWsClient` speaks Blockbook's websocket API at `/websocket`. Use it to hear about new blocks and about transactions to or from a set of addresses:

```ts fragment
import { BlockbookWsClient, networks } from 'pearljs';

const ws = new BlockbookWsClient({ url: 'https://blockbook.pearlresearch.ai', network: networks.mainnet });
await ws.subscribeNewBlock((block) => console.log('block', block.height, block.hash));
await ws.subscribeAddresses(['prl1p...'], ({ address, tx }) => console.log(address, tx.txid, tx.blockHeight), { newBlockTxs: true });
```

The websocket client checks block 0 on every connection, and after a drop it reconnects and subscribes again unless `reconnect` is false. A notification is the server's word, like everything else it sends, so a wallet should follow one with a `sync`, which checks. [Websocket subscriptions](../reference/blockbook-api.md#websocket-subscriptions) has the limits on addresses and how the client keeps the connection open, and [Websocket-only backend](../reference/blockbook-api.md#websocket-only-backend) runs a wallet backend over the websocket alone, as a page on another origin must.
