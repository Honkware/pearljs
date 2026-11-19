# Follower and inspection reference

## Events

| Event | Meaning |
| --- | --- |
| `connected` | The next block of the best chain, parsed. Its previous block is the one connected before it |
| `disconnected` | The newest block you were given has left the best chain: undo it |
| `synced` | The follower has reached the node's tip; sent once each time it catches up |

## Start points

| `from` | Starts at |
| --- | --- |
| `{ height }` | The block at that height, the first handed out |
| `{ hash }` | The block with that hash, the first handed out |
| `'tip'` | After the node's current tip |
| `{ cursor }` | A stored cursor |

## Follower options

| Option | Default | Effect |
| --- | --- | --- |
| `depth` | 100 (`DEFAULT_FOLLOW_DEPTH`) | Blocks remembered for reorganizations |
| `pollInterval` | 5 seconds | Interval of polling at the tip |
| `stopAtTip` | off | End at the tip instead of waiting |
| `ws` | none | A `PearlWsClient` whose block notifications wake the follower |
| `signal` | none | An `AbortSignal` that ends it without an error |
| `onRetry` | none | Hears of each request tried again |

## Reorganizations

A reorganization happens when the node switches to a different branch of the chain, so that some of the blocks it reported are no longer part of it.

- The follower checks each block against the one before it by its previous-block hash, so the events always describe a single chain.
- When the node has moved to another branch, the follower first hands back the blocks that left, newest first, down to the common ancestor, and only then the blocks of the new branch.
- It remembers the last 100 blocks it handed out (`depth`, `DEFAULT_FOLLOW_DEPTH` unless given), so its memory doesn't grow with the chain. The default is 100 because Pearl's blocks are 194 seconds apart and coinbases mature after 100 blocks.
- A reorganization that reaches below what it remembers ends it with `FOLLOW_REORG_TOO_DEEP`, and you then start again from an earlier height.
- The follower mirrors whichever node it asks. Behind a load balancer, pin it to one node, because two nodes a block apart look like a reorganization on every other request.

## Cursors and watchChain

`follower.cursor()` is where the follower stands after the last event it handed out: a height, a hash, and the hashes of the remembered blocks before it. It is plain JSON. Passed back as `from: { cursor }`, it makes the follower first hand back any of the cursor's blocks that left the chain while your program was down, then carry on.

`watchChain` is the same follower with a callback. It waits for the handler's promise before fetching the next block, and passes the handler the cursor to store:

```ts run
import { watchChain } from 'pearljs';
import type { FollowCursor } from 'pearljs';
import { SimulatedChain } from 'pearljs/testing';

const chain = new SimulatedChain({ premine: 6 });
const database = { heights: [] as number[], cursor: null as FollowCursor | null };

const index = (from: 'tip' | { height: number } | { cursor: FollowCursor }) =>
  watchChain(chain.rpc, {
    from,
    stopAtTip: true,
    onEvent: async (event, cursor) => {
      // One transaction in a real database: the rows and the cursor together.
      if (event.type === 'connected') database.heights.push(event.height);
      if (event.type === 'disconnected') database.heights.pop();
      database.cursor = JSON.parse(JSON.stringify(cursor)) as FollowCursor;
    },
  });

await index({ height: 0 }).done;
console.log(database.heights.join()); // 0,1,2,3,4,5,6

// While the indexer is down the node reorganizes three blocks deep.
chain.reorg(3);
await index({ cursor: database.cursor! }).done;
console.log(database.heights.join()); // 0,1,2,3,4,5,6,7
console.log(database.cursor!.hash === chain.tip.hash); // true
```

## Waiting at the tip

- Without `stopAtTip`, the follower waits at the tip and polls for new blocks every five seconds, or every `pollInterval` milliseconds.
- Given a `PearlWsClient` as `ws`, pearld's block notifications wake it at once ([Receive websocket notifications](../guides/websocket.md)). It still polls, at a slower pace, because a notification sent while the socket was down is never sent again.
- To stop it without an error, pass an `AbortSignal` as `signal`, or call `stop()` on a watch.
- Requests that fail because the node is down or restarting are tried again with a growing wait, and `onRetry` is told about each one.

## Coinbase fields

For a coinbase, `inspectTransaction` reports:

- the BIP 34 height;
- the payout outputs, with their addresses;
- the witness commitment;
- the text the miner wrote in its script (`coinbase.text`, "/P2SH/pearld/" from pearld's own miner);
- given the block's fees, what the miner left unclaimed.

`coinbaseText(script)` gives that text on its own:

- It skips the height, opcodes, and pushes of up to 8 bytes that are not printable ASCII, which is how extra nonces look.
- It reads the rest as UTF-8.
- It turns each run of control characters, format characters such as bidirectional overrides, line separators or bytes that are not UTF-8 into one space.
- Where the miner wrote the extra nonce or the tag as raw bytes rather than pushes, as many mainnet miners do, it gives the runs of at least four printable ASCII characters instead.

The result prints safely but is still whatever the miner wrote.

## Spend types

What `inspectTransaction` reports for each input's `spend`:

| `spend.type` | Meaning | Also reported |
| --- | --- | --- |
| `keyPath` | A P2TR output spent with one signature | `sighashType` |
| `scriptPath` | A P2TR or P2MR output spent through a leaf | `p2mr`, the `leaf` kind (`checksig`, `multiA`, `xmss`, `other`), `script`, `leafHash`, `controlBlock`, `keys`, `threshold`, `stack`, whether the leaf `commits` to the output, and `xmssIndex` for an XMSS signature |
| `coinbase` | The input of a coinbase | The transaction's `coinbase` field has the rest |
| `unsigned`, `unknown` | No witness yet, or one that cannot spend the output | |

## Outputs and ids

- Outputs carry their `type`, their `address` when they have one, and `data` for an OP_RETURN that is a single push.
- `wtxid` is the hash pearld shows as `hash`, for a coinbase as well.

## Address transactions

`searchRawTransactions(address, { vinExtra: true })` lists an address's transactions, with the address and value of every spent output attached. `prevoutsFromSearch` turns those into the prevouts that `inspectTransaction` takes, with no further request:

<!-- check-docs: declare const node: import('pearljs').PearldClient; declare const network: import('pearljs').PearlNetwork; declare const address: string; -->
```ts
import { inspectTransaction, parseTransaction, prevoutsFromSearch, resolvePrevouts } from 'pearljs';

for (const found of await node.searchRawTransactions(address, { skip: 0, count: 50, reverse: true, vinExtra: true })) {
  const tx = parseTransaction(found.hex!);
  // null when an input spent an output without an address: read those from their parents.
  const prevouts = prevoutsFromSearch(found, network) ?? (await resolvePrevouts(tx, node));
  const info = inspectTransaction(tx, prevouts, network);
  console.log(found.confirmations ?? 0, info.txid, info.fee);
}
```

pearld's address index holds Taproot addresses only. For a P2MR address, use `pearldBackend`, which finds its transactions by matching block filters ([Restore an account and pay from it](../guides/wallet-backends.md)), or index outputs by script yourself as you follow the chain.

## Mempool

`fetchMempool(rpc)` reads pearld's mempool into the map that `checkReplacement`, `checkPackageLimits` and `signalsReplacement` take: every transaction with its fee, parents ahead of their children. It needs no index. This example checks whether pearld would let a higher-fee payment replace one that is stuck, which [Relay policy and fee bumping](../guides/relay-policy-and-fee-bumping.md) covers in full:

```ts run
import { checkReplacement, fetchMempool, parsePearl, payFromAccount } from 'pearljs';
import { SimulatedChain, testAccount, testAddress } from 'pearljs/testing';

const chain = new SimulatedChain();
const account = testAccount();
const coin = chain.fund(account.deriveAddress(0), parsePearl('3'));
const pay = (feeRate: bigint) =>
  payFromAccount(account, { network: chain.network, utxos: [{ ...coin, index: 0 }], recipients: [{ address: testAddress(1), amount: 'max' }], feeRate, rbf: true });
const stuck = pay(1000n);
chain.accept(stuck.transaction);

const mempool = await fetchMempool(chain.rpc);
const bump = pay(5000n);
console.log(checkReplacement(bump.transaction, bump.fee, mempool)[0] === stuck.txid); // true: pearld would replace it
```

A mempool page that only lists fees and sizes needs less than this. `getRawMempoolVerbose` returns them, and a `PearlWsClient`'s `watchTransactions` reports new arrivals ([Receive websocket notifications](../guides/websocket.md)).

## Running totals

Everything a chain-statistics page shows, such as the supply, the difficulty and the total work, comes from each block's header and height. Add each block's share as it connects:

```ts run
import { blockSubsidy, difficultyForBits, followChain, formatPearl, isMoECertificate, networks, totalSupply, workForBits } from 'pearljs';
import { SimulatedChain } from 'pearljs/testing';

const chain = new SimulatedChain({ premine: 20 });
const network = chain.network;
let supply = 0n;
let work = 0n;
for await (const event of followChain(chain.rpc, { from: { height: 0 }, stopAtTip: true })) {
  if (event.type !== 'connected') continue;
  // Running totals, a block at a time. Undo them the same way on a disconnected block.
  supply += blockSubsidy(network, event.height);
  work += workForBits(event.block.header.bits);
  if (event.height === 20) {
    console.log('difficulty', difficultyForBits(event.block.header.bits, network));
    console.log('certificate', event.block.certificate?.version, event.block.certificate !== null && isMoECertificate(event.block.certificate));
  }
}
console.log(formatPearl(supply), 'PRL after block 20;', supply === totalSupply(network, 20)); // true
console.log('chain work', work.toString(16));
console.log(formatPearl(blockSubsidy(networks.mainnet, 120_000)), 'PRL per block on mainnet at height 120000');
```

- `totalSupply(network, height)` adds up every subsidy from genesis, so its run time grows with the height. Keep a running total as above, and call `totalSupply` now and then to check it.
- The figure is the most that can exist. A miner may claim less than the subsidy and fees, which `inspectTransaction` reports as `coinbase.unclaimed`, so an explorer that wants the exact supply subtracts those.
- [Consensus parameters](blocks-and-consensus-parameters.md) has the emission formula and the fork heights, and [Certificates and block checks](../concepts/blocks-and-consensus-certificates.md) explains what each block check establishes.

## pearld flags

The follower asks pearld only for `getbestblock`, `getblockhash` and `getblock`.

| For | pearld flag |
| --- | --- |
| `followChain`, block and header pages, `fetchMempool` | none; the limited RPC user is enough |
| `resolvePrevouts` and transaction pages for confirmed transactions | `--txindex` |
| `searchRawTransactions`, `pearldBackend`, address pages | `--addrindex`, which turns `--txindex` on |
| `prevoutsFromSearch` (`vinExtra`) | `--addrindex` and `--txindex` |
| Compact filters | on by default; off with `--nocfilters` |
