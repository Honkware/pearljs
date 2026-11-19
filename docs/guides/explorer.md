# Follow the chain

An explorer, a deposit scanner and a payment watcher all read every block in order and keep something from each one. With `followChain`, a program follows the chain to its tip, handles reorganizations, resumes after a restart and waits for new blocks. [Decode transactions](explorer-transactions.md) continues with what to do with each block's transactions.

The four parts of such a program map onto pearljs like this:

| Task | pearljs |
| --- | --- |
| Read every block in order | `followChain` |
| Decode each block's transactions | `resolvePrevouts` and `inspectTransaction` ([Decode transactions](explorer-transactions.md)) |
| Undo blocks that a reorganization removes | `followChain` |
| Keep a few running totals | the consensus functions ([Running totals](../reference/explorer-data.md#running-totals)) |

The examples run against the simulated chain from `pearljs/testing`, so they run as written without a node. Against pearld, pass a `PearldClient` or a `PearlWsClient` wherever they pass `chain.rpc`. The follower needs no index and works for the limited RPC user ([pearld flags](../reference/explorer-data.md#pearld-flags)).

## Follow to the tip

`followChain(rpc, { from })` is an async iterator of three kinds of event ([Events](../reference/explorer-data.md#events)): `connected` for a block added to the chain, `disconnected` for a block a reorganization removed, and `synced` when the follower reaches the tip. This indexer keeps one row per block:

```ts run
import { blockVsize, customNetwork, followChain, networks, parsePearl } from 'pearljs';
import { SimulatedChain, testAddress } from 'pearljs/testing';

const chain = new SimulatedChain({ network: customNetwork(networks.regtest, { coinbaseMaturity: 2 }), premine: 4 });
chain.fund(testAddress(0), parsePearl('7'));

// What an indexer keeps: one row per block, newest last.
const rows: { height: number; hash: string; transactions: number; vsize: number }[] = [];

for await (const event of followChain(chain.rpc, { from: { height: 0 }, pollInterval: 10 })) {
  if (event.type === 'connected') {
    rows.push({ height: event.height, hash: event.hash, transactions: event.block.transactions.length, vsize: blockVsize(event.block) });
  } else if (event.type === 'disconnected') {
    rows.pop(); // always the newest row
  } else {
    console.log('at the tip:', rows.length, 'blocks, last', rows[rows.length - 1]!.height);
    if (event.height === 5) chain.reorg(2); // the node changes its mind about two blocks
    if (event.height === 6) break;
  }
}
console.log(rows.map((row) => row.hash).join() === chain.blocks.map((block) => block.hash).join()); // true
```

`from` says where to start ([Start points](../reference/explorer-data.md#start-points)). When the node moves to another branch, the follower first hands back the blocks that left, newest first, and then the blocks of the new branch. A program that undoes its newest block on every `disconnected` and applies every `connected`, as this one does, holds exactly the node's chain at every `synced`. [Reorganizations](../reference/explorer-data.md#reorganizations) has the depth it remembers and what happens below it.

## Resume after a restart

`follower.cursor()` is where the follower stands after the last event it handed out. It is plain JSON, so store it in the same database write as what you made of the event, and after a restart pass it back as `from: { cursor }`. `watchChain` is the same follower with a callback that receives the cursor to store, and [Cursors and watchChain](../reference/explorer-data.md#cursors-and-watchchain) has an indexer built on it.

Without `stopAtTip`, the follower waits at the tip for new blocks until you stop it ([Waiting at the tip](../reference/explorer-data.md#waiting-at-the-tip)).

## Next steps

- [Decode transactions](explorer-transactions.md) reads the transactions in each block.
- [Follower and inspection reference](../reference/explorer-data.md) lists the events, start points and options.
- [Test your application without a node](testing.md#test-code-written-against-a-node) puts an indexer through reorganizations, restarts and a failing node.
- [examples/follow-chain.ts](../../examples/follow-chain.ts) is a small indexer in one file.
