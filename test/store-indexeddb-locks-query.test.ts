// The IndexedDB store's tab lock under a lock manager whose request settles
// before the lock shows as free, as Firefox 154 does in an extension's event
// page: a store reopened right after close failed with STORE_LOCKED there
// even once close waited for the request (scratch extension, 2026-11-19).

import 'fake-indexeddb/auto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openIndexedDbStore } from '../src/index.js';

const held = new Set<string>();
const locks = {
  request(name: string, _options: { ifAvailable: boolean }, callback: (lock: unknown) => Promise<void>): Promise<void> {
    if (held.has(name)) return callback(null);
    held.add(name);
    return callback({ name }).finally(() => {
      setTimeout(() => held.delete(name), 30);
    });
  },
  query: async () => ({ held: [...held].map((name) => ({ name })) }),
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

describe('IndexedDB store tab lock, released late', () => {
  it('reopens at once after close when the lock shows free only after the request settles', async () => {
    const store = await openIndexedDbStore('pearljs-lock-late');
    await store.set('k', 1);
    await store.close();
    const again = await openIndexedDbStore('pearljs-lock-late');
    expect(await again.get('k')).toBe(1);
    await again.close();
  });
});
