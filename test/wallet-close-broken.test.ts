// A wallet whose store has failed still closes that store, so the store's
// lock (the IndexedDB store's Web Lock, the file store's lock file) is let go.
// Found in Chrome 157 (scripts/browser-wallet-live.mjs): after site data was
// cleared under an open wallet, close() rejected with the store's error and
// never called store.close(), so the tab kept the lock and a reopen failed
// with STORE_LOCKED until the page was unloaded. Skipped: src/wallet.ts is
// another branch's; close() should close the store even when #broken is set.

import { describe, expect, it } from 'vitest';
import { PearlWallet, StoreError, createMemoryStore } from '../src/index.js';
import type { WalletStore } from '../src/index.js';
import { SimulatedChain } from '../src/testing.js';

describe('PearlWallet.close after the store fails', () => {
  it.skip('closes the store even when the wallet refuses further operations', async () => {
    const inner = createMemoryStore();
    let failing = false;
    let closed = false;
    const fail = (): never => {
      throw new StoreError('STORE_UNAVAILABLE', 'the browser closed this wallet\'s database');
    };
    const store: WalletStore = {
      get: (key) => (failing ? Promise.reject(fail()) : inner.get(key)),
      set: (key, value) => (failing ? Promise.reject(fail()) : inner.set(key, value)),
      delete: (key) => (failing ? Promise.reject(fail()) : inner.delete(key)),
      list: (prefix) => (failing ? Promise.reject(fail()) : inner.list(prefix)),
      batch: (operations) => (failing ? Promise.reject(fail()) : inner.batch(operations)),
      compareAndSet: (expected, operations) => (failing ? Promise.reject(fail()) : inner.compareAndSet(expected, operations)),
      close: async () => {
        closed = true;
        await inner.close();
      },
    };
    const wallet = await PearlWallet.create({ store, backend: new SimulatedChain(), passphrase: 'p', kdf: { N: 1024 } });
    failing = true;
    await expect(wallet.receiveAddress()).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' });
    await wallet.close().catch(() => undefined);
    expect(closed).toBe(true);
  });
});
