# Consensus parameters

## Fork heights

Each network object carries Pearl's fork heights in `forkHeights`, with 0 where a fork is off:

| Fork | `forkHeights` field | Mainnet height | Effect |
| --- | --- | --- | --- |
| MoE | `moe` | 71935 | Blocks need a V2 certificate |
| Dense only | `denseOnly` | 91630 | MoE proofs are refused |
| Rank penalty | `rankPenalty` | 96251 | A V2 or V3 tile's bound shrinks as its noise rank grows past 128 |
| Salted seed | `saltedSeed` | 99000 | Blocks need a V3 certificate |
| FP8 | `fp8` | off (0) | Blocks need a V4 certificate |

On mainnet, then, blocks need a V1 certificate before 71935, V2 from there, and V3 from 99000.

The FP8 heights are those of Pearl's fp8-scheme branch, which ships it off on mainnet. `testnet` forks at 67415 and `testnet2` at 150283, and regtest and simnet need V4 from block 1. A pearld built from Pearl's master branch never forks; describe its chain with `customNetwork(network, { forkHeights: { fp8: 0 } })`, for a local regtest node too.

`requiredCertVersion(network, height)` answers for any height and network:

```ts run
import { networks, requiredCertVersion } from 'pearljs';

for (const height of [71934, 71935, 98999, 99000]) {
  console.log(height, 'V' + requiredCertVersion(networks.mainnet, height));
}
console.log(requiredCertVersion(networks.testnet, 67414), requiredCertVersion(networks.testnet, 67415)); // 3 4
console.log(networks.testnet2.forkHeights);
```

## Network fields

| Field | Value |
| --- | --- |
| `checkpoints` | one every 10000 blocks up to 120000 on mainnet; none on the others |
| `targetSpacing` | 194 seconds |
| `wtemaHalfLife` | one week |
| `coinbaseMaturity` | 100 everywhere, also exported as `COINBASE_MATURITY` |
| `dnsSeeds`, `genesisHash`, `magic` | per network |
| `powNoRetargeting`, `reduceMinDifficulty`, `minDiffReductionTime`, `powLimit`, `powLimitBits` | per network ([Difficulty and work](#difficulty-and-work)) |

## Custom networks

The network objects are frozen: nothing that holds one can change it for the rest of the program. For a private chain, or a test that wants other numbers, `customNetwork(base, changes)` returns a new frozen network that differs from its base in the fields given:

```ts run
import { customNetwork, networks, requiredCertVersion } from 'pearljs';

const devnet = customNetwork(networks.regtest, { coinbaseMaturity: 10, forkHeights: { saltedSeed: 500 } });
console.log(devnet.coinbaseMaturity, networks.regtest.coinbaseMaturity); // 10 100
console.log(requiredCertVersion(devnet, 499), requiredCertVersion(devnet, 500)); // 2 3
console.log(Object.isFrozen(networks.mainnet), devnet.name); // true regtest
```

A variant keeps its base's `name`, which is how the RPC port tables and Oyster's backups tell networks apart.

## Difficulty and work

Pearl retargets difficulty every block with a WTEMA filter, not every 2016 blocks as Bitcoin does.

| Function | Pearl's name | Result |
| --- | --- | --- |
| `bitsToTarget(bits)` | `CompactToBig` | The target that compact bits encode |
| `targetToBits(target)` | `BigToCompact` | Compact bits for a target |
| `workForBits(bits)` | `CalcWork` | The work a block adds to its chain, 2^256 / (target + 1) |
| `difficultyForBits(bits, network)` | what `getdifficulty` and `getblock` report | The network's `powLimitBits` target over the block's, rounded to 8 decimals |
| `nextBlockBits(network, last, time)` | `calcNextRequiredDifficulty` | The bits a block at `time` must carry on top of `last` |

Regtest and simnet divide by the target of 0x1e010000 where mainnet and the testnets use 0x1b00ffff, so a regtest difficulty is not comparable with a mainnet one.

`nextBlockBits` takes the last block's bits and timestamp and its parent's timestamp. Each block moves the target by (t - 194) / 604800 of itself, where t is the seconds the last block took after its parent, rounding down, and keeps it between 1 and `powLimit`:

```ts run
import { networks, nextBlockBits } from 'pearljs';

const last = { bits: 0x17445b25, timestamp: 1795000600, parentTimestamp: 1795000000 };
console.log(nextBlockBits(networks.mainnet, last, 1795000601).toString(16)); // 174466e4
console.log(nextBlockBits(networks.mainnet, { ...last, timestamp: 1795000000 }, 1795000001).toString(16)); // 17445588
```

Regtest and simnet do not retarget (`powNoRetargeting`): every block takes `powLimitBits`. The testnets, regtest and simnet set `reduceMinDifficulty`, so a block more than `minDiffReductionTime` after the last (4 hours on the testnets) may also take `powLimitBits`.

## Emission

Pearl's emission, unlike Bitcoin's, has no halvings. Block h pays

```text
2.1 billion PRL * E / ((h + E)(h - 1 + E))    grain, rounded down
```

where E is four years of blocks, 650226. Block 1 pays 322964134063 grain (about 3229.64 PRL). Half of the 2.1 billion PRL is out after four years, and the rest follows ever more slowly.

```ts run
import { EMISSION_LIMIT, MAX_GRAIN, blockSubsidy, formatPearl, networks, totalSupply } from 'pearljs';

console.log(blockSubsidy(networks.mainnet, 1)); // 322964134063n
console.log(formatPearl(blockSubsidy(networks.mainnet, 650226))); // a quarter of that, four years in
console.log(formatPearl(totalSupply(networks.mainnet, 10000))); // everything mined through block 10000
console.log(formatPearl(EMISSION_LIMIT), formatPearl(MAX_GRAIN)); // 2100000000 21000000000
```

| Name | Value |
| --- | --- |
| `blockSubsidy` | The formula |
| `totalSupply` | The formula summed from genesis to a height, block by block, so it is slow for large heights |
| `EMISSION_LIMIT` | The bound the curve approaches, 2.1 billion PRL |
| `MAX_GRAIN` | 21 billion PRL, ten times `EMISSION_LIMIT`: the largest amount a transaction output may carry, not the supply |

[Follow the chain](../guides/explorer.md) reads blocks from a node in order and keeps these totals as it goes.
