// The IndexedDB store against a database another tab or a newer version of
// the application has changed: found in Chrome 157, where an open store
// blocked another tab's upgrade and a later version failed with a bare
// DOMException (scripts/browser-wallet-live.mjs).

import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { openIndexedDbStore } from '../src/index.js';

const openRaw = (name: string, version: number): Promise<string> =>
  new Promise((resolve) => {
    const request = indexedDB.open(name, version);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('entries')) request.result.createObjectStore('entries');
    };
    request.onsuccess = () => {
      request.result.close();
      resolve('opened');
    };
    request.onblocked = () => resolve('blocked');
    request.onerror = () => resolve(String(request.error));
  });

describe('IndexedDB store and other versions of its database', () => {
  it('lets another tab upgrade the database and then refuses every call', async () => {
    const store = await openIndexedDbStore('pearljs-upgrade', { unlocked: true });
    await store.set('k', 1);
    expect(await openRaw('pearljs-upgrade', 2)).toBe('opened');
    await expect(store.get('k')).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' });
    await expect(store.set('k', 2)).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' });
    await store.close();
  });

  it('refuses a database at a later version with STORE_INVALID', async () => {
    expect(await openRaw('pearljs-later', 3)).toBe('opened');
    await expect(openIndexedDbStore('pearljs-later', { unlocked: true })).rejects.toMatchObject({ code: 'STORE_INVALID' });
  });

  it('fails a write past the quota with STORE_WRITE_FAILED and keeps what was there', async () => {
    const store = await openIndexedDbStore('pearljs-quota', { unlocked: true });
    await store.set('small', 1);
    // Chrome 157 raised QuotaExceededError for a write past Storage.overrideQuotaForOrigin; fake-indexeddb has no quota.
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = () => {
      throw new DOMException('quota', 'QuotaExceededError');
    };
    try {
      await expect(store.set('big', 'x')).rejects.toMatchObject({ code: 'STORE_WRITE_FAILED' });
    } finally {
      IDBObjectStore.prototype.put = put;
    }
    expect(await store.get('small')).toBe(1);
    expect(await store.get('big')).toBeUndefined();
    await store.close();
  });
});
