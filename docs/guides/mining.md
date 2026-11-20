# Build a block from a template

A pool or a solo miner that builds its own blocks needs to turn pearld's block template into a block, attach the miner's proof, and check shares cheaply before paying for a proof check. `pearljs/mining` does each of those and measures a pool's effort and luck, and `pearljs/gateway` speaks pearl-gateway's miner protocol. [Pearl jobs and shares](../concepts/mining-jobs.md) explains the hashes these functions compute.

`pearljs/mining` builds blocks, computes every hash that binds a miner's work to a header, checks a certificate's public data against a target the way Pearl's verifier does before it looks at the proof, and keeps a pool's books. The ZK proof and a miner's plain proof are checked by `pearljs/verify-proof`, which runs Pearl's verifier compiled to WebAssembly ([Verify a block's proof](verify-proof.md)).

## Build the block skeleton

Ask pearld for a template and turn it into a skeleton, a block that is complete except for its proof:

<!-- check-docs: declare const publicData: Uint8Array, proof: Uint8Array; -->
```ts
import { blockSkeleton, checkBlockWork, sealBlock } from 'pearljs/mining';
import { miningJob } from 'pearljs/gateway';
import { verifyBlockProof } from 'pearljs/verify-proof';
import { customNetwork, networks, PearldClient, serializeBlock } from 'pearljs';

const pearld = new PearldClient({ url: 'https://127.0.0.1:44107', username: 'admin', password: process.env.PEARLD_RPC_PASS ?? '' });
// This regtest pearld is built without the FP8 fork code, so it never forks to V4.
const network = customNetwork(networks.regtest, { forkHeights: { fp8: 0 } });

const template = await pearld.getBlockTemplate({ capabilities: ['coinbasevalue'] });
const skeleton = blockSkeleton(template, {
  network,
  payTo: 'rprl1pnx2pd902qw3y7xa03xu7gzg8e73gnkaxue05y0kfv6n8ra57cywqg0h4qu',
  text: '/my-pool/',
});
const job = miningJob(skeleton); // what pearl-gateway hands a miner for this template
console.log(job.certVersion);
```

The network has to describe the node's forks, because the fork heights decide which certificate version a block needs. A pearld built without the code of Pearl's FP8 fork never reaches V4, and `customNetwork` with `fp8: 0` tells pearljs so. Without it, pearljs expects V4 certificates on regtest.

`blockSkeleton` checks the template against itself first ([Template checks](../reference/mining-checks.md#template-checks)) and then builds the coinbase as pearld does ([Coinbase](../reference/mining-checks.md#coinbase)).

## Seal it with the proof

Once Pearl's prover has produced public data and a proof for the header, seal them into the block and check it the way pearld will:

```ts continues
const block = sealBlock(skeleton, { publicData, proof });
checkBlockWork(block, network, skeleton.height);
const verdict = await verifyBlockProof(block); // the proof itself, as pearld will judge it
if (!verdict.valid) throw new Error(verdict.message);
```

`sealBlock` joins the certificate to the header, `checkBlockWork` adds the work rules, and `verifyBlockProof` checks the proof with Pearl's verifier ([Sealing](../reference/mining-checks.md#sealing)).

## Submit it

```ts continues
await pearld.submitBlock(serializeBlock(block));
```

## Run a pool

A pool checks each share cheaply before paying for a proof check ([Shares](../reference/mining-checks.md#shares)), talks to miners through pearl-gateway ([pearl-gateway](../reference/mining-checks.md#pearl-gateway)), and keeps its books with `shareValue`, `effort` and `luck` ([Effort and luck](../reference/mining-checks.md#effort-and-luck)).
