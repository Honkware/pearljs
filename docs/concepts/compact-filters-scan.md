# Filters and the filter scan

A compact block filter is a short, probabilistic list of the scripts a block touches. With filters, a light client finds its own transactions without an address index and without sending its addresses to a server: it downloads every block's filter, which is small, and fetches only the blocks whose filters match one of its scripts.

pearljs decodes pearld's filters, matches scripts against them, checks them against the filter-header chain and can build them. `filterBackend` is a wallet backend that works from filters alone ([Use compact block filters](../guides/compact-filters.md)), and it can hold the node it reads to other nodes.

## Filter contents

A filter holds each script once, and it holds two kinds of script: every output script of the block that isn't empty and doesn't start with OP_RETURN, and every non-empty script that the block's inputs spend, OP_RETURN ones included. So a filter matches both a block that pays one of your scripts and a block that spends from one.

A match means the block may touch the script. Now and then a script that isn't in the block matches too, a false positive, so a match is a reason to download the block and look.

The filter parameters are Bitcoin's, P = 19 and M = 784931 (`BASIC_FILTER_P`, `BASIC_FILTER_M`), and the SipHash key is the first 16 bytes of the block hash. A Pearl block hash is the hash of its 108-byte header, so a Pearl filter differs from the Bitcoin filter for the same transactions.

## Filter headers

A filter header ties each filter to every filter before it, so that one trusted header lets a client check all the filters after it.

The filter hash is the double SHA-256 of the filter in its wire form, and each filter header is the double SHA-256 of that hash and the previous block's filter header. The chain starts from 32 zero bytes below the genesis block.

## Large filters

`matchFilter` and `matchAnyFilter` answer as Pearl's `Match` and `MatchAny` do, false positives included. When Pearl's `MatchAny` is asked about at least half as many items as the filter holds, it switches to a hash set, and that path compares only the low 32 bits of each value. On a filter of more than 5471 items it therefore matches some items that `Match` rejects.

pearljs does the same, so `matchFilter` and `matchAnyFilter` can disagree on a large filter. Either way, a match is only a reason to fetch the block.

## The scan

`filterBackend` scans the chain from the wallet's birthday, the height the wallet was created at, up to the tip. It works in rounds of blocks and stores each round as it finishes, so a restart goes on where the last one stopped. [Filter backend reference](../reference/compact-filters-calls.md) lists the scan's options and what a sync costs.

### Rounds

The scan starts from the block before `birthday`, taking that block's filter header from the node, or 32 zero bytes when `birthday` is 0. For each later block it fetches the hash, the header and the filter, with `getblockhash`, `getblockheader` and `getcfilter`, in rounds of `batchSize` blocks and `concurrency` heights at a time.

Each header must hash to its block's hash and name the block before it as its parent, back to where the scan started. Its bits must be within the network's proof-of-work limit, and its time must be after its parent's. A header that fails any of these fails the sync with `BLOCK_HEADER_INVALID`.

The backend chains the round's filters into filter headers itself rather than taking the node's headers. Once per round, it compares the last header with the node's `getcfilterheader`, and has each `crossCheck` endpoint confirm the round's last block and filter header.

With the filters checked, the backend matches them against the watched scripts and downloads only the blocks that match, with `getblock`. Each downloaded block must be the block of that hash, its transactions must hash to its merkle root, its witnesses must match the coinbase's commitment, and its certificate must be bound to its header.

From those blocks the backend keeps every transaction that pays a watched script or spends an output that pays one. Because Pearl's filters hold the scripts a block's inputs spend, a spend is found the same way as a payment.

Each round is written to the store in one batch: one record per block, the transactions found, and the cursor, which is the last block scanned. A block's record holds its hash, its filter header and, unless `keepFilters` is false, the filter itself. After a restart the backend reads them back and goes on from the cursor.

### Reorganizations

A reorganization is the node switching to a different chain, which replaces some of the most recent blocks. Each sync looks for one by comparing the stored hash at the cursor with the node's hash at that height. When they match, the scan goes on. When they differ, the backend walks back `concurrency` heights at a time to the last block on which both agree, deletes the records and transactions above it, and scans forward from there. A reorganization that reaches back past the birthday starts the scan over.

### New addresses

The backend watches a new address or script from the moment it is added. It also matches the blocks already passed against the new script, using the stored filters or, when they weren't kept, fetching them again with `getcfilter`. `watch` adds many at once, and the `watch` option sets the first ones.

### The mempool

After the blocks, the backend reads `getrawmempool` and fetches each new mempool transaction once, with `getrawtransaction`, to see whether it pays or spends the wallet's coins. When the node won't list its mempool, `status().mempool` is false, and the backend reports only confirmed outputs rather than guessing.

### Answering the wallet

The backend answers `getActivitySince` (the wallet's `ActivityScanner`) from what it has already found, so after the first sync a wallet asks one question for all its addresses instead of one per address. The answer is `null` when the block it is asked from isn't on the backend's chain or lies before the birthday, and the wallet then asks address by address.

`broadcast`, `estimateFeeRate` and the spend status of outputs that aren't the wallet's go to pearld as `pearldBackend` sends them. For the limited user, the `broadcast` option names another endpoint to broadcast through.

Any query syncs first when the last sync is older than `maxAge`, so a burst of calls costs one sync.

## Trust

The filters, headers, blocks and mempool all come from the node. The backend checks every block it downloads except its proof, so a node can make up blocks, and what keeps it honest is other nodes. An `Rpc` that verifies each block's proof as it is fetched checks the proof too ([Verify a block's proof](../guides/verify-proof.md)).

Without `crossCheck`, a lying node can show any chain it makes up that passes the header checks. It can hide confirmed payments and spends, and show confirmed payments that never happened. What pearljs catches on its own is a node that contradicts itself: a header that doesn't link to its parent, a filter that doesn't chain to the node's own filter header, or a block other than the one its hash names. [Blockbook trust](blockbook-trust.md) answers the same questions for a wallet that reads from a Blockbook.

With `crossCheck`, the backend compares the node with other endpoints. An endpoint can be any `Rpc`, such as a `PearldClient` over its own `httpTransport`, and it must have the same block and the same filter header as the node at two places: the block before the birthday and the last block of every round. Checking those two places is enough, because the block headers link every block of a round to its last block and the filter headers chain every filter, so agreement there confirms every block hash and every filter the scan used.

With one honest endpoint, every block the scan reads is on that endpoint's best chain, and every filter is that block's honest filter. The node can then neither hide a confirmed payment or spend involving a watched script, nor show one that the endpoint's chain doesn't hold. Three things remain the node's word even then:

- Mempool transactions, which it can hide or invent, and which count as unconfirmed.
- How far the scan has reached, which it can hold back by up to `crossCheckLag` blocks.
- Answers about what the scan didn't find itself: the spend status of outputs that aren't the wallet's, fee estimates, and a transaction's confirmation, which is accepted only for a block the scan confirmed and that holds the transaction.

## Failures

With `crossCheck`, the scan goes no further than the lowest tip among the node and the endpoints. A sync stops with an error when the sources don't line up:

| Cause | Error |
| --- | --- |
| The tips are more than `crossCheckLag` blocks apart | `CROSS_CHECK_FAILED` |
| An endpoint can't be asked | `CROSS_CHECK_FAILED` |
| An endpoint has a different block at a height | `CROSS_CHECK_FAILED` |
| A filter header differs | `FILTER_HEADER_MISMATCH` |

The round that fails isn't written and nothing from it is reported, so a wallet whose sync failed keeps the view its last sync gave it.

A single failure is often temporary. While a reorganization is still reaching the endpoints, a sync can fail this way, and the next one succeeds once they agree. A sync that keeps failing points to an endpoint that is down, far behind or on another chain, and that endpoint needs fixing or replacing. `crossCheckLag` sets the balance between the two: a larger value lets the scan trail the node further, and a smaller one makes a slow endpoint fail a sync more often.
