// A generated XMSS key's birth names the wallet's synced tip as its parent,
// and the store refuses a birth whose parent is not a block hash. Audit 5,
// finding 4: a backend that gave its tip hash in upper case left a store that
// open refused and a backup that restore refused.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OysterRpc, PearlWallet, PearldRpc, createMemoryStore, oysterBackend, parsePearl, pearldBackend, pearldChainClient } from '../src/index.js';
import type { JsonValue, Rpc, WalletChain, WalletStore } from '../src/index.js';
import { FakeNode } from './filter-node.js';
import { FAST_KDF, FakeChain, MNEMONIC, PASSPHRASE } from './wallet-chain.js';

const prl = (text: string): bigint => parsePearl(text);

// The chain's own backend, with its tip hash in upper case.
function upperCaseTip(chain: FakeChain): WalletChain {
  return new Proxy(chain, {
    get: (target, name) => {
      if (name === 'getTip') return async () => ({ ...(await target.getTip()), hash: (await target.getTip()).hash.toUpperCase() });
      const value = Reflect.get(target, name, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as WalletChain;
}

// pearld over the chain, keeping the height of every block whose filter is asked for.
function recording(chain: FakeChain) {
  const node = new FakeNode(chain);
  const heights: number[] = [];
  const rpc: Rpc = {
    call: <T>(method: string, params: readonly unknown[] = []): Promise<T> => {
      if (method === 'getcfilter') heights.push(chain.blocks.findIndex((block) => block.hash === params[0]));
      return node.call<T>(method, params);
    },
  };
  return { rpc, lowest: () => Math.min(...heights) };
}

function lasting(): WalletStore {
  const store = createMemoryStore();
  return { ...store, close: async () => undefined };
}

describe('the tip hash a birth is recorded with', () => {
  it('records no birth from a tip hash that is not 64 lower-case hex digits, so the store and its backup still open', async () => {
    const chain = new FakeChain();
    const store = lasting();
    const wallet = await PearlWallet.create({ store, backend: upperCaseTip(chain), passphrase: PASSPHRASE, mnemonic: MNEMONIC, kdf: FAST_KDF, gapLimit: 10, unlockTimeout: null });
    await wallet.sync();
    const key = await wallet.addXmssKey();
    expect(key.birthHeight).toBeNull();
    const backup = await wallet.exportState();
    const keystore = wallet.exportKeystore();
    await wallet.close();
    chain.pay(key.address, prl('2'));
    chain.mine();

    const reopened = await PearlWallet.open({ store, backend: chain });
    await reopened.unlock(PASSPHRASE);
    await reopened.sync();
    expect(reopened.balance().confirmed).toBe(prl('2'));

    const restored = await PearlWallet.restore({ store: lasting(), backend: chain, keystore, passphrase: PASSPHRASE, backup, unlockTimeout: null });
    expect(restored.xmssKeys()[0]!.birthHeight).toBeNull();
  });

  it('opens a store an earlier pearljs wrote with an upper-case birth parent, and scans that key in full', async () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/wallet-store-upper-case-birth.json', import.meta.url), 'utf8')) as { entries: Record<string, JsonValue> };
    const chain = new FakeChain();
    const node = recording(chain);
    const store = createMemoryStore(Object.entries(fixture.entries));
    const wallet = await PearlWallet.open({ store, backend: pearldBackend(node.rpc, { network: chain.network }) });
    await wallet.unlock(PASSPHRASE);
    const [key] = wallet.xmssKeys();
    expect(key).toMatchObject({ label: 'upper-case parent', birthHeight: null });
    chain.pay(key!.address, prl('4'));
    chain.mine();
    await wallet.sync();
    expect(node.lowest()).toBe(0);
    expect(wallet.balance().confirmed).toBe(prl('4'));
    // The record is kept as stored: it is part of what the keystore authenticated.
    const backup = await wallet.exportState();
    const restored = await PearlWallet.restore({ store: lasting(), backend: chain, keystore: wallet.exportKeystore(), passphrase: PASSPHRASE, backup, unlockTimeout: null });
    expect(restored.xmssKeys()[0]!.birthHeight).toBeNull();
  });

  it('refuses a tip hash from pearld or Oyster that is not a block hash', async () => {
    const chain = new FakeChain();
    const node = new FakeNode(chain);
    for (const hash of [(await chain.getTip()).hash.toUpperCase(), '', 'ab', 7]) {
      const rpc: Rpc = {
        call: async <T>(method: string, params: readonly unknown[] = []): Promise<T> => {
          const result = await node.call<{ hash: string; height: number }>(method, params);
          return (method === 'getbestblock' ? { ...result, hash } : result) as T;
        },
      };
      await expect(pearldChainClient(new PearldRpc(rpc)).getTip()).rejects.toMatchObject({ code: 'RPC_RESPONSE', method: 'getbestblock' });
      await expect(oysterBackend(new OysterRpc(rpc), { network: chain.network }).getTip()).rejects.toMatchObject({ code: 'RPC_RESPONSE', method: 'getbestblock' });
    }
  });
});
