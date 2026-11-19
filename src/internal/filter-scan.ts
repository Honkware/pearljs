// The block-filter walk pearldBackend's P2MR scan and filterBackend share:
// each height's block hash, header and basic filter, fetched a few at a
// time, with the headers checked to form one chain from where the walk
// starts. Not a subpath export.

import { blockHash, blockHashHex, parseBlockHeader } from '../blockheader.js';
import type { PearlBlockHeader } from '../blockheader.js';
import { bitsToTarget } from '../consensus.js';
import { PearlError } from '../errors.js';
import type { CompactFilter } from '../gcs.js';
import type { PearlNetwork } from '../networks.js';
import type { PearldRpc } from '../rpc.js';
import { equalBytes } from './bytes.js';

/** One block's hash, header and filter, with the key to match it with. */
export interface HeightFilter {
  readonly height: number;
  readonly hash: string;
  readonly header: PearlBlockHeader;
  readonly filter: CompactFilter;
  readonly key: Uint8Array;
}

/** The block a walk goes on from: height -1 before genesis, and '' for a hash not yet known. */
export interface ChainPoint {
  readonly height: number;
  readonly hash: string;
}

// blockchain.MinTimestampDeltaSeconds: a block's time is at least this much after its parent's.
const MIN_TIMESTAMP_DELTA = 1;

/**
 * getblockhash, getblockheader and getcfilter for each height after `from`
 * up to `to`, `concurrency` heights at a time, in height order. Throws
 * BLOCK_HEADER_INVALID unless each header hashes to the hash given for its
 * height and names the block before it as its parent, back to `from`, with
 * bits within the network's proof-of-work limit and a time after its
 * parent's: the checks pearld makes of a header that need no proof.
 */
export async function fetchBlockFilters(
  node: Pick<PearldRpc, 'getBlockHash' | 'getRawBlockHeader' | 'getCFilter'>,
  network: PearlNetwork,
  from: ChainPoint,
  to: number,
  concurrency: number,
): Promise<HeightFilter[]> {
  const heights = Array.from({ length: Math.max(0, to - from.height) }, (_, i) => from.height + 1 + i);
  const fetchHeader = async (hash: string): Promise<PearlBlockHeader> => {
    const header = parseBlockHeader(await node.getRawBlockHeader(hash));
    if (blockHashHex(header) !== hash) throw invalidHeader(`getblockheader ${hash} returned the header of block ${blockHashHex(header)}`);
    return header;
  };
  const [parent, blocks] = await Promise.all([
    (async () => {
      if (from.height < 0) return null;
      const hash = from.hash === '' ? await node.getBlockHash(from.height) : from.hash;
      return { hash, header: await fetchHeader(hash) };
    })(),
    mapLimit(heights, concurrency, async (height) => {
      const hash = await node.getBlockHash(height);
      const [header, { filter, key }] = await Promise.all([fetchHeader(hash), node.getCFilter(hash)]);
      return { height, hash, header, filter, key };
    }),
  ]);
  const limit = network.powLimit;
  let prev = parent;
  for (const block of blocks) {
    const { header, height, hash } = block;
    const parentHash = prev === null ? new Uint8Array(32) : blockHash(prev.header);
    if (!equalBytes(header.prevBlock, parentHash)) {
      throw invalidHeader(`block ${hash} at height ${height} does not follow block ${prev?.hash ?? 'none'} at height ${height - 1}`);
    }
    const target = bitsToTarget(header.bits);
    if (target <= 0n || target > limit) throw invalidHeader(`block ${hash} at height ${height} has bits ${header.bits.toString(16)}, outside the network's proof-of-work limit`);
    if (prev !== null && header.timestamp < prev.header.timestamp + MIN_TIMESTAMP_DELTA) {
      throw invalidHeader(`block ${hash} at height ${height} has time ${header.timestamp}, not after its parent's ${prev.header.timestamp}`);
    }
    prev = block;
  }
  return blocks;
}

function invalidHeader(message: string): PearlError {
  return new PearlError('BLOCK_HEADER_INVALID', message);
}

// Runs `run` over items with at most `limit` calls in flight, keeping order.
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
