// A wallet store over IndexedDB, for browsers. One object store holds every
// entry under its key. A batch is one readwrite transaction with strict
// durability, so it is committed to disk, entirely or not at all, before its
// promise resolves.
//
// Two tabs must not write one wallet any more than two processes may. Where
// the Web Locks API exists, open takes an exclusive lock named after the
// database and holds it until close; a second tab fails to open instead of
// waiting.
//
// The store lets go of the database when another tab upgrades or deletes it,
// rather than blocking that tab, and from then on refuses every call.

/**
 * A wallet store over IndexedDB, locked to one tab with the Web Locks API.
 *
 * @module
 */

import { StoreError } from './errors.js';
import { checkExpectations, checkOperations, copyJson, sameJson } from './internal/store-ops.js';
import type { JsonValue, WalletStore } from './store.js';

const OBJECT_STORE = 'entries';
const VERSION = 1;

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

// The browser's DOMExceptions as the store's errors: a full quota fails the
// write, a database the browser closed or another tab upgraded can no longer
// be used, and one at a later version is not this store's.
function storeError(error: unknown, lost: string | null): unknown {
  if (error instanceof StoreError) return error;
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'QuotaExceededError') return new StoreError('STORE_WRITE_FAILED', 'the browser refused the write: the storage quota is full; nothing was written', { cause: error });
  if (name === 'VersionError') return new StoreError('STORE_INVALID', `the database is at a later version than this store's ${VERSION}; it belongs to a newer pearljs or another application`, { cause: error });
  if (lost !== null) return new StoreError('STORE_UNAVAILABLE', lost, { cause: error });
  if (name === 'InvalidStateError' || name === 'UnknownError') return new StoreError('STORE_UNAVAILABLE', `IndexedDB failed: ${(error as Error).message}`, { cause: error });
  return error;
}

interface LockManager {
  request(name: string, options: { ifAvailable: boolean; mode: 'exclusive' }, callback: (lock: unknown) => Promise<void>): Promise<void>;
  query?(): Promise<{ held?: { name?: string }[] }>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Holds the named lock until release is called; null when another holder has
// it. release resolves once the lock manager shows the lock let go. Firefox
// lets it go a task after the callback settles in a page, and later still in
// an extension's event page, after the request's promise has resolved: a
// store reopened before then would find its own lock still held.
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
        resolve(async () => {
          release();
          await held;
          // Bounded: another tab may take the lock the moment it is free, and then it stays held.
          for (let i = 0; i < 50 && locks.query !== undefined; i++) {
            const state = await locks.query();
            if (!(state.held ?? []).some((other) => other.name === name)) break;
            await sleep(20);
          }
        }),
      );
    });
    held.catch(reject);
  });
}

/**
 * Opens (creating if needed) the IndexedDB database `name` as a wallet store
 * and takes its tab lock. Rejects with StoreError: STORE_UNAVAILABLE without
 * IndexedDB, STORE_LOCKED when another tab or worker has the wallet open,
 * STORE_INVALID when the database is at a later version. Its calls reject
 * with STORE_WRITE_FAILED when the storage quota is full, and with
 * STORE_UNAVAILABLE once the browser has closed the database (site data
 * cleared) or another tab has upgraded or deleted it.
 */
export async function openIndexedDbStore(name: string, options: IndexedDbStoreOptions = {}): Promise<WalletStore> {
  if (typeof name !== 'string' || name.length === 0) throw new TypeError('database name must be a non-empty string');
  const factory = options.indexedDB ?? globalThis.indexedDB;
  if (factory === undefined) throw new StoreError('STORE_UNAVAILABLE', 'IndexedDB is not available here; use createMemoryStore, or createFileStore under Node');
  const release = options.unlocked === true ? () => Promise.resolve() : await holdLock(`pearljs-wallet:${name}`);
  if (release === null) throw new StoreError('STORE_LOCKED', `wallet ${name} is open in another tab or worker; two writers must never share a wallet`);

  let db: IDBDatabase;
  try {
    const opening = factory.open(name, VERSION);
    opening.onupgradeneeded = () => {
      if (!opening.result.objectStoreNames.contains(OBJECT_STORE)) opening.result.createObjectStore(OBJECT_STORE);
    };
    db = await request(opening);
  } catch (error) {
    await release();
    throw storeError(error, null);
  }
  let open = true;
  // Why the database went away under the store, or null while it is usable.
  let lost: string | null = null;
  // Another tab upgrading or deleting the database waits for every open connection to close.
  db.onversionchange = () => {
    lost = 'another tab upgraded or deleted this wallet\'s database; reopen the store';
    db.close();
  };
  // Fired when the browser closes the connection itself: site data cleared, or the storage lost.
  db.onclose = () => {
    lost ??= 'the browser closed this wallet\'s database (site data cleared or storage lost); reopen the store';
  };
  const ensureOpen = (): void => {
    if (!open) throw new StoreError('STORE_CLOSED', 'this wallet store is closed');
    if (lost !== null) throw new StoreError('STORE_UNAVAILABLE', lost);
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
  for (const method of ['get', 'set', 'delete', 'list', 'batch', 'compareAndSet'] as const) {
    const run = store[method] as (...args: unknown[]) => Promise<unknown>;
    (store as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => run(...args).catch((error: unknown) => Promise.reject(storeError(error, lost)));
  }
  return store;
}
