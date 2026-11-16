// The wallet as a state machine. Random interleavings of everything that
// happens to one: payments arriving at new, old and never-issued addresses,
// blocks, reorgs of any depth (well past reorgDepth) that carry payments
// along or replace them, double spends, sends, fee bumps, broadcasts that
// fail without an answer, locking and unlocking, a store that fails in the
// middle of an operation, crashes with a reopen from the store, and long
// stretches without a sync. After every look at the chain, by sync or by
// refresh, the invariant holds: the confirmed balance never includes a coin
// the chain does not have, and the balance is the sum of the coins. After a
// full sync the wallet agrees with an oracle, a wallet built from the seed
// and synced from scratch. Sequences come from a seeded generator, so a
// failure names the seed that replays it.

import { describe, expect, it } from 'vitest';
import { PearlError, PearlWallet, createMemoryStore, deriveAccountFromSeed, mnemonicToSeed, networks, parseTransaction } from '../src/index.js';
import type { WalletStore } from '../src/index.js';
import { FAST_KDF, FakeChain, MNEMONIC, PASSPHRASE, STRANGER } from './wallet-chain.js';
import { seededRandom } from './wallet-helpers.js';

const REORG_DEPTH = 3;
const account = deriveAccountFromSeed(mnemonicToSeed(MNEMONIC), networks.regtest);
const key = (coin: { txid: string; vout: number }): string => `${coin.txid}:${coin.vout}`;
const prevTxid = (input: { hash: Uint8Array }): string => Array.from(Uint8Array.from(input.hash).reverse(), (byte) => byte.toString(16).padStart(2, '0')).join('');

/** A store that can be told to fail its next write, as a full disk or a power cut would. */
function failing(inner: WalletStore): { store: WalletStore; failNext(): void } {
  let fail = false;
  const guard = (): void => {
    if (!fail) return;
    fail = false;
    throw new Error('power cut');
  };
  return {
    failNext: () => void (fail = true),
    store: {
      ...inner,
      set: async (name, value) => (guard(), inner.set(name, value)),
      batch: async (operations) => (guard(), inner.batch(operations)),
      compareAndSet: async (expected, operations) => (guard(), inner.compareAndSet(expected, operations)),
    },
  };
}

async function oracle(chain: FakeChain): Promise<PearlWallet> {
  const wallet = await PearlWallet.create({ store: createMemoryStore(), backend: chain, transactions: chain, passphrase: PASSPHRASE, mnemonic: MNEMONIC, kdf: FAST_KDF, gapLimit: 40 });
  await wallet.sync();
  return wallet;
}

async function run(seed: number, steps: number): Promise<Set<string>> {
  const random = seededRandom(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const chain = new FakeChain();
  const inner = createMemoryStore();
  let { store, failNext } = failing(inner);
  const open = { backend: chain, transactions: chain, quietSyncInterval: 3 };
  let wallet = await PearlWallet.create({ ...open, store, passphrase: PASSPHRASE, mnemonic: MNEMONIC, kdf: FAST_KDF, gapLimit: 40, reorgDepth: REORG_DEPTH, unlockTimeoutMs: null });
  const log: string[] = [];
  const did = new Set<string>();
  const note = (what: string): void => {
    log.push(what);
    did.add(what.replace(/ \d+$/, ''));
  };
  const context = (): string => `seed ${seed}: ${log.join(', ')}`;

  // What must hold whenever the wallet has just looked at the chain.
  const looked = async (): Promise<void> => {
    const coins = wallet.coins();
    const balance = wallet.balance();
    expect(balance.total, context()).toBe(coins.reduce((sum, coin) => sum + coin.value, 0n));
    expect(balance.confirmed + balance.immature, context()).toBe(coins.filter((coin) => coin.confirmations >= 1).reduce((sum, coin) => sum + coin.value, 0n));
    for (const coin of coins) {
      if (coin.confirmations < 1) continue;
      const where = await chain.getTransaction(coin.txid);
      expect(where?.block, `${context()}: confirmed coin ${key(coin)} is not in a block`).toBeTruthy();
      expect(where!.block, context()).toEqual(wallet.transaction(coin.txid)!.block);
      const spent = await chain.getSpendStatus(coin);
      expect(spent.status === 'spent' && spent.confirmed, `${context()}: confirmed coin ${key(coin)} is spent on chain`).toBe(false);
    }
  };

  const reopen = async (): Promise<void> => {
    ({ store, failNext } = failing(inner));
    wallet = await PearlWallet.open({ ...open, store });
  };

  for (let step = 0; step < steps; step += 1) {
    const roll = random();
    try {
      if (roll < 0.16) {
        const issued = wallet.addresses().filter((address) => !address.change);
        const where = random();
        const address = where < 0.35 && issued.length > 0 ? pick(issued).address : where < 0.5 ? account.deriveAddress(Math.floor(random() * 30)) : await wallet.currentAddress();
        chain.pay(address, BigInt(1 + Math.floor(random() * 20)) * 10_000_000n);
        note('receive');
      } else if (roll < 0.3) {
        chain.mine(1 + Math.floor(random() * 4), random() < 0.15 ? { coinbaseTo: account.deriveAddress(Math.floor(random() * 5)), value: 50_000_000n } : {});
        note('confirm');
      } else if (roll < 0.42 && chain.height > 2) {
        const depth = 1 + Math.floor(random() * Math.min(chain.height - 1, random() < 0.5 ? REORG_DEPTH : 4 * REORG_DEPTH));
        const candidates = chain.blocks.slice(-depth).flatMap((block) => block.txs.filter((tx) => !tx.isCoinbase()));
        const replace = candidates.length > 0 && random() < 0.6 ? [pick(candidates).getId()] : [];
        chain.reorg(depth, { replace, keepInMempool: random() < 0.4, mine: random() < 0.2 ? 1 : depth + 1 });
        note(`reorg ${depth > REORG_DEPTH ? 'past the depth' : 'within the depth'}${replace.length > 0 ? ' replacing' : ''}`);
      } else if (roll < 0.5) {
        const pending = wallet.history().filter((entry) => entry.status === 'pending' && entry.direction !== 'incoming' && chain.mempool.has(entry.txid));
        if (pending.length > 0) {
          chain.doubleSpend(pick(pending).txid, { mine: random() < 0.5 });
          note('double spend');
        }
      } else if (roll < 0.64) {
        if (random() < 0.15) chain.failNextBroadcast = true;
        const sent = await wallet.send({ recipients: [{ address: STRANGER, amount: BigInt(1 + Math.floor(random() * 10)) * 5_000_000n }], feeRate: 2000n, rbf: random() < 0.6, minConfirmations: random() < 0.4 ? 0 : 1 });
        expect(chain.mempool.has(sent.txid), context()).toBe(true);
        note('send');
      } else if (roll < 0.7) {
        const bumpable = wallet.history().filter((entry) => entry.status === 'pending' && entry.direction === 'outgoing');
        if (bumpable.length > 0) {
          await wallet.bumpFee(pick(bumpable).txid, { feeRate: 6000n + BigInt(Math.floor(random() * 5)) * 2000n });
          note('bump');
        }
      } else if (roll < 0.74) {
        wallet.lock();
        note('lock');
      } else if (roll < 0.8) {
        await wallet.unlock(PASSPHRASE);
        note('unlock');
      } else if (roll < 0.84) {
        await reopen();
        note('crash and reopen');
      } else if (roll < 0.88) {
        // The store fails under whatever comes next, and the process does not outlive it.
        failNext();
        await (random() < 0.5 ? wallet.sync() : wallet.send({ recipients: [{ address: STRANGER, amount: 5_000_000n }], feeRate: 2000n })).catch(() => undefined);
        await reopen();
        note('store failure and reopen');
      } else if (roll < 0.94) {
        await wallet.refresh();
        note('refresh');
        await looked();
      } else {
        const full = random() < 0.3;
        await wallet.sync({ full });
        note(full ? 'full sync' : 'sync');
        await looked();
      }
    } catch (err) {
      // What an application would be told: not enough money, locked, not replaceable, a broadcast that may not have arrived.
      if (!(err instanceof PearlError) || !['INSUFFICIENT_FUNDS', 'WALLET_LOCKED', 'WALLET_NOT_REPLACEABLE', 'WALLET_BROADCAST_UNCERTAIN', 'WALLET_BROADCAST_REFUSED', 'PAYMENT_INVALID', 'POLICY_DUST'].includes(err.code)) {
        throw new Error(`${context()}: ${String(err)}`, { cause: err });
      }
      note(`refused ${err.code}`);
    }
    // Offline most of the time: only now and then does the wallet look.
    if (random() < 0.25) {
      await wallet.sync();
      await looked();
    }
  }

  await wallet.sync({ full: true });
  await looked();
  const rebuilt = await oracle(chain);
  const mine = new Set(wallet.coins().filter((coin) => coin.confirmations >= 1).map(key));
  const theirs = new Set(rebuilt.coins().filter((coin) => coin.confirmations >= 1).map(key));
  // Every confirmed coin the wallet has, the chain has.
  for (const coin of mine) expect(theirs.has(coin), `${context()}: ${coin} is confirmed in the wallet and not on the chain`).toBe(true);
  // A coin the chain has and the wallet does not count is one a pending send of the wallet's own spends.
  const spending = new Set<string>();
  for (const entry of wallet.history()) {
    if (entry.status !== 'pending') continue;
    for (const input of parseTransaction(wallet.transaction(entry.txid)!.hex).ins) spending.add(`${prevTxid(input)}:${input.index}`);
  }
  for (const coin of theirs) if (!mine.has(coin)) expect(spending.has(coin), `${context()}: ${coin} is on the chain and missing from the wallet`).toBe(true);
  // Once everything pending has been settled by the chain, the two agree to the grain.
  chain.mine(2);
  for (const entry of wallet.history()) if (entry.status === 'pending' && !(await chain.getTransaction(entry.txid))) await wallet.abandon(entry.txid);
  await wallet.sync({ full: true });
  await looked();
  const settled = await oracle(chain);
  expect(wallet.coins().map((coin) => `${key(coin)}=${coin.value}`).sort(), context()).toEqual(settled.coins().map((coin) => `${key(coin)}=${coin.value}`).sort());
  expect(wallet.balance(), context()).toEqual(settled.balance());
  return did;
}

describe('wallet state machine', () => {
  it('never counts as confirmed a coin the chain does not have, whatever happens in whatever order', async () => {
    const did = new Set<string>();
    for (let seed = 1; seed <= 60; seed += 1) for (const what of await run(seed, 45)) did.add(what);
    // The generator reached every kind of step.
    for (const what of ['receive', 'confirm', 'reorg within the depth', 'reorg within the depth replacing', 'reorg past the depth', 'reorg past the depth replacing', 'double spend', 'send', 'bump', 'lock', 'unlock', 'crash and reopen', 'store failure and reopen', 'refresh', 'sync', 'full sync', 'refused INSUFFICIENT_FUNDS', 'refused WALLET_LOCKED', 'refused WALLET_BROADCAST_UNCERTAIN']) {
      expect([...did], what).toContain(what);
    }
  }, 600_000);
});
