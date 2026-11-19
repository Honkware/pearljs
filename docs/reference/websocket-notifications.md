# Websocket reference

## Subscriptions

Each subscription maps to pearld's own notifications:

| Method | pearld notifications | Delivers |
| --- | --- | --- |
| `watchBlocks`, `blocks()` | `blockconnected`, `blockdisconnected` | Type, hash, height and header time |
| `watchFilteredBlocks`, `filteredBlocks()` | `filteredblockconnected`, `filteredblockdisconnected` | The 108-byte header parsed with `parseBlockHeader`, and the block's transactions that match the loaded filter |
| `watchTransactions`, `transactions()` | `txaccepted`, or `txacceptedverbose` with `verbose: true` | The txid and the grain its outputs pay, or the verbose `getrawtransaction` result |
| `loadTxFilter` | `relevanttxaccepted`, and the filtered block notifications | Mempool transactions touching the filter's addresses and outpoints |
| `notifyReceived`, `notifySpent` | `recvtx`, `redeemingtx` | Transactions paying the addresses or spending the outpoints, with block details once mined |
| `rescanBlocks` | none; it returns | For each block hash given, the transactions matching the loaded filter |
| `rescan` | `recvtx`, `redeemingtx`, `rescanprogress`, `rescanfinished` | btcd's older rescan, from one block up to but not including another, or to the tip. `rescanfinished` names the last block scanned; `rescanprogress` comes from a ten-second ticker, so a short rescan sends none |

pearld's `notifyblocks` command turns on both block notifications. The client sends it once however many watchers there are, and sends `stopnotifyblocks` after the last one leaves. pearld sends one form of transaction notification per connection, so while any watcher asks for the verbose form, the others get the txid and amount worked out from it.

## Logging in

pearld offers two ways to log in, chosen with the `auth` option.

The default, `auth: 'command'`, sends pearld's `authenticate` command as the first message on the socket. A browser has to log in this way, because it can't set headers on a websocket. If the credentials are wrong or the first message is anything else, pearld disconnects without a reply. It reads at most 64 KiB before the login and drops a client that hasn't logged in after 10 seconds. A wrong password reaches you as a `PearlRpcError` of kind `http` with status 401.

`auth: 'header'` sends Basic auth on the upgrade request instead, which works with constructors that take `{ headers }`, as `undici`'s and the `ws` package's do. pearld then refuses bad credentials with HTTP 401 before the upgrade, and a WebSocket reports that only as a failed connection.

Both ways send the password as it is, so the client refuses a plain `ws://` URL for any host other than loopback unless you set `allowInsecureAuth`. pearld accepts connections from any Origin and allows 25 websocket clients unless started with a different `--rpcmaxwebsockets`.

pearld's limited user (`--rpclimituser`) may call the read-only methods in `PEARLD_LIMITED_METHODS` and subscribe, but can't call the `stopnotify` commands. So when the last watcher of a subscription leaves, pearld refuses the client's `stopnotifyblocks` or `stopnotifynewtransactions`, and the client keeps the subscription and drops its notifications rather than reporting an error. `stopNotifyReceived` and `stopNotifySpent` called directly are refused with the error.

## Calls over the socket

`PearlWsClient` has every typed method of `PearldClient`, so `ws.getBlock(hash)`, `pearldChainClient(ws)` and `pearldBackend(ws, ...)` all work over the socket. `call(method, params, options)` reaches any other method, with the same options and the same `PearlRpcError` kinds as the HTTP client. pearld runs commands concurrently and can answer them out of order, so the client matches each reply to its call by id.

Calls time out after 60 seconds (`DEFAULT_RPC_TIMEOUT`), as with the HTTP clients, unless the client's or the call's `timeout` says otherwise, and 0 means no limit. `rescan`, `rescanBlocks`, `generate`, `importprivkey` and `getblocktemplate` have no default limit because they can run for a long time.

## Reconnects

The `reconnect` option takes `initialDelay`, `maxDelay` and `retries`, the number of tries before the client gives up, which is unlimited by default. `reconnect: false` turns reconnecting off. After reconnecting, the client logs in again and restores the block and transaction subscriptions, the filter, and the received and spent watches, then emits `connect` with `reconnect: true`.

This listener records the last block seen and, after a reconnect, walks forward from it to the tip and rescans the blocks it missed:

```ts
import { PearlWsClient } from 'pearljs';

declare const ws: PearlWsClient;
let lastSeen = await ws.getBestBlockHash();

ws.watchBlocks({ onBlock: (block) => { if (block.type === 'connected') lastSeen = block.hash; } });
ws.on('connect', async ({ reconnect }) => {
  if (!reconnect) return;
  // Walk forward from lastSeen to the tip and rescan those blocks.
  const missed: string[] = [];
  for (let hash = (await ws.getBlockHeader(lastSeen)).nextblockhash; hash; hash = (await ws.getBlockHeader(hash)).nextblockhash) {
    missed.push(hash);
  }
  for (const found of await ws.rescanBlocks(missed)) console.log(found.hash, found.transactions.length, 'matching transactions');
});
```

Frames the client can't read, unknown notifications and failed resubscriptions go to `on('error')`, and none of them rejects a call. A frame longer than `maxReplySize` (`DEFAULT_MAX_REPLY_SIZE`, 64 MiB) is refused: the client reports it and drops the connection, which fails the waiting calls and reconnects as after any drop.

A call that times out or is aborted is forgotten at once, and its late reply is dropped. `pending` counts the calls still waiting, and `on('disconnect')` reports each drop. `close()` fails the pending calls, ends the iterators and stops reconnecting. `session()` returns pearld's id for the connection, which changes on every reconnect.

## Keep-alive

A connection can die without either side noticing, for example when a laptop sleeps or a NAT forgets the mapping, and the client then waits for frames that never come. Set `keepAlive` to a number of milliseconds and the client sends pearld's `session` command at that interval while connected. Every user may call `session`, and pearld answers it from memory. If a ping is still unanswered when the next one is due, the client drops the session, reports it on `on('error')`, and reconnects and resubscribes as after any drop. It is off unless you set it:

```ts fragment
import { PearlWsClient } from 'pearljs';

const ws = new PearlWsClient({ url: 'wss://127.0.0.1:44107/ws', username: 'user', password: 'pass', keepAlive: 20_000 });
```

The replies also count as activity for a browser extension's service worker, which Chrome stops after 30 seconds without any, so a worker subscribed to blocks stays up while the socket is otherwise quiet. Keeping a worker running holds memory and wakes the device at every interval, which costs battery on a laptop or phone. Use it while the user waits for something, such as a payment to confirm, rather than for as long as the browser runs. Oyster has no `session` command, so `OysterWsClient` rejects `keepAlive`.

## Oyster's websocket

Oyster also serves `/ws`, for calls only. It requires Basic auth on the upgrade, answers `authenticate` itself and sends no notifications. A notification command passed through Oyster would subscribe or unsubscribe Oyster's own connection to pearld, so `OysterWsClient` refuses those commands with `BACKEND_UNSUPPORTED`. It has Oyster's typed methods, as `OysterClient` does, and uses `auth: 'header'` by default:

```ts
import { WebSocket } from 'undici';
import { OYSTER_RPC_PORTS, OysterWsClient } from 'pearljs';

const wallet = new OysterWsClient({
  url: `wss://127.0.0.1:${OYSTER_RPC_PORTS.regtest}/ws`,
  username: process.env.OYSTER_RPC_USER ?? '',
  password: process.env.OYSTER_RPC_PASS ?? '',
  WebSocket,
});
console.log(await wallet.getBalance());
await wallet.close();
```
