# Reach a node from a page

A wallet running in a web page has to read the chain and broadcast its payments, and a browser can reach pearld in only one of the ways Node can. A page can't call pearld's HTTP RPC, because pearld sends no CORS headers, but it can connect to pearld's websocket. The page connects there as a user that can only read, and a small endpoint on the page's own origin does the broadcasting.

## Set up the node

The page logs in with credentials anyone can read from its source, so give it pearld's limited user rather than the full one. Start pearld with `--rpclimituser` and `--rpclimitpass` beside the usual `--rpcuser` and `--rpcpass`, for example `--rpclimituser=page --rpclimitpass=...`. The limited user can call only the methods in pearld's `rpcLimited` list, which pearljs exports as `PEARLD_LIMITED_METHODS` ([Limited user's methods](../reference/browsers-and-bundlers-modules.md#limited-users-methods)).

> **Warning:** Credentials a page holds are public: anyone can read them from the page. Give the page only the limited user, which cannot spend, stop the node or change its peers, and remember that it can still read everything the node knows.

The node also needs an index for the wallet to look up addresses: `--addrindex` for `pearldBackend`, or the compact filter index, which is on by default, for `filterBackend`.

Finally, the browser has to trust the node's TLS certificate. pearld's self-signed `rpc.cert` must either be added to the browser or replaced with a certificate from a CA.

## Connect the page

Connect to the websocket at `/ws` as the limited user, check that the node keeps the address index, and build the backend:

```ts fragment
import { PearlWsClient, PearldClient, networks, pearldBackend, probePearld } from 'pearljs';

const ws = new PearlWsClient({ url: 'wss://node.example.com:44107/ws', username: 'page', password: 'the limited password' });
const capabilities = await probePearld(ws);
if (!capabilities.addrIndex) throw new Error('this node runs without --addrindex');

const backend = pearldBackend(ws, {
  network: networks.mainnet,
  // Same origin, so no CORS; the server behind it adds the full credentials.
  broadcast: new PearldClient({ url: new URL('/api/broadcast', location.origin) }),
});
console.log(await backend.getBalance(['prl1pr6yuq8u2r95wjzzgpdy8cpnncpl7l8zgy6x5q0367pnc53s2famqg7pt74']));
```

`probePearld(rpc)` reports which methods a set of credentials may call and which indexes the node keeps. The backend reads everything through the websocket and sends broadcasts to the `broadcast` client, which here points at an endpoint on the page's own origin.

A node without the address index serves the same page through `filterBackend` over the same `PearlWsClient`, with an IndexedDB store, since it needs only the filter index ([Compact filters](compact-filters.md)).

## Add the broadcast endpoint

The endpoint behind `/api/broadcast` holds the node's full credentials and forwards `sendrawtransaction` and nothing else. In Node it can be this short:

```ts fragment
import { createServer } from 'node:http';
import { PearldClient } from 'pearljs';

const node = new PearldClient({ url: 'https://127.0.0.1:44107', username: 'admin', password: process.env.PEARLD_RPC_PASS ?? '' });

createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += String(chunk);
  const { id, method, params } = JSON.parse(body) as { id: number; method: string; params: unknown[] };
  response.setHeader('Content-Type', 'application/json');
  if (method !== 'sendrawtransaction' || typeof params[0] !== 'string') {
    response.end(JSON.stringify({ result: null, error: { code: -32601, message: 'Method not found' }, id }));
    return;
  }
  try {
    response.end(JSON.stringify({ result: await node.sendRawTransaction(params[0]), error: null, id }));
  } catch (err) {
    const { rpcCode = -32603, message } = err as { rpcCode?: number; message: string };
    response.end(JSON.stringify({ result: null, error: { code: rpcCode, message }, id }));
  }
}).listen(8080);
```

The endpoint answers in pearld's JSON-RPC format, so the page's `PearldClient` reads its replies as it reads pearld's, and a refusal from the node reaches the page as an RPC error with the node's code in `rpcCode`.

A page can also read the chain from Pearl's public Blockbook, and [Node access from a page](../reference/browsers-and-bundlers-modules.md#node-access-from-a-page) compares the setups and lists how pearld's endpoints treat a browser.

## Next steps

- [Keys in a page](../concepts/browsers-and-bundlers-keys.md)
- [Wallet backends and discovery](../reference/wallet-backends-reference.md#limited-user)
- [Websocket notifications](websocket.md)
