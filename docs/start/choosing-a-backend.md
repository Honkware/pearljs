# Choosing a backend

A wallet, an invoice monitor and `discoverAccount` all read the chain through a backend, and the right one depends on what you can run. This table matches the common situations to a backend:

| You have | Use |
| --- | --- |
| A pearld you run | `connectPearld`, which picks `pearldBackend` or `filterBackend` to suit the node |
| Only pearld's limited RPC user | `pearldBackend` or `filterBackend`, with a separate `broadcast` endpoint |
| A web page | either of those over `PearlWsClient`, as the limited user |
| An Oyster wallet that holds the keys | `oysterBackend` |
| No node, but a Blockbook serving Pearl | `blockbookBackend` |
| No node, on mainnet | `pearldBackend` over a public RPC endpoint |
| Tests | `SimulatedChain` from `pearljs/testing` |

If you run your own pearld, start with `connectPearld`.

## Connect to your own node

`connectPearld(rpc, { network, birthday })` probes the node with `probePearld` and returns whichever of `pearldBackend` and `filterBackend` the node can serve, along with `kind` and the probe's `capabilities`:

```ts fragment
import { PearlWallet, PearldClient, connectPearld, createMemoryStore, networks } from 'pearljs';

const node = new PearldClient({ url: 'https://127.0.0.1:44107', username: 'user', password: 'pass', batch: true });
const chain = await connectPearld(node, { network: networks.mainnet, birthday: 31200 });
console.log(chain.kind, chain.capabilities);
const wallet = await PearlWallet.open({ store: createMemoryStore(), backend: chain });
```

`birthday` is the height of the block in which the wallet's first address was made, or 0 if that isn't known. When the node keeps neither index, `connectPearld` throws `BACKEND_UNSUPPORTED`.

Every backend on this page is a `WalletChain`, one object that serves as a `WalletBackend`, as the wallet's source of full transactions and as a `ChainClient` for invoices, so any of them can be passed wherever a backend is asked for.

## Use a public RPC endpoint

The pearlchain.live explorer runs a public JSON-RPC endpoint over its own mainnet pearld at `https://pearlchain.live/rpc`. It takes no username or password and allows read-only calls plus `sendrawtransaction`, which is enough for `pearldBackend` to find an account's coins, estimate fees and broadcast:

```ts fragment
import { PearldClient, networks, pearldBackend } from 'pearljs';

const node = new PearldClient({ url: 'https://pearlchain.live/rpc', retry: { retries: 5, delay: 1000, maxDelay: 10000 }, maxConcurrentRequests: 1 });
const chain = pearldBackend(node, { network: networks.mainnet, concurrency: 1 });
console.log(await chain.estimateFeeRate());
```

The endpoint limits how fast each IP address may call them, so the client sends one request at a time and keeps retrying a request that comes back rate limited, waiting longer each time, for up to about 25 seconds. Leave `batch` off unless the operator says how large a batch it takes. An address with a long history is read a page at a time under that limit, so its first sync can take minutes, which suits a wallet with a few addresses better than an explorer.

The endpoint refuses `gettxspendingprevout`, and `pearldBackend` then looks for a spend of an unconfirmed output in the address's own history, as it does for pearld's limited user. The operator is someone else, so read [Trust](#trust) before relying on it.

## Backends in detail

| You have | Use | It needs | Limits |
| --- | --- | --- | --- |
| A pearld you run, with `--addrindex` | `connectPearld`, which returns `pearldBackend` | `--addrindex`, which turns on `--txindex` | None for reads; P2MR addresses are found from block filters, from `birthday` on |
| A pearld you run, without the address index | `connectPearld`, which returns `filterBackend` | the filter index, on unless `--nocfilters` | Scans from `birthday` and keeps what it found in a store; give it `crossCheck` endpoints to hold the node to another's chain |
| Only pearld's limited RPC user | `pearldBackend` or `filterBackend`, as `probePearld` allows | `--rpclimituser` and one of the two indexes | Cannot broadcast: give the backend a `broadcast` endpoint that holds full credentials |
| A web page | either of the above over `PearlWsClient`, as the limited user | pearld's websocket at `/ws` and a certificate the browser trusts | pearld's HTTP port sends no CORS headers, so a page cannot use it |
| An Oyster wallet holding the keys | `oysterBackend` | Oyster connected to a pearld over RPC for broadcast and fee estimates | Knows the wallet's own addresses only; in SPV mode it cannot broadcast |
| No node, only a public RPC endpoint | `pearldBackend` over a `PearldClient` with a long `retry` and one request at a time | the endpoint's URL, over TLS | The endpoint's rate limit, and its operator's word for the chain |
| No node, only a Blockbook serving Pearl | `blockbookBackend` over a `BlockbookClient` | the server's URL, over TLS | The server can hide transactions and make up blocks: give it `crossCheck` servers to hold it to theirs; see [Blockbook](../concepts/blockbook-trust.md) |
| No node, and a web page on another origin than the Blockbook | `blockbookBackend` over a `BlockbookWsClient`, `verifyBlocks: false` | the server's websocket, over TLS | Blocks are the server's word, held only to `crossCheck` servers; see [Blockbook client](../guides/blockbook-client.md) |
| Tests | `SimulatedChain` from `pearljs/testing`, or `blockbookBackend` over `simulatedBlockbook` | nothing | A chain in memory; see [Testing your application](../guides/testing.md) |

## Trust

A backend can only report what its server tells it, so it matters how much each one checks.

`pearldBackend` and `oysterBackend` take their server's word for what the chain holds, so the server can show them false payments or hide real ones. Over a public endpoint that server belongs to someone else, who also sees every address the wallet asks about and the IP address asking, as the operator of a public Blockbook does.

`filterBackend` reads only the blocks and filters its `crossCheck` endpoints confirm. With one honest endpoint among them, the node can neither hide a confirmed payment to the wallet nor show one that the endpoint's chain doesn't hold. When the endpoints can't be reached, disagree, or are more than `crossCheckLag` blocks apart, the sync fails and the wallet keeps what it had ([Filters and the filter scan](../concepts/compact-filters-scan.md)).

`connectPearld` refuses `crossCheck` endpoints for a node with the address index (`CROSS_CHECK_UNSUPPORTED`), because it would otherwise return a `pearldBackend` that ignores them. For a cross-checked scan on such a node, call `filterBackend` directly.

`blockbookBackend` checks each transaction against its txid and the blocks it is placed in, and checks everything about a block except its proof. With `crossCheck` servers it reads only what all of them have, as `filterBackend` does ([Blockbook](../concepts/blockbook-trust.md)).

No backend verifies block proofs by itself, and [Verify blocks from a wallet backend](../guides/verify-proof.md#verify-blocks-from-a-wallet-backend) shows how to add that. Without cross-check endpoints, every backend is only as honest as its server, so run the node yourself for anything that decides whether you were paid ([Security model](../concepts/security.md#a-node-or-backend-that-lies)).

## Next steps

- [Wallet backend reference](../reference/wallet-backends-reference.md) for `pearldBackend` and `oysterBackend`
- [Compact filters](../guides/compact-filters.md) for `filterBackend`
- [Reach a node from a page](../guides/browsers-and-bundlers-node-access.md) for the limited user, the broadcast proxy and pages
