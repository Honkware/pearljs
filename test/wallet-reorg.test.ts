// Reorgs the wallet did not watch happen: a payment confirmed and synced,
// then taken out by a reorg of some depth while the wallet was offline, with
// any number of blocks mined on top before the next sync. Depths below, at
// and far beyond reorgDepth; payments replaced by a conflicting transaction,
// carried into another block, and sends of the wallet's own replaced by a
// confirmed double spend. Whatever the depth, a transaction the backend no
// longer places in its recorded block does not stay confirmed.

import { describe, expect, it } from 'vitest';
import { PearlWallet, createMemoryStore, createTransaction, addInputByTxid, networks, parsePearl, toOutputScript } from '../src/index.js';
import type { PearlWsEvents, WalletEvents, WalletNotifier } from '../src/index.js';
import { computeLedger } from '../src/wallet-ledger.js';
import type { LedgerTransaction } from '../src/wallet-ledger.js';
import { FAST_KDF, FakeChain, MNEMONIC, PASSPHRASE, STRANGER } from './wallet-chain.js';

const prl = (text: string): bigint => parsePearl(text);
const REORG_DEPTH = 6;

async function walletWith(chain: FakeChain, reorgDepth = REORG_DEPTH): Promise<PearlWallet> {
  return PearlWallet.create({ store: createMemoryStore(), backend: chain, transactions: chain, passphrase: PASSPHRASE, mnemonic: MNEMONIC, kdf: FAST_KDF, gapLimit: 10, reorgDepth });
}

// A wallet with an old payment far below everything, synced.
async function settled(): Promise<{ chain: FakeChain; wallet: PearlWallet; old: string }> {
  const chain = new FakeChain();
  const wallet = await walletWith(chain);
  const old = chain.pay(await wallet.receiveAddress(), prl('1')).getId();
  chain.mine(3 * REORG_DEPTH);
  await wallet.sync();
  return { chain, wallet, old };
}

const depths = [1, 2, REORG_DEPTH - 1, REORG_DEPTH, REORG_DEPTH + 1, 4 * REORG_DEPTH];
const growths = [0, 1, REORG_DEPTH, 20 * REORG_DEPTH];

describe('wallet: reorgs while offline', () => {
  it.each(depths.flatMap((depth) => growths.map((growth) => [depth, growth] as const)))(
    'unconfirms a payment a reorg of depth %i replaced, with %i blocks mined since',
    async (depth, growth) => {
      const { chain, wallet, old } = await settled();
      const payment = chain.pay(await wallet.receiveAddress(), prl('7')).getId();
      chain.mine(depth);
      await wallet.sync();
      expect(wallet.transaction(payment)).toMatchObject({ status: 'confirmed', confirmations: depth });
      const reorgs: WalletEvents['reorg'][] = [];
      wallet.on('reorg', (event) => reorgs.push(event));
      const forkHeight = chain.height - depth + 1;

      chain.reorg(depth, { replace: [payment] });
      chain.mine(growth);
      expect(await chain.getTransaction(payment)).toBeNull();
      await wallet.refresh();

      expect(wallet.transaction(payment)).toMatchObject({ status: 'conflicted', confirmations: 0, block: null });
      expect(wallet.coins().map((coin) => coin.txid)).toEqual([old]);
      expect(wallet.balance()).toMatchObject({ confirmed: prl('1'), unconfirmed: 0n, total: prl('1') });
      expect(wallet.transaction(old)!.status).toBe('confirmed');
      expect(reorgs).toHaveLength(1);
      expect(reorgs[0]!.forkHeight).toBe(forkHeight);
      await wallet.sync({ full: true });
      expect(wallet.balance().total).toBe(prl('1'));
    },
  );

  it.each(depths)('follows a payment into its new block after a reorg of depth %i', async (depth) => {
    const { chain, wallet } = await settled();
    const payment = chain.pay(await wallet.receiveAddress(), prl('7')).getId();
    chain.mine(depth);
    await wallet.sync();
    const before = wallet.transaction(payment)!.block!;
    chain.reorg(depth);
    chain.mine(5 * REORG_DEPTH);
    await wallet.sync();
    const after = wallet.transaction(payment)!;
    expect(after.status).toBe('confirmed');
    expect(after.block).toEqual((await chain.getTransaction(payment))!.block);
    expect(after.block!.hash).not.toBe(before.hash);
    expect(wallet.balance().confirmed).toBe(prl('8'));
  });

  it('catches the audited case: one block replaced, 105 mined on top, default depth', async () => {
    const chain = new FakeChain();
    const wallet = await walletWith(chain, 100);
    const payment = chain.pay(await wallet.receiveAddress(), prl('7')).getId();
    chain.mine();
    await wallet.sync();
    chain.reorg(1, { replace: [payment] });
    chain.mine(105);
    await wallet.sync();
    expect(wallet.transaction(payment)!.status).toBe('conflicted');
    expect(wallet.balance().total).toBe(0n);
    expect(wallet.coins()).toEqual([]);
  });

  it.each(depths)('settles a send of its own that a reorg of depth %i replaced with a confirmed double spend', async (depth) => {
    const { chain, wallet } = await settled();
    await wallet.unlock(PASSPHRASE);
    const sent = await wallet.send({ recipients: [{ address: STRANGER, amount: prl('0.4') }], feeRate: 2000n });
    chain.mine(depth);
    await wallet.sync();
    expect(wallet.balance().confirmed).toBe(prl('0.6') - sent.fee);

    chain.reorg(depth, { replace: [sent.txid] });
    chain.mine(3 * REORG_DEPTH);
    await wallet.sync();

    // The rival spends the wallet's coin, so the wallet records it, and only it is active.
    const entry = wallet.transaction(sent.txid)!;
    expect(entry).toMatchObject({ status: 'conflicted', block: null });
    const rival = wallet.transaction(entry.by!)!;
    expect(rival).toMatchObject({ status: 'confirmed', direction: 'outgoing' });
    expect(rival.block).toEqual((await chain.getTransaction(rival.txid))!.block);
    expect(wallet.balance().total).toBe(0n);
    expect(wallet.coins()).toEqual([]);
  });

  it('rolls back everything a deep reorg removed and keeps what stands below it', async () => {
    const { chain, wallet, old } = await settled();
    const kept = chain.pay(await wallet.receiveAddress(), prl('2')).getId();
    chain.mine(2);
    const base = chain.height;
    const replaced = chain.pay(await wallet.receiveAddress(), prl('3')).getId();
    chain.mine(REORG_DEPTH);
    const carried = chain.pay(await wallet.receiveAddress(), prl('4')).getId();
    chain.mine(REORG_DEPTH);
    const reward = chain.mine(1, { coinbaseTo: await wallet.receiveAddress(), value: prl('50') })[0]!;
    await wallet.sync();
    expect(wallet.balance().total).toBe(prl('60'));

    chain.reorg(chain.height - base, { replace: [replaced], mine: 1 });
    expect(chain.height).toBeLessThan(reward.height);
    await wallet.sync();

    expect(wallet.transaction(old)!.status).toBe('confirmed');
    expect(wallet.transaction(kept)!.status).toBe('confirmed');
    expect(wallet.transaction(replaced)!.status).toBe('conflicted');
    expect(wallet.transaction(carried)).toMatchObject({ status: 'confirmed', block: (await chain.getTransaction(carried))!.block });
    expect(wallet.history().find((entry) => entry.coinbase)!.status).toBe('orphaned');
    expect(wallet.balance()).toMatchObject({ confirmed: prl('7'), immature: 0n, total: prl('7') });
  });

  it('does not leave a transaction confirmed when the backend no longer knows it', async () => {
    const { chain, wallet, old } = await settled();
    const getTransaction = chain.getTransaction.bind(chain);
    chain.getTransaction = async (txid) => (txid === old ? null : getTransaction(txid));
    chain.mine(50 * REORG_DEPTH);
    await wallet.refresh();
    expect(wallet.transaction(old)).toMatchObject({ status: 'pending', block: null, missing: true });
    expect(wallet.balance()).toMatchObject({ confirmed: 0n, unconfirmed: prl('1') });
    chain.getTransaction = getTransaction;
    chain.mine();
    await wallet.refresh();
    expect(wallet.transaction(old)!.status).toBe('confirmed');
  });

  it('checks everything within the depth of the tip it last synced to, even under a newer block that stands', async () => {
    const { chain, wallet, old } = await settled();
    const lost = chain.pay(await wallet.receiveAddress(), prl('2')).getId();
    chain.mine();
    const newer = chain.pay(await wallet.receiveAddress(), prl('3')).getId();
    chain.mine();
    await wallet.sync();
    // A backend whose answers do not hang together: the newer block stands, a transaction just under it is gone.
    const getTransaction = chain.getTransaction.bind(chain);
    chain.getTransaction = async (txid) => (txid === lost ? null : getTransaction(txid));
    chain.mine(50 * REORG_DEPTH);
    await wallet.refresh();
    expect(wallet.transaction(lost)).toMatchObject({ status: 'pending', block: null });
    expect(wallet.transaction(newer)!.status).toBe('confirmed');
    expect(wallet.transaction(old)!.status).toBe('confirmed');
    expect(wallet.balance()).toMatchObject({ confirmed: prl('4'), unconfirmed: prl('2') });
  });

  it('checks one anchoring block, not its whole history, when the tip moves and nothing changed', async () => {
    const chain = new FakeChain();
    const wallet = await walletWith(chain);
    for (let i = 0; i < 12; i += 1) {
      chain.pay(await wallet.receiveAddress(), prl('1'));
      chain.mine(2);
      await wallet.sync();
    }
    chain.mine(3 * REORG_DEPTH);
    await wallet.sync();
    chain.mine(40);
    chain.calls.clear();
    await wallet.refresh();
    expect(chain.calls.get('getTransaction')).toBe(1);
    expect(wallet.balance().confirmed).toBe(prl('12'));
  });

  it('takes a confirmed transaction over a recorded one spending the same output, as soon as it is told', async () => {
    const { chain, wallet, old } = await settled();
    await wallet.unlock(PASSPHRASE);
    const sent = await wallet.send({ recipients: [{ address: STRANGER, amount: prl('0.4') }], feeRate: 2000n });
    chain.mine();
    await wallet.sync();
    expect(wallet.transaction(sent.txid)!.status).toBe('confirmed');
    // The reorg happens, and the first the wallet hears of it is the rival in a block.
    chain.reorg(1, { replace: [sent.txid] });
    const block = chain.blocks[chain.height - 1]!;
    const rival = block.txs.find((tx) => !tx.isCoinbase())!;
    const listeners = new Map<string, (value: never) => void>();
    const notifier = {
      on: (event: string, listener: (value: never) => void) => (listeners.set(event, listener), () => undefined),
      watchBlocks: () => () => undefined,
      notifyReceived: async () => undefined,
    } as unknown as WalletNotifier;
    const stop = wallet.watch({ notifier, intervalMs: 3_600_000 });
    (listeners.get('redeemingtx') as (value: PearlWsEvents['redeemingtx']) => void)({ transaction: rival.toHex(), block: { hash: block.hash, height: block.height, index: 1, time: 0 } });
    await wallet.exportState();
    expect(wallet.transaction(sent.txid)).toMatchObject({ status: 'conflicted', by: rival.getId(), block: null });
    expect(wallet.transaction(rival.getId())!.status).toBe('confirmed');
    expect(wallet.coins()).toEqual([]);
    expect(wallet.transaction(old)!.status).toBe('confirmed');
    stop();
  });
});

describe('ledger: spend chains', () => {
  it('does not count a transaction recorded in a block when what it spends is not active', () => {
    const network = networks.regtest;
    const script = toOutputScript(STRANGER, network);
    const parent = createTransaction(2);
    addInputByTxid(parent, '11'.repeat(32), 0);
    parent.addOutput(script, 500n);
    const child = createTransaction(2);
    addInputByTxid(child, parent.getId(), 0);
    child.addOutput(script, 400n);
    const entry = (tx: typeof parent, status: LedgerTransaction['status'], height: number | null): [string, LedgerTransaction] => [
      tx.getId(),
      { txid: tx.getId(), tx, status, block: height === null ? null : { height, hash: 'aa'.repeat(32) }, prevouts: [null], seenAt: 0 },
    ];
    const ownership = { owner: () => ({ owner: { type: 'imported' as const, id: STRANGER }, address: STRANGER }), address: () => STRANGER };
    const context = { tipHeight: 10, coinbaseMaturity: 100, externalSpends: new Set<string>(), locks: new Map<string, number | null>(), now: 0 };
    const stale = computeLedger(new Map([entry(parent, 'conflicted', null), entry(child, 'active', 5)]), ownership, context);
    expect(stale.status.get(child.getId())).toBe('conflicted');
    expect(stale.balance.total).toBe(0n);
    const sound = computeLedger(new Map([entry(parent, 'active', 4), entry(child, 'active', 5)]), ownership, context);
    expect(sound.balance.confirmed).toBe(400n);
  });
});
