// The IndexedDB store's tab lock under a lock manager that lets a lock go a
// task after its callback settles, as Firefox 148 does. Found by the browser
// smoke test: a store reopened right after close failed with STORE_LOCKED.

import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { openIndexedDbStore } from '../src/index.js';
import { useNavigatorLocks } from './navigator-locks.js';

const held = new Set<string>();
const locks = {
  request(name: string, _options: { ifAvailable: boolean }, callback: (lock: unknown) => Promise<void>): Promise<void> {
    if (held.has(name)) return callback(null);
    held.add(name);
    return callback({ name }).finally(
      () =>
        new Promise<void>((done) =>
          setTimeout(() => {
            held.delete(name);
            done();
          }, 0),
        ),
    );
  },
};
useNavigatorLocks(locks);

describe('IndexedDB store tab lock', () => {
  it('reopens at once after close, when the lock manager releases a task later', async () => {
    const store = await openIndexedDbStore('pearljs-lock-reopen');
    await store.set('k', 1);
    await store.close();
    const again = await openIndexedDbStore('pearljs-lock-reopen');
    expect(await again.get('k')).toBe(1);
    await again.close();
  });

  it('still refuses a second open while the first is open', async () => {
    const store = await openIndexedDbStore('pearljs-lock-second');
    await expect(openIndexedDbStore('pearljs-lock-second')).rejects.toMatchObject({ code: 'STORE_LOCKED' });
    await store.close();
  });
});
