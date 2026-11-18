// What a sync and a refresh cost the wallet as its history grows. The
// measure is the hex encodings the wallet makes (every txid and script it
// compares goes through one), counted while the backend replays answers it
// gave before, so the backend's own cost is left out. Work per transaction
// is the same at every size, so four times the history may cost about four
// times as much, and not the sixteen times of work that compares every
// transaction with every other.

import { describe, expect, it, vi } from 'vitest';
import { PearlWallet, createMemoryStore, parsePearl } from '../src/index.js';
import type { WalletBackend } from '../src/index.js';
import type * as Bytes from '../src/internal/bytes.js';
import { FakeChain, PASSPHRASE, STRANGER, newWallet } from './wallet-chain.js';

const counter = vi.hoisted(() => ({ hex: 0 }));
vi.mock('../src/internal/bytes.js', async (importOriginal) => {
  const bytes = await importOriginal<typeof Bytes>();
  return {
    ...bytes,
    toHex: (data: Uint8Array): string => {
      counter.hex += 1;
      return bytes.toHex(data);
    },
  };
});

// The chain, answering each question as it did the first time it was asked once `replay` is on.
function replaying(chain: FakeChain): FakeChain & { replay: boolean } {
  const answers = new Map<string, unknown>();
  const key = (name: string, args: unknown[]) => `${name}:${JSON.stringify(args, (_k, v: unknown) => (v instanceof Uint8Array ? Buffer.from(v).toString('base64') : typeof v === 'bigint' ? `${v}n` : v))}`;
  const state = { replay: false };
  return new Proxy(chain, {
    get(target, prop, receiver) {
      if (prop === 'replay') return state.replay;
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== 'function' || typeof prop !== 'string') return value;
      return async (...args: unknown[]) => {
        const k = key(prop, args);
        if (state.replay && answers.has(k)) return answers.get(k);
        const answer = await (value as (...a: unknown[]) => unknown).apply(target, args);
        answers.set(k, answer);
        return answer;
      };
    },
    set(target, prop, value, receiver) {
      if (prop === 'replay') {
        state.replay = value as boolean;
        return true;
      }
      return Reflect.set(target, prop, value, receiver);
    },
  }) as FakeChain & { replay: boolean };
}

// A wallet with `size` transactions: payments in, then as many sends out, in blocks of ten.
async function walletWith(size: number): Promise<{ wallet: PearlWallet; backend: FakeChain & { replay: boolean } }> {
  const chain = new FakeChain();
  const store = createMemoryStore();
  const built = await newWallet(chain, { store, gapLimit: 20 });
  for (let i = 0; i < size / 2; i += 1) {
    chain.pay(await built.receiveAddress(), parsePearl('1'));
    if (i % 10 === 9) {
      chain.mine();
      await built.sync();
    }
  }
  chain.mine();
  await built.sync();
  await built.unlock(PASSPHRASE);
  for (let i = 0; i < size / 2; i += 1) {
    await built.send({ recipients: [{ address: STRANGER, amount: 1000n }], feeRate: 2000n, minConfirmations: 0 });
    if (i % 10 === 9) chain.mine();
  }
  chain.mine();
  const backend = replaying(chain);
  const copy = createMemoryStore(Object.entries((await built.exportState()).entries));
  const wallet = await PearlWallet.open({ store: copy, backend: backend as WalletBackend, transactions: backend });
  return { wallet, backend };
}

async function cost(size: number): Promise<{ sync: number; refresh: number }> {
  const { wallet, backend } = await walletWith(size);
  await wallet.sync();
  await wallet.refresh();
  backend.replay = true;
  counter.hex = 0;
  await wallet.sync();
  const sync = counter.hex;
  counter.hex = 0;
  await wallet.refresh();
  return { sync, refresh: counter.hex };
}

describe('wallet: what a sync costs as history grows', () => {
  it('costs about four times as much for four times the history, for a sync and for a refresh', async () => {
    const small = await cost(60);
    const large = await cost(240);
    expect(large.sync / small.sync).toBeLessThan(6);
    expect(large.refresh / Math.max(1, small.refresh)).toBeLessThan(6);
  }, 120_000);
});
