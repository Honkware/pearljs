# Relay policy reference

## Standardness checks

`prevouts` gives the script and value of each output the transaction spends, which the fee checks need. The checks run in the same order as pearld's:

1. The transaction has witness data, and is at least 65 bytes without it (`MIN_STANDARD_TX_NON_WITNESS_SIZE`).
2. It passes the consensus sanity checks (`checkSanity`): every output is P2TR, P2MR or OP_RETURN, no output or output total is above 21 billion PRL, no input appears twice, and no previous output is null.
3. The outputs do not spend more than the inputs.
4. The version is from 1 to `maxTxVersion`, which is 2 unless you set it (`MAX_STANDARD_TX_VERSION`).
5. The transaction is final at the given height and median time past.
6. It is at most 100000 vbytes (`MAX_STANDARD_TX_VSIZE`).
7. Every signature script is push-only and at most 1650 bytes.
8. It has at most one OP_RETURN output.
9. It has no dust output.
10. The fee is at least the relay fee.

Some of these need context that you pass in the options. Without `prevouts`, the input and fee checks (3 and 10) are skipped. Without `height`, the finality check is skipped, so pass the next block's height and the tip's median time past, both of which `getblockchaininfo` returns. If the node runs with a `--minrelaytxfee` other than the default of 1000 grain/kvB, pass that as `relayFeeRate`, and pass its maximum version as `maxTxVersion`.

A few things are outside `checkStandard`. It does not check signatures, sequence locks or coinbase maturity, and it does not look the inputs up, so a transaction that passes can still be refused because an input does not exist or is already spent. Conflicts with transactions already in the mempool and limits on chains of unconfirmed transactions have their own checks, under [Replace-by-fee](../guides/relay-policy-and-fee-bumping.md#replace-by-fee) and [Package limits](#package-limits). [Errors](errors.md#relay-policy) lists the codes `checkStandard` throws.

## Dust and the relay fee

The relay fee is a rate, 1000 grain/kvB by default (`DEFAULT_RELAY_FEE_RATE`), and `minRelayFee(vsize)` returns the smallest fee pearld relays for a transaction of that size at that rate.

An output is dust when it holds less than three times what it costs to create and later spend at the relay rate, and pearld refuses a transaction with a dust output. At the default rate, a P2TR or P2MR output under 333 grain is dust. `dustThreshold(script)` and `isDust(output, minRelayFee?)` give the answer for any script and rate:

```ts run
import { dustThreshold, feeForVsize, isDust, minRelayFee, p2tr } from 'pearljs';

const script = p2tr({ internalPubkey: new Uint8Array(32).fill(2) }).output;
console.log(dustThreshold(script)); // 333n
console.log(isDust({ script, value: 332n }), isDust({ script, value: 333n })); // true false
console.log(minRelayFee(154)); // 154n grain for 154 vbytes at the default rate
console.log(feeForVsize(154, 2500n)); // 385n: rounds up, so the fee never falls under the rate
```

## OP_RETURN outputs

An OP_RETURN output carries data and holds no coins. pearld's relay policy treats any script that starts with OP_RETURN as a data output and puts no limit on its size, so one is relayed as long as the whole transaction stays within 100000 vbytes. A transaction may have only one OP_RETURN output. `embed` still stops at 80 bytes (`MAX_EMBED_DATA_SIZE`), the size other software expects, so to carry more, build the script yourself.

## Size estimates

Other leaves need more detail. For those, give the sizes of the witness items that come before the leaf script in `stack`. If a key-path or script-path input's witness will end with an annex, give the annex's length, including its 0x50 tag, in `annexLength`. Any input can also be described as `{ type: 'witness', items }`, the sizes of all its witness items. The same description goes in a `Utxo`'s `spend` field, so that the payment builder prices that input correctly.

## Replacement rules

pearld accepts a replacement only if it:

- pays a higher fee rate than every transaction it evicts, including the descendants of the transactions it conflicts with, with each rate in grain/kvB truncated as pearld stores it;
- pays a fee at least as large as the fees of everything it evicts plus its own relay fee;
- evicts at most 100 transactions (`MAX_REPLACEMENT_EVICTIONS`);
- spends no output of a transaction it evicts;
- adds no unconfirmed input that its conflicts did not already spend.

## Child pays for parent

A transaction that did not signal replace-by-fee can still be sped up by a child: a new transaction that spends one of its outputs and pays enough for both. `cpfpChildFee(parents, childVsize, feeRate)` returns the fee the child needs so that it and its unconfirmed parents reach a fee rate together:

```ts run
import { cpfpChildFee, packageFeeRate } from 'pearljs';

const parent = { fee: 200n, vsize: 141 }; // 1418 grain/kvB, too low
const childVsize = 111;
const childFee = cpfpChildFee([parent], childVsize, 5000n);
console.log(childFee); // 1060n
console.log(packageFeeRate([parent, { fee: childFee, vsize: childVsize }])); // 5000n grain/kvB together
```

The child's fee is never less than its own relay fee, because pearld has no package relay and admits each transaction on its own merits.

pearld's own block templates rank each transaction by its own fee rate and take a child only after its parents, so in a block pearld builds, a child does not pull its parent in any earlier. A child speeds up its parent only with miners whose templates score a transaction together with its ancestors.

## Package limits

pearld limits how long a chain of unconfirmed transactions can grow. `checkPackageLimits(tx, mempool)` applies those limits and throws pearld's too-long-mempool-chain message if admitting the transaction would exceed one:

| Limit | Default | Constant |
| --- | --- | --- |
| The transaction and its unconfirmed ancestors, by count | 25 | `DEFAULT_ANCESTOR_COUNT_LIMIT` |
| The same, by size | 101000 vbytes | `DEFAULT_ANCESTOR_SIZE_LIMIT` |
| Any ancestor and its descendants, by count | 25 | `DEFAULT_DESCENDANT_COUNT_LIMIT` |

It takes the same mempool map as the replacement checks. Pass `replaced` with the txids from `checkReplacement`, as the example in [Replace-by-fee](../guides/relay-policy-and-fee-bumping.md#replace-by-fee) does, so that the transactions being evicted are not counted. Pass `limits` to use other values, where 0 turns a limit off, and `vsize` for a transaction that is not signed yet.
