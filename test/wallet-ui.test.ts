// What an application built on the wallet leans on: a sync that asks the
// backend only what it has to, reports how far it has got and can be
// stopped; history a page at a time, by account or address; a snapshot
// that is the same object until something changes, with a version and a
// subscription; forms of balances, coins and history that go through JSON;
// and a shortfall that says what the wallet holds and could not spend.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUIET_SYNC_INTERVAL,
  PearlWallet,
  balanceFromJson,
  balanceToJson,
  coinFromJson,
  coinToJson,
  createMemoryStore,
  historyEntryFromJson,
  historyEntryToJson,
  parsePearl,
} from '../src/index.js';
import type { WalletSyncProgress } from '../src/index.js';
import { FAST_KDF, FakeChain, MNEMONIC, PASSPHRASE, STRANGER, newWallet, withActivityScanner } from './wallet-chain.js';

const prl = (text: string): bigint => parsePearl(text);
const calls = (chain: FakeChain, name: string): number => chain.calls.get(name) ?? 0;

/** A wallet with `spent` addresses that were paid and emptied long ago, `held` that hold a coin, synced. */
async function aged(chain: FakeChain, spent: number, held: number, options: { quietSyncInterval?: number } = {}): Promise<PearlWallet> {
  const wallet = await PearlWallet.create({ store: createMemoryStore(), backend: chain, transactions: chain, passphrase: PASSPHRASE, mnemonic: MNEMONIC, kdf: FAST_KDF, gapLimit: 100, unlockTimeout: null, ...options });
  for (let i = 0; i < spent; i += 1) chain.pay(await wallet.receiveAddress(), prl('1'));
  chain.mine();
  await wallet.sync();
  if (spent > 0) await wallet.send({ recipients: [{ address: STRANGER, amount: 'max' }], feeRate: 2000n });
  chain.mine();
  await wallet.sync();
  for (let i = 0; i < held; i += 1) chain.pay(await wallet.receiveAddress(), prl('2'));
  chain.mine();
  await wallet.sync();
  return wallet;
}

describe('wallet: a sync that asks only what it has to', () => {
  it('leaves addresses that were paid and emptied for their turn, and asks about all of them over an interval', async () => {
    expect(DEFAULT_QUIET_SYNC_INTERVAL).toBe(10);
    const chain = new FakeChain();
    const wallet = await aged(chain, 60, 3, { quietSyncInterval: 5 });
    const everything = 63 + 20 + 20;
    const perSync: number[] = [];
    for (let round = 0; round < 5; round += 1) {
      chain.calls.clear();
      await wallet.sync();
      perSync.push(calls(chain, 'getHistory'));
    }
    // 43 emptied addresses lie outside the lookahead; each sync asks about a fifth of them and all the rest.
    for (const asked of perSync) expect([everything - 43 + 8, everything - 43 + 9]).toContain(asked);
    expect(perSync.reduce((sum, asked) => sum + asked, 0)).toBe(5 * (everything - 43) + 43);
    chain.calls.clear();
    await wallet.sync({ full: true });
    // Every address, and the whole gap limit past the last used one on both chains.
    expect(calls(chain, 'getHistory')).toBe(63 + 100 + 100);
    expect(wallet.balance().confirmed).toBe(prl('6'));
  });

  it('finds a payment to an address it had stopped asking about, within the interval, and at once with full', async () => {
    const chain = new FakeChain();
    const wallet = await aged(chain, 40, 1, { quietSyncInterval: 4 });
    const quiet = wallet.addresses({ account: '0' }).filter((address) => !address.change);
    chain.pay(quiet[3]!.address, prl('7'));
    chain.pay(quiet[4]!.address, prl('9'));
    chain.mine();
    let syncs = 0;
    while (wallet.balance().confirmed < prl('18')) {
      await wallet.sync();
      syncs += 1;
      expect(syncs).toBeLessThanOrEqual(4);
    }
    expect(syncs).toBeGreaterThan(1);
    // An address that holds a coin is asked about every time from then on.
    chain.pay(quiet[3]!.address, prl('1'));
    await wallet.sync();
    expect(wallet.balance().unconfirmed).toBe(prl('1'));
    chain.pay(quiet[20]!.address, prl('5'));
    await wallet.sync({ full: true });
    expect(wallet.balance().unconfirmed).toBe(prl('6'));
  });

  it('asks about every address on the first sync after it is opened', async () => {
    const chain = new FakeChain();
    const store = createMemoryStore();
    const first = await PearlWallet.create({ store, backend: chain, transactions: chain, passphrase: PASSPHRASE, mnemonic: MNEMONIC, kdf: FAST_KDF, gapLimit: 100 });
    for (let i = 0; i < 40; i += 1) chain.pay(await first.receiveAddress(), prl('1'));
    chain.mine();
    await first.sync();
    await first.send({ recipients: [{ address: STRANGER, amount: 'max' }], feeRate: 2000n });
    chain.mine();
    await first.sync();
    const paidWhileAway = first.addresses()[2]!.address;
    const stored = await store.list('');
    await first.close();
    chain.pay(paidWhileAway, prl('3'));
    chain.mine();
    const reopened = await PearlWallet.open({ store: createMemoryStore(stored), backend: chain, transactions: chain });
    await reopened.sync();
    expect(reopened.balance().confirmed).toBe(prl('3'));
  });

  it('asks a backend that can answer for every address at once one question per sync', async () => {
    const chain = withActivityScanner(new FakeChain());
    const wallet = await aged(chain, 60, 3);
    const addresses = wallet.addresses();
    chain.pay(addresses[5]!.address, prl('7'));
    chain.mine();
    chain.pay(await wallet.receiveAddress(), prl('1'));
    chain.calls.clear();
    await wallet.sync();
    expect(calls(chain, 'getActivitySince')).toBe(1);
    expect(calls(chain, 'getHistory')).toBe(0);
    expect(wallet.balance()).toMatchObject({ confirmed: prl('13'), unconfirmed: prl('1') });
    // Nothing happened: one question, and nothing fetched.
    chain.calls.clear();
    await wallet.sync();
    expect(calls(chain, 'getActivitySince')).toBe(1);
    expect(calls(chain, 'getHistory') + calls(chain, 'getRawTransaction')).toBe(0);
  });

  it('asks address by address for what a payment brings into the window, and when the backend cannot answer since the last tip', async () => {
    const chain = withActivityScanner(new FakeChain());
    const wallet = await aged(chain, 0, 1);
    const { deriveAccountFromSeed, mnemonicToSeed, networks } = await import('../src/index.js');
    const account = deriveAccountFromSeed(mnemonicToSeed(MNEMONIC), networks.regtest);
    // Paid by another copy of the seed, at the edge of the window and then past it.
    chain.pay(account.deriveAddress(15), prl('1'));
    chain.pay(account.deriveAddress(30), prl('2'));
    chain.mine();
    chain.calls.clear();
    await wallet.sync();
    expect(wallet.balance().confirmed).toBe(prl('5'));
    expect(wallet.accounts()[0]!.nextReceiveIndex).toBe(31);
    expect(calls(chain, 'getActivitySince')).toBe(1);
    expect(calls(chain, 'getHistory')).toBe(15 + 15);
    // A reorg takes the last synced tip off the chain: the scanner cannot answer from it.
    chain.reorg(1);
    chain.calls.clear();
    await wallet.sync();
    expect(calls(chain, 'getHistory')).toBeGreaterThan(50);
    expect(wallet.balance().confirmed).toBe(prl('5'));
  });

  it('does not read the store to sync or refresh', async () => {
    const chain = new FakeChain();
    const inner = createMemoryStore();
    let reads = 0;
    const store = { ...inner, list: async (prefix: string) => ((reads += 1), inner.list(prefix)), get: async (key: string) => ((reads += 1), inner.get(key)) };
    const wallet = await newWallet(chain, { store });
    chain.pay(await wallet.receiveAddress(), prl('1'));
    chain.mine();
    reads = 0;
    await wallet.sync();
    await wallet.refresh();
    chain.mine();
    await wallet.refresh();
    expect(reads).toBe(0);
    expect(wallet.balance().confirmed).toBe(prl('1'));
  });
});

describe('wallet: progress and stopping', () => {
  it('reports how far a sync has got, ending with done', async () => {
    const chain = new FakeChain();
    const wallet = await newWallet(chain);
    for (let i = 0; i < 3; i += 1) chain.pay(await wallet.receiveAddress(), prl('1'));
    chain.mine();
    const seen: WalletSyncProgress[] = [];
    wallet.on('sync', (progress) => seen.push(progress));
    await wallet.sync();
    expect(seen.map((progress) => progress.phase).filter((phase, i, all) => phase !== all[i - 1])).toEqual(['scanning', 'fetching', 'settling', 'done']);
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i]!.addresses).toBeGreaterThanOrEqual(seen[i - 1]!.addresses);
      expect(seen[i]!.transactions).toBeGreaterThanOrEqual(seen[i - 1]!.transactions);
    }
    expect(seen.at(-1)).toEqual({ phase: 'done', addresses: 13 + 10, transactions: 3 });
  });

  it('stops a sync that is still asking and leaves the wallet as it was', async () => {
    const chain = new FakeChain();
    const wallet = await newWallet(chain);
    chain.pay(await wallet.receiveAddress(), prl('1'));
    chain.mine();
    const controller = new AbortController();
    const real = chain.getHistory.bind(chain);
    let asked = 0;
    chain.getHistory = async (watched) => {
      asked += 1;
      if (asked === 3) controller.abort(new Error('the user navigated away'));
      return real(watched);
    };
    const version = wallet.getSnapshot().version;
    await expect(wallet.sync({ signal: controller.signal })).rejects.toThrow('the user navigated away');
    expect(asked).toBeLessThan(30);
    expect(wallet.tip).toBeNull();
    expect(wallet.history()).toEqual([]);
    expect(wallet.getSnapshot()).toMatchObject({ syncing: false, transactions: 0 });
    expect(wallet.getSnapshot().version).toBeGreaterThan(version);
    // A signal that is already aborted stops it before anything is asked.
    asked = 0;
    await expect(wallet.sync({ signal: controller.signal })).rejects.toThrow('the user navigated away');
    await expect(wallet.refresh({ signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
    expect(asked).toBe(0);
    chain.getHistory = real;
    await wallet.sync();
    expect(wallet.balance().confirmed).toBe(prl('1'));
  });
});

describe('wallet: history, snapshots and JSON', () => {
  async function busy() {
    const chain = new FakeChain();
    const wallet = await newWallet(chain);
    await wallet.addAccount(1);
    const first = await wallet.receiveAddress();
    const second = await wallet.receiveAddress();
    const other = await wallet.receiveAddress({ account: '1' });
    for (const [address, amount] of [[first, '1'], [second, '2'], [first, '3'], [other, '4'], [second, '5']] as const) {
      chain.pay(address, prl(amount));
      chain.mine();
    }
    await wallet.sync();
    return { chain, wallet, first, second, other };
  }

  it('pages through history and filters it by account and address', async () => {
    const { wallet, first, second, other } = await busy();
    const all = wallet.history();
    expect(all.map((entry) => entry.amount)).toEqual(['5', '4', '3', '2', '1'].map(prl));
    expect(all[0]!.addresses).toEqual([second]);
    expect(wallet.history({ limit: 2 }).map((entry) => entry.txid)).toEqual(all.slice(0, 2).map((entry) => entry.txid));
    expect(wallet.history({ offset: 2, limit: 2 }).map((entry) => entry.txid)).toEqual(all.slice(2, 4).map((entry) => entry.txid));
    expect(wallet.history({ offset: 4, limit: 10 })).toHaveLength(1);
    expect(wallet.history({ offset: 9 })).toEqual([]);
    expect(wallet.history({ limit: 0 })).toEqual([]);
    expect(wallet.historyCount()).toBe(5);
    expect(wallet.history({ address: first }).map((entry) => entry.amount)).toEqual([prl('3'), prl('1')]);
    expect(wallet.historyCount({ address: second })).toBe(2);
    expect(wallet.history({ account: '1' }).map((entry) => entry.amount)).toEqual([prl('4')]);
    expect(wallet.history({ address: other })).toEqual(wallet.history({ account: '1' }));
    expect(wallet.history({ account: '0', offset: 1, limit: 2 }).map((entry) => entry.amount)).toEqual([prl('3'), prl('2')]);
    expect(wallet.historyCount({ account: '0' })).toBe(4);
    expect(wallet.history({ address: STRANGER })).toEqual([]);
    expect(() => wallet.history({ account: 'nope' })).toThrow('no account nope');
    expect(() => wallet.history({ limit: -1 })).toThrow(RangeError);
    // A send from account 0 is its history, and the entry names the wallet's addresses on both sides.
    const sent = await wallet.send({ recipients: [{ address: STRANGER, amount: prl('0.5') }], feeRate: 2000n });
    const entry = wallet.history({ account: '0', limit: 1 })[0]!;
    expect(entry.txid).toBe(sent.txid);
    expect(entry.addresses).toContain(sent.changeAddress);
    expect(wallet.history({ account: '1' })).toHaveLength(1);
    expect(wallet.transaction(sent.txid)).toMatchObject({ txid: sent.txid, status: 'pending', fee: sent.fee, addresses: entry.addresses });
  });

  it('returns the same snapshot until something changes, and tells subscribers when it has', async () => {
    const chain = new FakeChain();
    const wallet = await newWallet(chain);
    let notified = 0;
    const unsubscribe = wallet.subscribe(() => (notified += 1));
    const first = wallet.getSnapshot();
    expect(wallet.getSnapshot()).toBe(first);
    expect(first).toMatchObject({ version: wallet.version, tip: null, locked: false, watchOnly: false, syncing: false, transactions: 0, pending: 0 });
    expect(Object.isFrozen(first) && Object.isFrozen(first.balance)).toBe(true);
    // Reading changes nothing.
    wallet.balance();
    wallet.history();
    wallet.estimateSend({ recipients: [{ address: STRANGER, amount: 1n }] }, [2000n]);
    expect(wallet.getSnapshot()).toBe(first);
    expect(notified).toBe(0);

    const steps: [string, () => Promise<unknown> | void, Partial<ReturnType<PearlWallet['getSnapshot']>>][] = [
      ['an address handed out', async () => void chain.pay(await wallet.receiveAddress(), prl('2')), {}],
      ['a sync', () => wallet.sync(), { transactions: 1, pending: 1, syncing: false }],
      ['a lock', () => wallet.lock(), { locked: true }],
      ['an unlock', () => wallet.unlock(PASSPHRASE), { locked: false }],
      ['a block', async () => (chain.mine(), wallet.refresh()), { pending: 0 }],
      ['a send', () => wallet.send({ recipients: [{ address: STRANGER, amount: prl('1') }], feeRate: 2000n }), { transactions: 2, pending: 1 }],
    ];
    let last = first;
    for (const [what, step, expected] of steps) {
      const before = notified;
      await step();
      const next = wallet.getSnapshot();
      expect(next, what).not.toBe(last);
      expect(next.version, what).toBeGreaterThan(last.version);
      expect(next, what).toMatchObject(expected);
      expect(notified, what).toBeGreaterThan(before);
      expect(wallet.getSnapshot(), what).toBe(next);
      last = next;
    }
    expect(last.balance).toEqual(wallet.balance());
    expect(last.tip).toEqual(wallet.tip);
    // A sync shows as syncing while it runs.
    const during: boolean[] = [];
    wallet.subscribe(() => during.push(wallet.getSnapshot().syncing));
    await wallet.sync();
    expect(during[0]).toBe(true);
    expect(during.at(-1)).toBe(false);
    // An unlock that times out is a change too.
    wallet.lock();
    await wallet.unlock(PASSPHRASE, { timeout: 20 });
    const unlocked = wallet.getSnapshot();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(wallet.getSnapshot()).toMatchObject({ locked: true });
    expect(wallet.getSnapshot().version).toBeGreaterThan(unlocked.version);
    // A failed operation does not leave a stale snapshot behind either, and an unsubscribed listener hears nothing.
    unsubscribe();
    const quiet = notified;
    await expect(wallet.send({ recipients: [{ address: STRANGER, amount: prl('1') }], feeRate: 2000n })).rejects.toMatchObject({ code: 'WALLET_LOCKED' });
    expect(notified).toBe(quiet);
    expect(wallet.getSnapshot().balance).toEqual(wallet.balance());
  });

  it('carries balances, coins and history through JSON and back unchanged', async () => {
    const { wallet } = await busy();
    await wallet.send({ recipients: [{ address: STRANGER, amount: prl('0.5') }], feeRate: 2000n, label: 'lunch' });
    expect(() => JSON.stringify(wallet.balance())).toThrow(TypeError);
    const wire = JSON.stringify({ balance: balanceToJson(wallet.balance()), coins: wallet.coins().map(coinToJson), history: wallet.history().map(historyEntryToJson) });
    const read = JSON.parse(wire) as { balance: unknown; coins: unknown[]; history: unknown[] };
    expect(balanceFromJson(read.balance)).toEqual(wallet.balance());
    expect(read.coins.map(coinFromJson)).toEqual(wallet.coins());
    expect(read.history.map(historyEntryFromJson)).toEqual(wallet.history());
    expect(read.balance).toMatchObject({ confirmed: wallet.balance().confirmed.toString(), total: wallet.balance().total.toString() });
    expect(typeof (read.coins[0] as { script: unknown }).script).toBe('string');
    // What is not one of these is refused, not coerced.
    expect(() => balanceFromJson({ ...(read.balance as object), confirmed: 5 })).toThrow(expect.objectContaining({ code: 'AMOUNT_INVALID' }));
    expect(() => balanceFromJson({ confirmed: '1' })).toThrow(expect.objectContaining({ code: 'AMOUNT_INVALID' }));
    expect(() => balanceFromJson('5')).toThrow(TypeError);
    expect(() => coinFromJson({ ...(read.coins[0] as object), value: '1.5' })).toThrow(expect.objectContaining({ code: 'AMOUNT_INVALID' }));
    expect(() => coinFromJson({ ...(read.coins[0] as object), script: 'zz' })).toThrow(TypeError);
    expect(() => historyEntryFromJson({ ...(read.history[0] as object), amount: '0x10' })).toThrow(expect.objectContaining({ code: 'AMOUNT_INVALID' }));
    // A fee the wallet does not know, as for a payment whose inputs it cannot look up, stays null.
    expect(historyEntryFromJson(JSON.parse(JSON.stringify(historyEntryToJson({ ...wallet.history().at(-1)!, fee: null })))).fee).toBeNull();
  });

  it('says what the wallet holds and could not spend when a send falls short', async () => {
    const chain = new FakeChain();
    const wallet = await newWallet(chain);
    chain.pay(await wallet.receiveAddress(), prl('1'));
    chain.pay(await wallet.receiveAddress(), prl('2'));
    chain.mine();
    chain.mine(1, { coinbaseTo: await wallet.receiveAddress(), value: prl('50') });
    chain.pay(await wallet.receiveAddress(), prl('4'));
    await wallet.sync();
    const locked = wallet.coins().find((coin) => coin.value === prl('2'))!;
    await wallet.lockOutpoint(locked);
    const error = await wallet.send({ recipients: [{ address: STRANGER, amount: prl('5') }], feeRate: 2000n }).catch((err: unknown) => err);
    expect(error).toMatchObject({ name: 'WalletInsufficientFundsError', code: 'INSUFFICIENT_FUNDS', available: prl('1'), locked: prl('2'), immature: prl('50'), unconfirmed: prl('4'), frozen: 0n });
    expect((error as Error).message).toContain('200000000 grain locked, 5000000000 grain immature, 400000000 grain unconfirmed');
    // With unconfirmed coins allowed, those no longer count as held back.
    const again = await wallet.send({ recipients: [{ address: STRANGER, amount: prl('8') }], feeRate: 2000n, minConfirmations: 0 }).catch((err: unknown) => err);
    expect(again).toMatchObject({ available: prl('5'), locked: prl('2'), immature: prl('50'), unconfirmed: 0n });
    // An estimate reports the same.
    expect(wallet.estimateSend({ recipients: [{ address: STRANGER, amount: prl('5') }] }, [2000n])[0]!.error).toMatchObject({ locked: prl('2'), immature: prl('50'), unconfirmed: prl('4') });
  });
});
