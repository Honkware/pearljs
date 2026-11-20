# Control timeouts, retries and batching

The clients from [Connect to pearld and Oyster](rpc.md) work with their defaults against one local node. Their options cover everything else: a slow call, a node that drops requests, many calls at once and more than one node.

## Set a timeout

Each request gets 60 seconds (`DEFAULT_RPC_TIMEOUT`) to answer. Set the client's `timeout` option, in milliseconds, to change that for every call, or to 0 for no limit. Three slow methods have no default timeout ([Timeouts](../reference/rpc-methods.md#timeouts)).

## Cancel a call

`call` takes a `timeout` and a `signal` for each call. To give the typed methods the same, wrap the client in `new PearldRpc(client, { signal, timeout })` or `new OysterRpc(...)`, and every call made through the wrapper carries them:

```ts
import { PearldClient, PearldRpc } from 'pearljs';

declare const node: PearldClient;

const quick = new PearldRpc(node, { signal: AbortSignal.timeout(5000) });
const block = await quick.getBlockWithTransactions(await quick.getBestBlockHash());
console.log(block.rawtx.length);
```

## Retry, batch and fall back

This client sends its calls to two nodes, retries reads that fail on the network, and sends calls made together as one request:

```ts
import { PearldClient, fallbackTransport, httpTransport } from 'pearljs';

const node = new PearldClient({
  transport: fallbackTransport([
    httpTransport({ url: 'https://node-a.example:44107', username: 'a', password: process.env.NODE_A_PASS ?? '' }),
    httpTransport({ url: 'https://node-b.example:44107', username: 'b', password: process.env.NODE_B_PASS ?? '' }),
  ]),
  retry: 2, // read-only methods only
  batch: true, // calls made together travel as one JSON-RPC batch
});
const [height, tip] = await Promise.all([node.getBlockCount(), node.getBestBlockHash()]); // one POST
console.log(height, tip);
```

`retry` repeats read-only methods after a network failure, and never methods that send, sign, hand out an address or change the server's state. `batch: true` sends the calls made in one tick as one JSON-RPC batch, which pearld accepts and Oyster does not. `fallbackTransport` moves on to the next server when one can't be reached. [Transport options](../reference/rpc-methods.md#transport-options) has the retry values, the limit on requests in flight, the batch settings, the reply size limit and custom transports.
