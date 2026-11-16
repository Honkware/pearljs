// The storage a wallet keeps its state in: string keys, JSON values, reads
// by key or prefix, an atomic batch, and a batch that applies only if some
// keys still hold what the caller last saw. Small enough to put over a file,
// IndexedDB, a key-value database or SQL table. Values are plain JSON, so
// amounts are decimal strings and bytes are hex; nothing here knows what a
// wallet is.

/**
 * Key-value storage for wallet state: the interface and an in-memory store.
 * The Node file store is in `pearljs/store-file` and the IndexedDB store in
 * `pearljs/store-indexeddb`.
 *
 * @module
 */

import { StoreError } from './errors.js';
import { applyOperations, checkExpectations, checkKey, checkOperations, copyJson, expectationsHold, listEntries } from './internal/store-ops.js';

/** A value a store holds: anything JSON can carry. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** One write in a batch. */
export type StoreOperation = { type: 'set'; key: string; value: JsonValue } | { type: 'delete'; key: string };

/** What a key must hold for a compareAndSet to apply. `value: undefined` means the key must be absent. */
export interface StoreExpectation {
  key: string;
  value: JsonValue | undefined;
}

/**
 * Where a wallet keeps its state. Every write must be durable when its
 * promise resolves, and a batch must apply entirely or not at all. Values
 * come back as copies: changing one never changes the stored value. A value
 * JSON cannot hold is a TypeError; the stores here throw StoreError for
 * everything else.
 */
export interface WalletStore {
  get(key: string): Promise<JsonValue | undefined>;
  set(key: string, value: JsonValue): Promise<void>;
  delete(key: string): Promise<void>;
  /** Every entry whose key starts with prefix, sorted by key. An empty prefix lists everything. */
  list(prefix: string): Promise<[string, JsonValue][]>;
  batch(operations: readonly StoreOperation[]): Promise<void>;
  /**
   * Applies the operations, entirely or not at all, only if every expected
   * key holds exactly the expected value in the durable state at that
   * moment; resolves false, having written nothing, if one does not. The
   * check and the write are one step against every other writer of the
   * store, in this process or another: of two calls expecting the same
   * value, one applies. Values are compared as JSON, whatever the order of
   * object keys. A wallet reserves XMSS indices through this, so a store
   * that answers from a cache, or checks and then writes, lets two writers
   * sign with one index.
   */
  compareAndSet(expected: readonly StoreExpectation[], operations: readonly StoreOperation[]): Promise<boolean>;
  /** Releases the store's lock, if it has one. The store cannot be used afterwards. */
  close(): Promise<void>;
}

/**
 * A store that lives in memory and is lost with the process. For tests,
 * examples and wallets rebuilt from the chain on every start. Not for XMSS
 * keys: their index state must outlive the process.
 */
export function createMemoryStore(initial: Iterable<[string, JsonValue]> = []): WalletStore {
  const entries = new Map<string, JsonValue>();
  applyOperations(entries, checkOperations([...initial].map(([key, value]) => ({ type: 'set', key, value }))));
  let open = true;
  const ensureOpen = (): void => {
    if (!open) throw new StoreError('STORE_CLOSED', 'this wallet store is closed');
  };
  return {
    async get(key) {
      ensureOpen();
      checkKey(key);
      const value = entries.get(key);
      return value === undefined ? undefined : copyJson(value);
    },
    async set(key, value) {
      ensureOpen();
      applyOperations(entries, checkOperations([{ type: 'set', key, value }]));
    },
    async delete(key) {
      ensureOpen();
      applyOperations(entries, checkOperations([{ type: 'delete', key }]));
    },
    async list(prefix) {
      ensureOpen();
      return listEntries(entries, prefix);
    },
    async batch(operations) {
      ensureOpen();
      applyOperations(entries, checkOperations(operations));
    },
    async compareAndSet(expected, operations) {
      ensureOpen();
      const conditions = checkExpectations(expected);
      const checked = checkOperations(operations);
      // No await between the check and the write, so nothing in this process runs between them.
      if (!expectationsHold(entries, conditions)) return false;
      applyOperations(entries, checked);
      return true;
    },
    async close() {
      open = false;
    },
  };
}
