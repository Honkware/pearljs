// The coinbase of every block of the run, read through inspectTransaction
// with the block's height and fees: each claims exactly the subsidy plus the
// fees, and starts with its height. Runs last, so it sees every block the
// other files mined, on whichever branch the reorgs left the chain.

import { expect, it } from 'vitest';
import { blockSubsidy, inspectTransaction, parseBlock, resolvePrevouts } from '../src/index.js';
import type { Transaction } from '../src/index.js';
import { describeLive, network, pearld } from './chain.js';

describeLive('coinbases of the run', () => {
  it('finds every coinbase claiming its subsidy and fees to the grain, with its height', async () => {
    const tip = await pearld.getBlockCount();
    const known = new Map<string, Transaction>();
    let fees = 0n;
    for (let height = 1; height <= tip; height += 1) {
      const block = parseBlock(await pearld.getRawBlock(await pearld.getBlockHash(height)));
      for (const tx of block.transactions) known.set(tx.getId(), tx);
      let blockFees = 0n;
      for (const tx of block.transactions.slice(1)) {
        const spent = await resolvePrevouts(tx, pearld, { known });
        blockFees += spent.reduce((sum, prevout) => sum + prevout.value, 0n) - tx.outs.reduce((sum, out) => sum + out.value, 0n);
      }
      fees += blockFees;
      const coinbase = inspectTransaction(block.transactions[0]!, [], network, { height, blockFees }).coinbase!;
      expect(coinbase, `block ${height}`).toMatchObject({ height, subsidy: blockSubsidy(network, height), fees: blockFees, unclaimed: 0n });
      expect(coinbase.reward).toBe(blockSubsidy(network, height) + blockFees);
    }
    expect(fees).toBeGreaterThan(0n);
  });
});
