// What pearld reports on a chain that has blocks but has never seen a
// transaction: an empty mempool and a fee estimate of zero. Runs before every
// other file, which the sequencer in vitest.live.config.ts sees to.

import { expect, it } from 'vitest';
import { RPC_ERROR_CODES } from '../src/index.js';
import { describeLive, pearld } from './chain.js';

describeLive('fresh chain', () => {
  it('has the setup blocks and an empty mempool', async () => {
    expect(await pearld.getBlockCount()).toBe(101);
    expect(await pearld.getMempoolInfo()).toEqual({ size: 0, bytes: 0, cap: 300_000_000 });
    expect(await pearld.getRawMempool()).toEqual([]);
    expect(await pearld.getRawMempoolVerbose()).toEqual({});
  });

  it('estimates a fee of zero for every target until transactions have confirmed', async () => {
    for (const blocks of [1, 2, 6, 25]) expect(await pearld.estimateFee(blocks)).toBe(0n);
  });

  it('refuses estimates for no blocks and for more than 25', async () => {
    await expect(pearld.estimateFee(0)).rejects.toMatchObject({
      kind: 'rpc',
      rpcCode: RPC_ERROR_CODES.INVALID_PARAMETER,
      message: 'estimatefee: Parameter NumBlocks must be positive (code -8)',
    });
    await expect(pearld.estimateFee(26)).rejects.toMatchObject({
      kind: 'rpc',
      rpcCode: RPC_ERROR_CODES.MISC,
      message: 'estimatefee: can only estimate fees for up to 25 blocks from now (code -1)',
    });
  });
});
