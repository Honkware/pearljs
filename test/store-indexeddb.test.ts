// The IndexedDB store at run time, over fake-indexeddb (headless Chrome in
// the browser smoke test never completes IndexedDB requests under its
// virtual time budget). Node has no Web Locks API, so a small exclusive
// lock manager with the same ifAvailable semantics stands in for it, which
// lets the tab lock be tested too.

import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PearlWallet, openIndexedDbStore, parsePearl } from '../src/index.js';
import type { JsonValue } from '../src/index.js';
import { FakeChain, PASSPHRASE, newWallet } from './wallet-chain.js';

const held = new Set<string>();
const locks = {
  async request(name: string, _options: { ifAvailable: boolean }, callback: (lock: unknown) => Promise<void>): Promise<void> {
    if (held.has(name)) return callback(null);
    held.add(name);
    try {
      await callback({ name });
    } finally {
      held.delete(name);
    }
  },
};
let previous: PropertyDescriptor | undefined;
beforeAll(() => {
  previous = Object.getOwnPropertyDescriptor(globalThis.navigator, 'locks');
  Object.defineProperty(globalThis.navigator, 'locks', { value: locks, configurable: true });
});
afterAll(() => {
  if (previous === undefined) delete (globalThis.navigator as { locks?: unknown }).locks;
  else Object.defineProperty(globalThis.navigator, 'locks', previous);
});

let n = 0;
const fresh = (): string => `pearljs-test-${++n}`;

describe('IndexedDB store', () => {
  it('gets, sets, deletes and lists by prefix in key order', async () => {
    const store = await openIndexedDbStore(fresh());
    await store.set('tx:b', { n: '2' });
    await store.set('tx:a', [1]);
    await store.set('txt', 'outside the prefix');
    expect(await store.get('tx:b')).toEqual({ n: '2' });
    expect(await store.list('tx:')).toEqual([
      ['tx:a', [1]],
      ['tx:b', { n: '2' }],
    ]);
    await store.delete('tx:a');
    expect((await store.list('')).map(([key]) => key)).toEqual(['tx:b', 'txt']);
    await store.close();
  });

  it('applies a batch entirely or not at all, and hands out copies', async () => {
    const store = await openIndexedDbStore(fresh());
    await store.set('a', 1);
    await expect(store.batch([{ type: 'set', key: 'b', value: 2 }, { type: 'set', key: 'c', value: 3n as unknown as JsonValue }])).rejects.toThrow(TypeError);
    expect(await store.list('')).toEqual([['a', 1]]);
    const value = { list: [1] };
    await store.set('k', value);
    value.list.push(2);
    expect(await store.get('k')).toEqual({ list: [1] });
    await store.close();
  });

  it('keeps a second tab out until the first closes, and keeps the data', async () => {
    const name = fresh();
    const store = await openIndexedDbStore(name);
    await store.set('n', 7);
    await expect(openIndexedDbStore(name)).rejects.toMatchObject({ code: 'STORE_LOCKED' });
    await store.close();
    await expect(store.get('n')).rejects.toMatchObject({ code: 'STORE_CLOSED' });
    const reopened = await openIndexedDbStore(name);
    expect(await reopened.get('n')).toBe(7);
    await reopened.close();
  });

  it('holds a wallet across a restart', async () => {
    const name = fresh();
    const chain = new FakeChain();
    const wallet = await newWallet(chain, { store: await openIndexedDbStore(name) });
    chain.pay(await wallet.receiveAddress({ label: 'tab' }), parsePearl('3'));
    chain.mine();
    await wallet.sync();
    const balance = wallet.balance();
    await wallet.close();
    const reopened = await PearlWallet.open({ store: await openIndexedDbStore(name), backend: chain, transactions: chain });
    expect(reopened.balance()).toEqual(balance);
    expect(reopened.addresses()[0]!.label).toBe('tab');
    await reopened.unlock(PASSPHRASE);
    await reopened.close();
  });
});
