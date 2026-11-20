# Connect to pearld and Oyster

pearljs talks to a pearld node with `PearldClient` and to an Oyster wallet with `OysterClient`, both over JSON-RPC.

## Prerequisites

- A running pearld, and the RPC username and password it was started with (`--rpcuser` and `--rpcpass`).
- The node's certificate, `rpc.cert`, which pearld generates and keeps in its data directory.
- Node.js. A web page reaches pearld differently, as [Browsers](#browsers) explains.

## Connect to the node

Create a client with the node's address and login, and give it a `fetch` that trusts the node's certificate:

```ts
import { readFileSync } from 'node:fs';
import { pearldFetch } from 'pearljs/tls-fetch';
import { PEARLD_RPC_PORTS, PearldClient } from 'pearljs';

const node = new PearldClient({
  url: `https://127.0.0.1:${PEARLD_RPC_PORTS.mainnet}`,
  username: process.env.PEARLD_RPC_USER ?? '',
  password: process.env.PEARLD_RPC_PASS ?? '',
  fetch: pearldFetch({ ca: readFileSync(process.env.PEARLD_RPC_CERT ?? 'rpc.cert', 'utf8') }),
});

const info = await node.getBlockchainInfo();
console.log(info.chain, info.blocks, info.bestblockhash);
```

When this prints the network's name, the height and the hash of the best block, the client is connected. The password comes from the environment so that it stays out of your source.

The URL is the node's RPC address. Each network has its own default port, which `PEARLD_RPC_PORTS` holds, and `OYSTER_RPC_PORTS` holds Oyster's:

| Network | pearld | Oyster |
| --- | --- | --- |
| mainnet | 44107 | 44207 |
| testnet | 44109 | 44209 |
| testnet2 | 44111 | 44211 |
| regtest | 18334 | 18332 |
| simnet | 18556 | 18554 |

The client speaks JSON-RPC 1.0 over HTTP POST and sends the username and password with HTTP Basic auth, the only scheme pearld and Oyster accept, so there is no cookie file to read. They can also be written into the URL as `https://user:pass@host:port`, and the client moves them into the auth header. When the URL is malformed, the error leaves the URL out, because it may contain the password.

## Trust the node's certificate

pearld serves RPC over TLS with a certificate it signs itself, so Node doesn't trust it until told to. Without that step the first call fails with:

```text
TLS certificate of 127.0.0.1:18334 is not trusted (DEPTH_ZERO_SELF_SIGNED_CERT); pass a fetch or dispatcher that trusts the server's rpc.cert
```

`pearldFetch({ ca })` from `pearljs/tls-fetch`, used above, takes the PEM text of `rpc.cert` and returns a `fetch` that trusts that certificate and no other. It sends each request through `node:https` and keeps the connection open between requests, so the client makes one TLS handshake rather than one per call. Against a real node the handshakes are most of the time a busy client spends. Pass `keepAlive: false` to turn this off or `maxSockets` to cap the number of connections, and call `close()` on the fetch to close the open ones, although idle connections don't keep the process running. Because `pearljs/tls-fetch` imports Node built-ins, the main `pearljs` entry doesn't re-export it and a browser bundle never includes it.

Two other ways of trusting the certificate need no pearljs code. Start Node with `NODE_EXTRA_CA_CERTS=/path/to/rpc.cert`, or pass `init: { dispatcher }` with an `Agent` from the `undici` package that trusts the certificate.

> [!WARNING]
> Keep certificate checking on. Turning it off with `rejectUnauthorized: false` or `NODE_TLS_REJECT_UNAUTHORIZED=0` exposes the RPC password, which travels on that connection.

pearld accepts TLS 1.2 and 1.3, and Oyster accepts only TLS 1.3. A server started without TLS (`--notls` for pearld, `--noservertls` for Oyster) takes an `http://` URL. Over plain HTTP, Basic auth puts the password on the wire in the clear, so the client refuses to send it to any host other than loopback unless you set `allowInsecureAuth`:

```text
refusing to send the RPC password to node.example:44107 over http://, which is not encrypted; use TLS or set allowInsecureAuth
```

An `http://` URL pointed at a port that serves TLS gets an `http` error with status 400.

## Read a block

Each method pearld offers has a typed method on the client, as [RPC methods](../reference/rpc-methods.md) lists. This one fetches the best block as raw bytes and parses it:

```ts continues
import { parseBlock } from 'pearljs';

const tip = parseBlock(await node.getRawBlock(info.bestblockhash));
console.log(tip.transactions.length, 'transactions in block', info.blocks);
```

[Parse and check a block](blocks-and-consensus.md) explains what `parseBlock` returns.

## Connect to Oyster

Oyster is Pearl's wallet server. It keeps its own `rpc.cert` in its own data directory, its login is set with `--username` and `--password`, and `OysterClient` takes the same options as `PearldClient`:

```ts
import { readFileSync } from 'node:fs';
import { pearldFetch } from 'pearljs/tls-fetch';
import { OYSTER_RPC_PORTS, OysterClient, formatPearl } from 'pearljs';

const wallet = new OysterClient({
  url: `https://127.0.0.1:${OYSTER_RPC_PORTS.mainnet}`,
  username: process.env.OYSTER_RPC_USER ?? '',
  password: process.env.OYSTER_RPC_PASS ?? '',
  fetch: pearldFetch({ ca: readFileSync(process.env.OYSTER_RPC_CERT ?? 'rpc.cert', 'utf8') }),
});

const address = await wallet.getNewAddress();
const txid = await wallet.sendToAddress(address, 150000000n, 1000n); // 1.5 PRL at 1000 grain/kvB
console.log(txid, formatPearl(await wallet.getBalance()), 'PRL');
```

`sendToAddress` takes the amount and the fee rate as `bigint` grain, and `getBalance` returns grain as well.

### The desktop wallet's Oyster

Pearl's desktop wallet runs its own Oyster at `http://127.0.0.1:8335` (`DESKTOP_OYSTER_URL`), without TLS and in SPV mode, for mainnet and testnet2 alike. `desktopOysterClient` connects to it with the RPC username and password from the wallet's settings:

```ts
import { desktopOysterClient, formatPearl } from 'pearljs';

const wallet = desktopOysterClient({
  username: process.env.OYSTER_RPC_USER ?? '',
  password: process.env.OYSTER_RPC_PASS ?? '',
});
console.log(formatPearl(await wallet.getBalance()), 'PRL', await wallet.chainSynced());
```

In SPV mode Oyster has no RPC connection to a pearld, so `getInfo`, `listSinceBlock`, `signRawTransaction` and every call it would pass on to pearld answer "Chain RPC is inactive" with code -1.

## Read amounts

Both clients return amounts and take them as `bigint` grain, and they read each amount from the reply's text so that it never passes through a JavaScript number. pearld writes transaction outputs and `gettxout` values as exact PRL numbers with 8 decimals, which stay exact even above 2^53 grain. Balances, fees and fee rates are Go floats on the server, so they are rounded to the nearest grain. Fee rates are in grain/kvB.

Oyster reports sends, and the fees paid on them, as negative amounts in `listTransactions` and the methods like it, and the client keeps them negative. `formatPearl` writes them with a minus sign. `getTransaction` is the exception and reports its fee as positive.

This example runs without a node. It gives the client a `fetch` that answers the way Oyster does, to show what comes back:

```ts run
import { OysterClient, formatPearl } from 'pearljs';

const fakeOyster: typeof fetch = async (_url, init) => {
  const { id, method } = JSON.parse(String(init?.body)) as { id: number; method: string };
  const result = method === 'getbalance' ? '12.34567891' : '"unexpected"';
  return new Response(`{"result":${result},"error":null,"id":${id}}`);
};

const wallet = new OysterClient({ url: 'http://127.0.0.1:18332', username: 'u', password: 'p', fetch: fakeOyster });
const balance = await wallet.getBalance();
console.log(balance, formatPearl(balance)); // 1234567891n 12.34567891
```

## Call any other method

For a method that has no typed wrapper, use `call(method, params, options)`. It returns numbers as plain JSON numbers unless you ask for something else. `amounts` lists the object keys whose values are PRL amounts to return as grain, with `'result'` for the result itself and `'*'` for every number in it, and `integers` lists the keys to return as exact `bigint` values.

In the params, wrap an amount in `prlAmount(grain)` so that it is sent as the exact PRL number the servers expect. A bare `bigint` is sent as the integer it is, which is right for a height and wrong by a factor of 10^8 for an amount:

```ts
import { OysterClient, prlAmount } from 'pearljs';

declare const wallet: OysterClient;
declare const address: string;

const txid = await wallet.call<string>('sendtoaddress', [address, prlAmount(150000000n), prlAmount(1000n)]);
const received = await wallet.call<bigint>('getreceivedbyaddress', [address, 1], { amounts: ['result'] });
console.log(txid, received);
```

## Reach pearld through Oyster

Oyster passes any method it doesn't know on to its pearld. `PearldRpc` and `OysterRpc` add the typed methods to any object that has `call`, so wrapping an `OysterClient` in `PearldRpc` gives you pearld's methods over the wallet's connection:

```ts
import { OysterClient, PearldRpc } from 'pearljs';

declare const oyster: OysterClient;

const nodeThroughWallet = new PearldRpc(oyster);
console.log(await nodeThroughWallet.getBlockCount());
```

This works while Oyster is connected to a pearld over RPC, which in SPV mode it isn't.

## Errors

Every failure is thrown as a `PearlRpcError` that names the `method` that failed. Its `kind` says where the failure happened, and it is also a `PearlError` whose string `code` follows from the kind ([Errors](../reference/errors.md)):

| `kind` | `code` | Meaning | Also set |
| --- | --- | --- | --- |
| `rpc` | `RPC_ERROR` | The server answered with a JSON-RPC error | `rpcCode`, and the server's message |
| `http` | `RPC_HTTP` | An HTTP error status with no RPC reply | `status`; 401 means the username or password was refused |
| `network` | `RPC_NETWORK` | The server couldn't be reached or didn't answer | `cause`, and a message naming it: connection refused, an untrusted certificate, a TLS version the server refuses, a timeout; `notSent` when no server received the request |
| `response` | `RPC_RESPONSE` | A reply that isn't JSON-RPC | |

To handle a particular server error, catch the error and compare its `rpcCode`. This broadcast treats a transaction that is already in the chain as done:

```ts
import { PearlRpcError, RPC_ERROR_CODES, type PearldClient } from 'pearljs';

async function broadcast(node: PearldClient, hex: string): Promise<string | null> {
  try {
    return await node.sendRawTransaction(hex);
  } catch (err) {
    if (err instanceof PearlRpcError && err.rpcCode === RPC_ERROR_CODES.TX_ALREADY_IN_CHAIN) return null;
    throw err;
  }
}
```

`RPC_ERROR_CODES` names the codes callers commonly check, one name per number. Code -5 (`INVALID_ADDRESS_OR_KEY`) is too broad to check on its own, because Pearl answers it for an invalid address, an unknown transaction and an unknown block alike, and pearld also answers it for any confirmed transaction when it runs without `--txindex`. To ask whether the server has no such transaction, use `isUnknownTransaction(err)`.

pearld's limited user (`--rpclimituser`) may call the read-only methods in `PEARLD_LIMITED_METHODS`, and pearld answers any other method from that user with code -32603, which `isLimitedUserRefusal(err)` recognizes. The list leaves out `getblockchaininfo`, `getmempoolinfo`, `getnetworkinfo`, `gettxspendingprevout`, `testmempoolaccept` and `sendrawtransaction`. `probePearld` tells you which user a client is logged in as and which indexes the node keeps ([Wallet backend reference](../reference/wallet-backends-reference.md#limited-user)).

## Browsers

A web page can't call pearld's or Oyster's HTTP endpoints, because neither server sends CORS headers and both ask for Basic auth on the browser's preflight request. pearld's websocket accepts any Origin, though, and a page can log in to it as pearld's limited user. [Reach a node from a page](browsers-and-bundlers-node-access.md) sets out the setups that work, including a proxy for broadcasts.

## Next steps

- [Control timeouts, retries and batching](rpc-transports.md) for slow nodes, several nodes and many calls at once.
- [Receive websocket notifications](websocket.md) to hear about new blocks and payments as they happen.
- [RPC methods](../reference/rpc-methods.md) lists every typed method, and [Pearl's RPC differences](../reference/rpc-differences.md) where Pearl's servers differ from Bitcoin's.
