// A wallet store over IndexedDB, for browsers. One object store holds every
// entry under its key. A batch is one readwrite transaction with strict
// durability, so it is committed to disk, entirely or not at all, before its
// promise resolves.
//
// Two tabs must not write one wallet any more than two processes may. Where
// the Web Locks API exists, open takes an exclusive lock named after the
// database and holds it until close; a second tab fails to open instead of
// waiting.

/**
 * A wallet store over IndexedDB, locked to one tab with the Web Locks API.
 *
 * @module
 */

import { StoreError } from './errors.js';
import { checkExpectations, checkOperations, copyJson, sameJson } from './internal/store-ops.js';
import type { JsonValue, WalletStore } from './store.js';

const OBJECT_STORE = 'entries';

/** Options for openIndexedDbStore. */
export interface IndexedDbStoreOptions {
  /** The IndexedDB factory; globalThis.indexedDB unless given. */
  indexedDB?: IDBFactory;
  /** Skip the Web Locks lock even where the API exists. Only for environments that guarantee one writer some other way. */
  unlocked?: boolean;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new StoreError('STORE_UNAVAILABLE', 'IndexedDB request failed'));
  });
}

function completion(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new StoreError('STORE_UNAVAILABLE', 'IndexedDB transaction aborted'));
    tx.onerror = () => reject(tx.error ?? new StoreError('STORE_UNAVAILABLE', 'IndexedDB transaction failed'));
  });
}

interface LockManager {
  request(name: string, options: { ifAvailable: boolean; mode: 'exclusive' }, callback: (lock: unknown) => Promise<void>): Promise<void>;
}

// Holds the named lock until release is called; null when another holder has
// it. release resolves once the lock manager has let the lock go, which Firefox
// does a task after the callback settles: a store reopened before then would
// find its own lock still held.
async function holdLock(name: string): Promise<(() => Promise<void>) | null> {
  const locks = (globalThis.navigator as { locks?: LockManager } | undefined)?.locks;
  if (locks === undefined) return () => Promise.resolve();
  return new Promise((resolve, reject) => {
    const held = locks.request(name, { ifAvailable: true, mode: 'exclusive' }, (lock) => {
      if (lock === null) {
        resolve(null);
        return Promise.resolve();
      }
      return new Promise<void>((release) =>
        resolve(() => {
          release();
          return held;
        }),
      );
    });
    held.catch(reject);
  });
}

/**
 * Opens (creating if needed) the IndexedDB database `name` as a wallet store
 * and takes its tab lock. Rejects with StoreError: STORE_UNAVAILABLE without
 * IndexedDB, STORE_LOCKED when another tab or worker has the wallet open.
 */
export async function openIndexedDbStore(name: string, options: IndexedDbStoreOptions = {}): Promise<WalletStore> {
  if (typeof name !== 'string' || name.length === 0) throw new TypeError('database name must be a non-empty string');
  const factory = options.indexedDB ?? globalThis.indexedDB;
  if (factory === undefined) throw new StoreError('STORE_UNAVAILABLE', 'IndexedDB is not available here; use createMemoryStore, or createFileStore under Node');
  const release = options.unlocked === true ? () => Promise.resolve() : await holdLock(`pearljs-wallet:${name}`);
  if (release === null) throw new StoreError('STORE_LOCKED', `wallet ${name} is open in another tab or worker; two writers must never share a wallet`);

  let db: IDBDatabase;
  try {
    const opening = factory.open(name, 1);
    opening.onupgradeneeded = () => {
      if (!opening.result.objectStoreNames.contains(OBJECT_STORE)) opening.result.createObjectStore(OBJECT_STORE);
    };
    db = await request(opening);
  } catch (error) {
    await release();
    throw error;
  }
  let open = true;
  const ensureOpen = (): void => {
    if (!open) throw new StoreError('STORE_CLOSED', 'this wallet store is closed');
  };
  const transaction = (mode: IDBTransactionMode): IDBTransaction =>
    db.transaction(OBJECT_STORE, mode, mode === 'readwrite' ? { durability: 'strict' } : undefined);

  const store: WalletStore = {
    async get(key) {
      ensureOpen();
      const value = (await request(transaction('readonly').objectStore(OBJECT_STORE).get(key))) as JsonValue | undefined;
      return value === undefined ? undefined : copyJson(value);
    },
    async set(key, value) {
      await store.batch([{ type: 'set', key, value }]);
    },
    async delete(key) {
      await store.batch([{ type: 'delete', key }]);
    },
    async list(prefix) {
      ensureOpen();
      const objects = transaction('readonly').objectStore(OBJECT_STORE);
      const range = prefix === '' ? undefined : IDBKeyRange.bound(prefix, `${prefix}￿`);
      const [keys, values] = await Promise.all([request(objects.getAllKeys(range)), request(objects.getAll(range))]);
      return keys
        .map((key, i): [string, JsonValue] => [String(key), copyJson(values[i] as JsonValue)])
        .filter(([key]) => key.startsWith(prefix))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    },
    async batch(operations) {
      ensureOpen();
      const checked = checkOperations(operations);
      if (checked.length === 0) return;
      const tx = transaction('readwrite');
      const done = completion(tx);
      const objects = tx.objectStore(OBJECT_STORE);
      for (const operation of checked) {
        if (operation.type === 'set') objects.put(operation.value, operation.key);
        else objects.delete(operation.key);
      }
      await done;
    },
    async compareAndSet(expected, operations) {
      ensureOpen();
      const conditions = checkExpectations(expected);
      const checked = checkOperations(operations);
      // One readwrite transaction reads and writes: IndexedDB runs no other
      // writer of these keys, in any tab, between its first request and its commit.
      const tx = transaction('readwrite');
      const done = completion(tx);
      const objects = tx.objectStore(OBJECT_STORE);
      let stored: (JsonValue | undefined)[];
      try {
        stored = await Promise.all(conditions.map(({ key }) => request(objects.get(key) as IDBRequest<JsonValue | undefined>)));
      } catch (error) {
        done.catch(() => undefined);
        throw error;
      }
      if (!conditions.every(({ value }, i) => sameJson(stored[i], value))) {
        done.catch(() => undefined);
        tx.abort();
        return false;
      }
      for (const operation of checked) {
        if (operation.type === 'set') objects.put(operation.value, operation.key);
        else objects.delete(operation.key);
      }
      await done;
      return true;
    },
    async close() {
      if (!open) return;
      open = false;
      db.close();
      await release();
    },
  };
  return store;
}
