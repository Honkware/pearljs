// A property over random chain histories: after any sequence of payments,
// blocks, sends, reorgs (some replacing a payment), double spends and
// coinbase rewards, the wallet's balance is the sum of its unspent outputs,
// and a wallet synced from scratch on the same chain holds exactly the same
// outputs and balance. Sequences come from a seeded generator, so a failure
// names the seed that replays it.

import { describe, expect, it } from 'vitest';
import { InsufficientFundsError, PearlWallet, createMemoryStore } from '../src/index.js';
import { FakeChain, MNEMONIC, PASSPHRASE, STRANGER, newWallet } from './wallet-chain.js';
import { seededRandom } from './wallet-helpers.js';

const outputs = (wallet: PearlWallet): string[] => wallet.coins().map((coin) => `${coin.txid}:${coin.vout}=${coin.value}`).sort();

async function fresh(chain: FakeChain): Promise<PearlWallet> {
  const wallet = await PearlWallet.create({ store: createMemoryStore(), backend: chain, transactions: chain, passphrase: PASSPHRASE, mnemonic: MNEMONIC, kdf: { N: 2 ** 10 }, gapLimit: 10 });
  await wallet.sync();
  return wallet;
}

async function run(seed: number, steps: number): Promise<string[]> {
  const random = seededRandom(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const chain = new FakeChain();
  const wallet = await newWallet(chain);
  const log: string[] = [];
  for (let step = 0; step < steps; step += 1) {
    const roll = random();
    if (roll < 0.25) {
      const issued = wallet.addresses().filter((address) => !address.change);
      const address = issued.length > 0 && random() < 0.4 ? pick(issued).address : await wallet.currentAddress();
      chain.pay(address, BigInt(1 + Math.floor(random() * 20)) * 10_000_000n);
      log.push('pay');
    } else if (roll < 0.45) {
      chain.mine(1 + Math.floor(random() * 3), random() < 0.2 ? { coinbaseTo: await wallet.currentAddress(), value: 50_000_000n } : {});
      log.push('mine');
    } else if (roll < 0.65) {
      try {
        await wallet.send({ recipients: [{ address: STRANGER, amount: BigInt(1 + Math.floor(random() * 10)) * 5_000_000n }], feeRate: 2000n, rbf: random() < 0.5, minConfirmations: random() < 0.5 ? 0 : 1 });
        log.push('send');
      } catch (err) {
        if (!(err instanceof InsufficientFundsError)) throw err;
        log.push('send refused');
      }
    } else if (roll < 0.75 && chain.height > 3) {
      const depth = 1 + Math.floor(random() * Math.min(3, chain.height - 1));
      const payments = chain.blocks.slice(-depth).flatMap((block) => block.txs.filter((tx) => !tx.isCoinbase() && tx.ins.every((input) => input.witness[0]?.length === 64 && input.witness[0]![0] === 0)));
      const replace = payments.length > 0 && random() < 0.5 ? [pick(payments).getId()] : [];
      chain.reorg(depth, { replace, keepInMempool: random() < 0.5 });
      log.push(`reorg ${depth}${replace.length > 0 ? ' replacing a payment' : ''}`);
    } else if (roll < 0.85) {
      const pending = wallet.history().filter((entry) => entry.status === 'pending' && entry.direction !== 'incoming' && chain.mempool.has(entry.txid));
      if (pending.length > 0) {
        chain.doubleSpend(pick(pending).txid, { mine: random() < 0.5 });
        log.push('double spend');
      }
    } else {
      await wallet.sync();
      log.push('sync');
    }
    if (random() < 0.5) {
      await wallet.sync();
      const coins = wallet.coins();
      expect(wallet.balance().total, `seed ${seed}: ${log.join(', ')}`).toBe(coins.reduce((sum, coin) => sum + coin.value, 0n));
    }
  }
  await wallet.sync();
  const balance = wallet.balance();
  expect(balance.total).toBe(wallet.coins().reduce((sum, coin) => sum + coin.value, 0n));
  const rebuilt = await fresh(chain);
  expect(outputs(wallet), `seed ${seed}: ${log.join(', ')}`).toEqual(outputs(rebuilt));
  expect(balance, `seed ${seed}: ${log.join(', ')}`).toEqual(rebuilt.balance());
  return log;
}

describe('wallet property', () => {
  it('keeps balance equal to its unspent outputs and to a wallet rebuilt from scratch', async () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 40; seed += 1) for (const step of await run(seed, 30)) seen.add(step.replace(/ \d+/, ''));
    // The generator reached every kind of event.
    expect([...seen].sort()).toEqual(['double spend', 'mine', 'pay', 'reorg', 'reorg replacing a payment', 'send', 'send refused', 'sync']);
  }, 240_000);
});
