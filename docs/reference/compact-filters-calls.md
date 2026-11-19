# Filter backend reference

## Options

| Option | Default | Effect |
| --- | --- | --- |
| `network` | | The network scanned |
| `birthday` | | The block the wallet was created at; the scan starts from the block before it |
| `store` | | Where the scan keeps its records, apart from the wallet's store |
| `batchSize` | 100 | Blocks per round |
| `concurrency` | 8 | Heights fetched at a time, and walked back at a time after a reorganization |
| `keepFilters` | true | Whether each block's record keeps its filter |
| `maxAge` | 1000 ms | Age of the last sync past which a query syncs first |
| `crossCheck` | none | Endpoints that must confirm the blocks and filter headers the scan reads |
| `crossCheckLag` | 6 | Blocks the tips may differ by before a sync fails |
| `watch` | | The first addresses or scripts to watch |
| `broadcast` | the node | An endpoint for `broadcast`, for the limited user |

## Costs

A sync of N blocks with no match costs:

- 3N requests: `getblockhash`, `getblockheader` and `getcfilter`;
- each round, one `getblockheader` and one `getcfilterheader` for the node, and a `getblockhash` and a `getcfilterheader` for each cross-check endpoint;
- once, `getbestblock`, `getrawmempool` and each endpoint's `getblockcount`;
- on the first sync, `getblockhash` and `getcfilterheader` for the anchor, from the node and each endpoint.

A client made with `batch: true` sends a round's requests in a few POSTs. The replies are small. A header is 108 bytes and a hash is about 100 bytes of JSON. A block's filter is about 20 bits an item, so a filter for a block of a coinbase and a few transactions is a few dozen bytes.

Each match costs one `getblock` of the whole block in hex, twice its size, its certificate included (a ZK proof of up to 62,000 bytes). A watched script matches a block that does not hold it about once in 784931 blocks, and each such false positive costs one block download and nothing else. The store holds one record per block from the birthday, about 200 bytes with the filter kept.

## With the limited user

| Call | Methods | Limited user (`node/rpcserver.go:261-301`) |
| --- | --- | --- |
| sync | `getbestblock`, `getblockhash`, `getblockheader`, `getcfilter`, `getcfilterheader`, `getblock`, `getblockcount` | yes |
| mempool | `getrawmempool`, `getrawtransaction` | yes |
| `getTransaction` for a transaction it did not find | `getrawtransaction`, `getblockheader` | yes; without `--txindex` a confirmed one is `null` |
| `getSpendStatus` for an output that is not the wallet's | `gettxout` | yes |
| `estimateFeeRate` | `estimatefee`, `getinfo` | yes |
| `broadcast` | `sendrawtransaction` | no: `UnsupportedMethodError` unless the `broadcast` option names another endpoint |

## Filter headers

Each block's filter has a filter header that commits to the filter and to every filter before it, so a client that knows one trusted header can check every filter after it. Given the previous header, `getCFilter` checks the filter against `getcfilterheader` and throws `FILTER_HEADER_MISMATCH` when they disagree. To check a run of consecutive filters, use `checkFilterHeaders`, which returns the last header:

```ts
import { checkFilterHeaders, filterHeaderHex, type PearldClient } from 'pearljs';

async function verifyRun(node: PearldClient, trustedHeader: string, blockHashes: string[]): Promise<string> {
  const chain = [];
  for (const hash of blockHashes) {
    const { filter } = await node.getCFilter(hash);
    chain.push({ filter, header: await node.getCFilterHeader(hash) });
  }
  return filterHeaderHex(checkFilterHeaders(trustedHeader, chain));
}
```

Here the filters and their headers come from the same node, so the check catches corruption but not a node that lies. To hold a node to the truth, compare its filter headers with those of other nodes, which is what `filterBackend` does with `crossCheck`.

## Building filters

pearljs can also build filters, for tests or for a server of your own:

```ts run
import { buildFilter, decodeFilter, encodeFilter, filterHash, filterKey, matchFilter } from 'pearljs';

// The key comes from a block hash, as RPC shows it.
const key = filterKey('a18d3093b7ff618f0cdd073fa3d10374e2e0105fe7ef53ff48b55f41c58dadd7');
const scripts = [Uint8Array.of(0x51, 0x20, ...new Uint8Array(32).fill(1)), Uint8Array.of(0x52, 0x20, ...new Uint8Array(32).fill(2))];

const filter = buildFilter(key, scripts);
console.log(filter.n, matchFilter(filter, key, scripts[0]!)); // 2 true
console.log(matchFilter(filter, key, Uint8Array.of(0x51, 0x20, ...new Uint8Array(32).fill(9)))); // false

const wire = encodeFilter(filter); // what getcfilter returns, as bytes
console.log(decodeFilter(wire).n, filterHash(filter).length); // 2 32
```

`buildBasicFilter(block, prevOutScripts)` builds a block's filter the way pearld does, from a parsed block and the scripts its inputs spend. The block doesn't contain those scripts, so you supply them. `decodeFilter` reads `getcfilter`'s hex or bytes, `filterHeader` computes a header from a filter and the previous header, and `sipHash24` is the hash that filters are built on.
