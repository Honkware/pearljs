// Compact filters for every block of the run against a regtest pearld:
// getcfilter decodes, the filter headers chain from genesis to the tip as
// getcfilterheader reports them, a filter pearljs builds from the raw block
// and the scripts it spends is pearld's byte for byte, and the filter
// matches every script paid or spent in its block.

import { expect, it } from 'vitest';
import {
  BASIC_FILTER_TYPE,
  blockHash,
  buildBasicFilter,
  checkFilterHeaders,
  decodeFilter,
  deriveSigningAccountFromSeed,
  encodeFilter,
  filterHeader,
  filterHeaderHex,
  filterKey,
  matchAnyFilter,
  matchFilter,
  mnemonicToSeed,
  parseBlock,
  toOutputScript,
} from '../../src/index.js';
import type { CompactFilter } from '../../src/index.js';
import { describeLive, fund, minerScript, network, pearld, spentOutputs } from './chain.js';

const account = deriveSigningAccountFromSeed(
  mnemonicToSeed('cat swing flag economy stadium alone churn speed unique patch report train'),
  network,
);
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const ZERO_HEADER = '00'.repeat(32);

describeLive('compact filters', () => {
  it('builds the filter pearld serves for every block, and the headers chain from genesis', async () => {
    const tip = await pearld.getBlockCount();
    const chain: { filter: CompactFilter; header: string }[] = [];
    let spendingBlocks = 0;
    for (let height = 0; height <= tip; height++) {
      const hash = await pearld.getBlockHash(height);
      const served = await pearld.call<string>('getcfilter', [hash, BASIC_FILTER_TYPE]);
      const filter = decodeFilter(served);
      expect(hex(encodeFilter(filter))).toBe(served);
      const header = await pearld.call<string>('getcfilterheader', [hash, BASIC_FILTER_TYPE]);
      chain.push({ filter, header });

      const block = parseBlock(await pearld.getRawBlock(hash));
      const spent: Uint8Array[] = [];
      for (const tx of block.transactions.slice(1)) spent.push(...(await spentOutputs(tx)).map((prevout) => prevout.script));
      if (spent.length > 0) spendingBlocks += 1;
      const built = buildBasicFilter(block, spent);
      expect(hex(encodeFilter(built)), `filter of block ${height}`).toBe(served);

      const key = filterKey(hash);
      expect(key).toEqual(blockHash(block.header).slice(0, 16));
      const paid = block.transactions.flatMap((tx) => tx.outs.map((out) => out.script)).filter((script) => script[0] !== 0x6a);
      for (const script of [...paid, ...spent]) expect(matchFilter(filter, key, script)).toBe(true);
      // The genesis coinbase pays nothing a filter holds, and no query matches an empty filter.
      expect(paid.length > 0).toBe(height > 0);
      expect(filter.n > 0).toBe(height > 0);
      expect(matchAnyFilter(filter, key, [...paid, ...spent, minerScript])).toBe(height > 0);
    }
    expect(spendingBlocks).toBeGreaterThan(10);
    const last = checkFilterHeaders(ZERO_HEADER, chain);
    expect(filterHeaderHex(last)).toBe(chain[tip]!.header);
    // One wrong filter breaks the chain at its own position.
    const broken = [...chain];
    [broken[4], broken[5]] = [{ ...chain[4]!, filter: chain[5]!.filter }, chain[5]!];
    expect(() => checkFilterHeaders(ZERO_HEADER, broken)).toThrow('filter 4 does not match its header');
  });

  it('finds a funded address in the filter of its block and not in the blocks around it', async () => {
    const script = toOutputScript(account.deriveAddress(0), network);
    const before = await pearld.getBestBlockHash();
    const beforeHeader = await pearld.call<string>('getcfilterheader', [before, BASIC_FILTER_TYPE]);
    await fund([{ script, value: 1_000_000n }]);
    const hash = await pearld.getBestBlockHash();

    const fetched = await pearld.getCFilter(hash, beforeHeader);
    expect(fetched.header).toBe(filterHeaderHex(filterHeader(fetched.filter, beforeHeader)));
    expect(matchFilter(fetched.filter, fetched.key, script)).toBe(true);
    expect(matchFilter(fetched.filter, fetched.key, minerScript)).toBe(true);
    // A false positive has odds of one in 784931 per item.
    const absent = toOutputScript(account.deriveAddress(1), network);
    expect(matchFilter(fetched.filter, fetched.key, absent)).toBe(false);
    const earlier = await pearld.getCFilter(before);
    expect(matchFilter(earlier.filter, earlier.key, script)).toBe(false);
    // Checked against the wrong previous header, the same filter is refused.
    await expect(pearld.getCFilter(hash, ZERO_HEADER)).rejects.toThrow('does not match its header');
  });
});
