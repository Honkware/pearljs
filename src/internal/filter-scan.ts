// The block-filter walk pearldBackend's P2MR scan and filterBackend share:
// each height's block hash and basic filter, fetched a few at a time. Not a
// subpath export.

import type { CompactFilter } from '../gcs.js';
import type { PearldRpc } from '../rpc.js';

/** One block's hash and filter, with the key to match it with. */
export interface HeightFilter {
  readonly height: number;
  readonly hash: string;
  readonly filter: CompactFilter;
  readonly key: Uint8Array;
}

/** getblockhash then getcfilter for each height, `concurrency` heights at a time, in height order. */
export async function fetchBlockFilters(
  node: Pick<PearldRpc, 'getBlockHash' | 'getCFilter'>,
  heights: readonly number[],
  concurrency: number,
): Promise<HeightFilter[]> {
  return mapLimit(heights, concurrency, async (height) => {
    const hash = await node.getBlockHash(height);
    const { filter, key } = await node.getCFilter(hash);
    return { height, hash, filter, key };
  });
}

export async function mapLimit<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await run(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}
