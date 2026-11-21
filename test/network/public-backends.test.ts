// The three backends read the same history, coins and balance for addresses
// other people have used on testnet2, with no coins of ours involved. The
// addresses are taken from recent blocks: outputs of ordinary transactions,
// P2TR and P2MR, whose address has a short history that the newest blocks
// have not touched, so the answer does not depend on which tip each source
// is at.

import { beforeAll, expect, it } from 'vitest';
import { fromOutputScript, parseBlock } from '../../src/index.js';
import { backends, blockbookRequests, view } from './compare.js';
import { blockbookUrl, describeTestnet, network, node, record } from './env.js';

const SETTLED = 6;
const WINDOW = 600;
let addresses: string[] = [];
let birthday = 0;

/**
 * Up to `count` addresses of each output kind from the last WINDOW blocks: P2TR ones with 1 to 3
 * transactions, none in the last SETTLED blocks or the mempool, and P2MR ones paid in that window,
 * whose earlier history, if any, Blockbook alone would show.
 */
async function settledAddresses(count: number): Promise<{ addresses: string[]; birthday: number }> {
  const tip = await node.getBlockCount();
  const found = new Map<string, number>();
  const kinds = new Map<number, number>();
  let lowest = tip;
  for (let height = tip - SETTLED; height > Math.max(0, tip - WINDOW) && found.size < count * 2; height--) {
    const block = parseBlock(await node.getRawBlock(await node.getBlockHash(height)));
    for (const tx of block.transactions.slice(1)) {
      for (const out of tx.outs) {
        const kind = out.script[0]!;
        if ((kind !== 0x51 && kind !== 0x52) || (kinds.get(kind) ?? 0) >= count) continue;
        const address = fromOutputScript(out.script, network);
        if (found.has(address)) continue;
        if (kind === 0x51) {
          const history = await node.searchRawTransactions(address, { count: 4 });
          if (history.length > 3 || history.some((entry) => (entry.confirmations ?? 0) <= SETTLED)) continue;
          const heights = await Promise.all(history.map(async (entry) => (await node.getBlockHeader(entry.blockhash!)).height));
          lowest = Math.min(lowest, ...heights);
        } else {
          // The address index holds no P2MR address: these are read through filters from the window's start.
          lowest = Math.min(lowest, tip - WINDOW);
        }
        found.set(address, height);
        kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
      }
    }
  }
  return { addresses: [...found.keys()], birthday: lowest };
}

describeTestnet('backends on addresses others have used', () => {
  beforeAll(async () => {
    ({ addresses, birthday } = await settledAddresses(2));
    expect(addresses.length).toBeGreaterThan(0);
    record('b public backends', 'addresses compared', '', { addresses, birthday });
  });

  it('pearldBackend and filterBackend agree on history, coins and balance', async () => {
    const { pearld, filters } = backends(birthday, null);
    const fromIndex = await view(pearld!, addresses);
    expect(await view(filters!, addresses)).toEqual(fromIndex);
    // Something to compare: every address has a transaction.
    expect((fromIndex as { history: { entries: unknown[] }[] }).history.every((item) => item.entries.length > 0)).toBe(true);
  });

  it.skipIf(blockbookUrl === undefined)('blockbookBackend with verifyBlocks agrees with pearldBackend', async () => {
    const before = blockbookRequests();
    const { pearld, blockbook } = backends(birthday);
    expect(await view(blockbook!, addresses)).toEqual(await view(pearld!, addresses));
    record('b public backends', 'Blockbook requests', '', { requests: blockbookRequests() - before });
  });
});
