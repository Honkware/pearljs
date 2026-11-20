# Verify a block's proof

A pool, an explorer or a light client sometimes needs to know whether a block's proof of work is real without asking a pearld. `pearljs/verify-proof` answers that in Node or a browser: it is Pearl's own verifier, zk-pow from the fp8-scheme branch compiled to WebAssembly, and each check gives the verdict and message pearld would give.

`pearljs/mining` checks everything about a block's work except the proof itself ([Build a block from a template](mining.md)), and this module checks the proof. [Proof verification](../concepts/verify-proof-checks.md) explains what each check covers.

## Verify a block

Parse the block and pass it to `verifyBlockProof`:

<!-- check-docs: declare const raw: Uint8Array; -->
```ts fragment
import { parseBlock } from 'pearljs';
import { verifyBlockProof } from 'pearljs/verify-proof';

// raw: a block, as getblock with verbosity 0 returns it
const verdict = await verifyBlockProof(parseBlock(raw));
if (!verdict.valid) throw new Error(`proof refused: ${verdict.message}`);
```

`verifyBlockProof(block, options)` runs `verifyProof` on the block's header and certificate and resolves to a `ProofVerdict` ([Verdicts](../reference/verify-proof-limits.md#verdicts)), which says whether the proof was accepted and carries the verifier's message.

The proof covers the work, not the consensus rules around it. To judge a block as pearld does, also run `checkCertificateBinding`, `checkCertificateRules` and `checkBlockWork` (rank penalty included) from `pearljs/mining`.

## Verify a plain proof

A miner sends its solution to pearl-gateway as a plain proof in a `submitPlainProof` request. A plain proof holds the opened rows of the miner's matrices and the Merkle paths that commit them, and the gateway turns it into a certificate only when it wins a block. A pool that credits shares checks the plain proof with `verifyPlainProof(job, plainProof, { bits })`. [Shares and plain proofs](../reference/verify-proof-limits.md#shares-and-plain-proofs) has an example, the formats a plain proof is read in, and how a pool judges a certificate against its share bits with `verifyProof`.

## Load the verifier ahead of time

Importing the module loads nothing, and the main `pearljs` entry does not import it at all. The first verification reads the verifier and the circuit cache for its certificate version ([Files](../reference/verify-proof-limits.md#files)), and the cache for another version loads only when a certificate of that version arrives. To pay that cost before the first block comes in, call `loadProofVerifier(versions)`. It loads V2, V3 and V4 when no versions are named, and V1 only when asked, as in `loadProofVerifier([1])`.

In Node the files are read from `dist/verify-proof/` beside the module, and in a page they are fetched relative to it. [Loading the files](../reference/verify-proof-limits.md#loading-the-files) covers `locate`, WebCrypto and running the verifier off the main thread.

## Verify blocks from a wallet backend

`filterBackend` and `blockbookBackend` check everything pearld checks about a block except the proof. To have the proof checked as well, verify the blocks they download. `filterBackend` fetches blocks with `getblock` at verbosity 0 through the `Rpc` it is given, so wrap that `Rpc` in one that verifies each block before returning it:

<!-- check-docs: declare const rpc: import('pearljs').Rpc; -->
```ts fragment
import { filterBackend, networks, parseBlock, type Rpc } from 'pearljs';
import { verifyBlockProof } from 'pearljs/verify-proof';

function provingRpc(rpc: Rpc): Rpc {
  return {
    async call<T>(method: string, params?: readonly unknown[], options?: Parameters<Rpc['call']>[2]): Promise<T> {
      const result = await rpc.call<T>(method, params, options);
      if (method === 'getblock' && params?.[1] === 0) {
        const block = parseBlock(Uint8Array.from((result as string).match(/../g) ?? [], (b) => parseInt(b, 16)));
        if (block.certificate !== null && block.header.prevBlock.some((b) => b !== 0)) {
          const verdict = await verifyBlockProof(block);
          if (!verdict.valid) throw new Error(`block ${params[0]} fails its proof: ${verdict.message}`);
        }
      }
      return result;
    },
  };
}

const backend = filterBackend(provingRpc(rpc), { network: networks.mainnet, birthday: 0 });
```

The check skips the genesis block, whose previous block hash is all zeros. `blockbookBackend` fetches blocks with `BlockbookClient.getRawBlock` when `verifyBlocks` is on, so a subclass of `BlockbookClient` whose `getRawBlock` verifies the block before returning its hex does the same there.

## Next steps

- [Proof verification](../concepts/verify-proof-checks.md)
- [Proof verifier reference](../reference/verify-proof-limits.md)
- [Reproduce the verifier build](verify-proof-build.md)
- [Build a block from a template](mining.md)
