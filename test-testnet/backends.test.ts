// One wallet's state through the three backends at the same tip. Each
// backend discovers, from scratch, a watch-only copy of the test wallet's
// account 0 (from its xpub, in a memory store) and must find the same
// history, coins and balance as the wallet itself over pearldBackend:
// filterBackend through the node's compact filters, checked against its
// filter header chain, and blockbookBackend through the public Blockbook,
// with verifyBlocks. useXpub hands the server an account's xpub, so it is
// tried on a throwaway account 2 that is funded for the test and emptied
// after it.

import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  PearlWallet,
  blockbookBackend,
  createMemoryStore,
  filterBackend,
  pearldBackend,
  type WalletBackend,
} from '../src/index.js';
import { blockbookClient, blockbookRequests } from './compare.js';
import { blockbookUrl, confirmed, describeTestnet, feeRate, fundsOrSkip, home, network, node, openWallet, record } from './env.js';

// Small, so a Blockbook asked address by address stays inside the request budget.
const GAP = 4;
let wallet: PearlWallet;
let skip: string | null = null;
let birthday = 0;

/** What one account holds, in a form two wallets on different backends can be compared by. Amounts in history entries cover the whole wallet, so only coins and balance carry them. */
function state(subject: PearlWallet, account: string): unknown {
  const live = new Set(['pending', 'confirmed']);
  return {
    history: subject
      .history({ account, limit: 10_000 })
      .filter((entry) => live.has(entry.status))
      .map((entry) => ({ txid: entry.txid, block: entry.block?.hash ?? null }))
      .sort((a, b) => a.txid.localeCompare(b.txid)),
    coins: subject
      .coins()
      .filter((coin) => coin.owner.type === 'account' && coin.owner.account === account)
      .map((coin) => `${coin.txid}:${coin.vout}=${coin.value}`)
      .sort(),
    balance: subject.balance({ account }),
  };
}

/** A watch-only wallet of one account's xpub over a backend, synced from nothing. */
async function watcher(backend: WalletBackend, xpub: string): Promise<PearlWallet> {
  const copy = await PearlWallet.create({ store: createMemoryStore(), backend, watchOnly: xpub, gapLimit: GAP });
  await copy.sync({ full: true });
  return copy;
}

/** Retries until the node's tip is the same before and after, so every source was read at one tip. */
async function atOneTip<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const before = await node.getBestBlockHash();
    const result = await read();
    if ((await node.getBestBlockHash()) === before || attempt === 3) return result;
  }
}

describeTestnet('one wallet through pearldBackend, filterBackend and blockbookBackend', () => {
  beforeAll(async () => {
    wallet = await openWallet();
    skip = await fundsOrSkip(wallet, 1_000_000n);
    const heights = wallet.history({ limit: 10_000 }).flatMap((entry) => (entry.block === null ? [] : [entry.block.height]));
    birthday = Math.max(0, Math.min(...heights) - 1);
  });
  afterAll(async () => {
    await wallet?.close();
  });

  it('finds the same history, coins and balance through all three for account 0', async (context) => {
    if (skip !== null) context.skip(skip);
    const xpub = wallet.accounts().find((entry) => entry.id === '0')!.xpub;
    await atOneTip(async () => {
      await wallet.sync();
      const expected = state(wallet, '0');
      const watchers: [string, WalletBackend][] = [
        ['pearld', pearldBackend(node, { network })],
        ['filters', filterBackend(node, { network, birthday })],
      ];
      if (blockbookUrl !== undefined) watchers.push(['blockbook', blockbookBackend(blockbookClient(), { verifyBlocks: true })]);
      for (const [name, backend] of watchers) {
        const before = blockbookRequests();
        const copy = await watcher(backend, xpub);
        expect(state(copy, copy.accounts()[0]!.id), name).toEqual(expected);
        if (name === 'blockbook') console.log(`blockbook requests for account 0: ${blockbookRequests() - before}`);
      }
    });
  });

  it.skipIf(blockbookUrl === undefined)('finds the same through Blockbook asked by xpub, for a throwaway account', async (context) => {
    if (skip !== null) context.skip(skip);
    if (!wallet.accounts().some((entry) => entry.id === '2')) await wallet.addAccount(2, { label: 'throwaway for useXpub' });
    const to = await wallet.receiveAddress({ account: '2' });
    const funding = await wallet.send({ recipients: [{ address: to, amount: 300_000n }], feeRate: await feeRate(), label: 'backends: fund account 2' });
    record('b backends', 'fund account 2', funding.txid);
    await confirmed(funding.txid);
    const xpub = wallet.accounts().find((entry) => entry.id === '2')!.xpub;
    await atOneTip(async () => {
      await wallet.sync();
      const before = blockbookRequests();
      const copy = await watcher(blockbookBackend(blockbookClient(), { verifyBlocks: true, useXpub: true }), xpub);
      console.log(`blockbook requests for account 2 by xpub: ${blockbookRequests() - before}`);
      expect(state(copy, copy.accounts()[0]!.id)).toEqual(state(wallet, '2'));
    });
    const back = await wallet.send({ recipients: [{ address: home(), amount: 'max' }], from: { account: '2' }, feeRate: await feeRate(), label: 'backends: empty account 2' });
    record('b backends', 'account 2 send-max home', back.txid);
    await confirmed(back.txid);
  });
});
