// The three wallet backends over the same chain, and what they say about a
// set of addresses in a form that can be compared: pearldBackend over the
// node's address index, filterBackend over its compact filters, and
// blockbookBackend over the public Blockbook, through a fetch that counts
// every request against the session's budget.

import {
  BlockbookClient,
  blockbookBackend,
  filterBackend,
  pearldBackend,
  type BlockbookBackendOptions,
  type WalletBackend,
} from '../../src/index.js';
import { budgetFetch, requestsUsed } from '../../scripts/network/blockbook-budget.mjs';
import { blockbookUrl, network, node } from './env.js';

export const blockbookRequests = (): number => (requestsUsed as () => number)();

export function blockbookClient(): BlockbookClient {
  return new BlockbookClient({ url: blockbookUrl!, network, fetch: (budgetFetch as () => typeof fetch)(), maxConcurrentRequests: 2 });
}

/** Waits until the Blockbook has indexed the node's best block: it trails a new block by some seconds, and its mempool view by more. */
export async function blockbookAtTip(timeout = 180_000): Promise<void> {
  const client = blockbookClient();
  for (const deadline = Date.now() + timeout; ; ) {
    const tip = await node.getBestBlockHash();
    if ((await client.getBlockHash()) === tip) return;
    if (Date.now() > deadline) throw new Error(`the Blockbook has not indexed the node's best block ${tip} after ${timeout} ms`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

export function backends(birthday: number, blockbook: BlockbookBackendOptions | null = { verifyBlocks: true }): Record<string, WalletBackend> {
  const all: Record<string, WalletBackend> = {
    pearld: pearldBackend(node, { network, scanFrom: birthday }),
    filters: filterBackend(node, { network, birthday }),
  };
  if (blockbook !== null && blockbookUrl !== undefined) all.blockbook = blockbookBackend(blockbookClient(), blockbook);
  return all;
}

const sortBy = <T>(items: T[], key: (item: T) => string): T[] => [...items].sort((a, b) => key(a).localeCompare(key(b)));

/** History, coins and balance of the addresses, without the fields that move with the tip. */
export async function view(backend: WalletBackend, addresses: readonly string[]): Promise<unknown> {
  const history = [];
  for (const address of addresses) {
    const entries = await backend.getHistory(address);
    history.push({
      address,
      entries: sortBy(entries, (entry) => entry.txid).map((entry) => ({
        txid: entry.txid,
        block: entry.block === null ? null : { height: entry.block.height, hash: entry.block.hash },
        received: entry.received,
        spent: entry.spent,
      })),
    });
  }
  const coins = sortBy(await backend.getUtxos(addresses), (coin) => `${coin.txid}:${coin.vout}`).map((coin) => ({
    outpoint: `${coin.txid}:${coin.vout}`,
    address: coin.address,
    value: coin.value,
    script: Buffer.from(coin.script).toString('hex'),
    coinbase: coin.coinbase,
    inBlock: coin.confirmations > 0,
  }));
  const balance = await backend.getBalance(addresses);
  return { history, coins, balance };
}
