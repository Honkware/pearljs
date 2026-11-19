# Receive websocket notifications

An application that reacts to new blocks or incoming payments as they happen, such as a deposit watcher, can hold a websocket open to pearld with `PearlWsClient` and have pearld tell it about each one.

## Connect from Node

pearld serves its websocket at the `/ws` path on its RPC port (`PEARLD_WS_PATH`), with the same self-signed `rpc.cert` as its HTTP endpoint ([Trust the node's certificate](rpc.md#trust-the-nodes-certificate)). Node's built-in WebSocket can't be told to trust a certificate, and Node 20 has none at all, so pass the WebSocket from the `undici` package together with a dispatcher that trusts `rpc.cert`:

```ts
import { readFileSync } from 'node:fs';
import { Agent, WebSocket } from 'undici';
import { PEARLD_RPC_PORTS, PearlWsClient } from 'pearljs';

const ws = new PearlWsClient({
  url: `wss://127.0.0.1:${PEARLD_RPC_PORTS.mainnet}/ws`,
  username: process.env.PEARLD_RPC_USER ?? '',
  password: process.env.PEARLD_RPC_PASS ?? '',
  WebSocket,
  webSocketInit: { dispatcher: new Agent({ connect: { ca: readFileSync(process.env.PEARLD_RPC_CERT ?? 'rpc.cert', 'utf8') } }) },
});
console.log(await ws.getBlockCount());
```

The client connects on its first call, or straight away when you call `connect()`. An `https://` URL, or one with no path, is turned into `wss://.../ws`. Without a `WebSocket` option the client uses `globalThis.WebSocket`, which browsers and Node 22 have, and a browser has to trust the certificate itself. `webSocketInit` is passed to the constructor as its second argument, so it takes the `ws` package's options as well.

## Watch blocks and payments

With the client connected, subscribe to what the application needs. This program logs each block, reports mempool transactions that pay a deposit address, and reads new mempool transactions until one moves more than 1 PRL:

```ts continues
import { parseTransaction, transactionId } from 'pearljs';

const unwatch = ws.watchBlocks({
  onBlock: (block) => console.log(block.type, block.height, block.hash),
  onError: (error) => console.error(error.message),
});

// Mempool transactions that pay a deposit address.
ws.on('relevanttxaccepted', ({ transaction }) => console.log('deposit', transactionId(parseTransaction(transaction))));
await ws.loadTxFilter({ addresses: [process.env.DEPOSIT_ADDRESS ?? ''] });

// Every new mempool transaction, until one moves more than 1 PRL.
for await (const tx of ws.transactions()) {
  console.log(tx.txid, tx.amount); // amount: grain paid by all outputs
  if (tx.amount > 100000000n) break;
}
unwatch();
await ws.close();
```

Each `watch` method returns a function that unsubscribes, and the async iterators such as `transactions()` unsubscribe when the loop ends. `on(name, listener)` receives any notification by its pearld name and returns a function that removes the listener. `loadTxFilter` tells pearld which addresses and outpoints to report, and pearld then sends `relevanttxaccepted` for each mempool transaction that touches them.

[Subscriptions](../reference/websocket-notifications.md#subscriptions) maps each method to pearld's notifications. The client logs in with pearld's `authenticate` command unless `auth` says otherwise ([Logging in](../reference/websocket-notifications.md#logging-in)), and it has every typed method of `PearldClient`, so `pearldBackend(ws, ...)` works over the socket ([Calls over the socket](../reference/websocket-notifications.md#calls-over-the-socket)).

## Handle reconnects

Once a session has been up, a dropped connection fails the calls in flight with kind `network`, and the client reconnects after 1 second, doubling the wait up to 30 seconds. A first connection that fails is reported to the calls waiting on it and isn't retried.

Two things are lost across a reconnect, and your code has to deal with them:

- Notifications sent while the client was away are gone. Catch up from the last block you saw, for example with `rescanBlocks`.
- When pearld sees an output paying a filter address or a `notifyReceived` address, it adds that output to its own watch list for the session. Those additions aren't restored, so reload them after a reconnect if you rely on spend notifications for them.

[Reconnects](../reference/websocket-notifications.md#reconnects) has the `reconnect` options and a listener that rescans the blocks it missed, [Keep-alive](../reference/websocket-notifications.md#keep-alive) covers pings for a connection that dies unnoticed, and [Oyster's websocket](../reference/websocket-notifications.md#oysters-websocket) covers the calls-only socket Oyster serves.

## Next steps

- [Follow the chain](explorer.md) uses the websocket to wake a block follower at once.
- [Build a browser extension](browsers-and-bundlers-extensions.md) holds a websocket from a service worker.
