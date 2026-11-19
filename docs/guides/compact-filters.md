# Use compact block filters

A compact block filter is a small summary of the scripts a block touches. A light client downloads the filter for each block and fetches the block itself only when the filter says one of its scripts may be inside, which lets a wallet find its transactions without an address index or a server that knows its addresses. A wallet can run over filters, and the pieces underneath it can be used on their own. [Filters and the filter scan](../concepts/compact-filters-scan.md) explains what a filter holds and how the scan works.

pearld builds BIP158 basic filters unless it is started with `--nocfilters`, and serves them through `getcfilter` and `getcfilterheader` with filter type 0 (`BASIC_FILTER_TYPE`).

## Run a wallet over filters

`filterBackend(rpc, { network, birthday })` is a wallet backend that needs nothing from pearld beyond its filter index. The node doesn't need `--addrindex` or `--txindex`, and every read the backend makes is one the limited user may make ([Reach a node from a page](browsers-and-bundlers-node-access.md)). It keeps every transaction it finds, so it is also the wallet's `TransactionSource`, and one object serves `PearlWallet`:

```ts fragment
import { PearlWallet, PearldClient, filterBackend, networks, openIndexedDbStore } from 'pearljs';

const node = new PearldClient({ url: 'https://127.0.0.1:44107', username: 'page', password: 'limited', batch: true });
// A second node, run by someone else, that must confirm every block and filter the scan reads.
const other = new PearldClient({ url: 'https://pearld.example.net:44107', username: 'page', password: 'limited' });
// The scan keeps its own store, apart from the wallet's.
const scan = await openIndexedDbStore('pearl-filter-scan');
// The block the wallet was created at; earlier blocks cannot hold its coins.
const chain = filterBackend(node, { network: networks.mainnet, birthday: 31200, store: scan, crossCheck: [other] });
const wallet = await PearlWallet.open({ store: await openIndexedDbStore('pearl-wallet'), backend: chain });
await wallet.sync();
console.log(wallet.balance(), await chain.status());
```

`birthday` is the height the wallet was created at, so the scan starts there instead of at genesis. `crossCheck` names other nodes that must agree with this one about every block and filter the scan reads, which is what keeps a lying node from hiding or inventing payments ([Trust](../concepts/compact-filters-scan.md#trust)). `status()` shows where the scan stands. [Filter backend reference](../reference/compact-filters-calls.md) lists the options, what a sync costs and which calls the limited user may make.

## Ask whether a block touches your scripts

To test a single block yourself, fetch its filter and match your scripts against it:

```ts
import { matchAnyFilter, networks, toOutputScript, type PearldClient } from 'pearljs';

// prevFilterHeader is getcfilterheader of the block before, checked earlier.
async function blockTouches(node: PearldClient, blockHash: string, prevFilterHeader: string, addresses: string[]): Promise<boolean> {
  const scripts = addresses.map((address) => toOutputScript(address, networks.mainnet));
  const { filter, key } = await node.getCFilter(blockHash, prevFilterHeader);
  return matchAnyFilter(filter, key, scripts);
}
```

`getCFilter(blockHash, prevHeader?)`, on any pearld client, fetches one filter and decodes it, and over a transport of your own `new PearldRpc(rpc).getCFilter(...)` does the same. `matchFilter` tests one script and `matchAnyFilter` tests several.

A match means the block may hold one of the scripts, so fetch the block with `getRawBlock`, parse it and look. A script that isn't in the block matches with a probability of 1 in 784931. A miss is certain, as long as the filter is honest.

## Look up more

[Filter backend reference](../reference/compact-filters-calls.md) also covers [checking filters against their headers](../reference/compact-filters-calls.md#filter-headers) and [building and encoding filters](../reference/compact-filters-calls.md#building-filters).
