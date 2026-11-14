// The storage a wallet keeps its state in: string keys, JSON values, reads
// by key or prefix, and an atomic batch. Small enough to put over a file,
// IndexedDB, a key-value database or SQL table. Values are plain JSON, so
// amounts are decimal strings and bytes are hex; nothing here knows what a
// wallet is.

/**
 * Key-value storage for wallet state: the interface, an in-memory store, and
 * helpers for amounts and bytes in stored JSON. The Node file store is in
 * `pearljs/store-file` and the IndexedDB store in `pearljs/store-indexeddb`.
 *
 * @module
 */

/** A value a store holds: anything JSON can carry. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** One write in a batch. */
export type StoreOperation = { type: 'set'; key: string; value: JsonValue } | { type: 'delete'; key: string };

/**
 * Where a wallet keeps its state. Every write must be durable when its
 * promise resolves, and a batch must apply entirely or not at all. Values
 * come back as copies: changing one never changes the stored value.
 */
export interface WalletStore {
  get(key: string): Promise<JsonValue | undefined>;
  set(key: string, value: JsonValue): Promise<void>;
  delete(key: string): Promise<void>;
  /** Every entry whose key starts with prefix, sorted by key. An empty prefix lists everything. */
  list(prefix: string): Promise<[string, JsonValue][]>;
  batch(operations: readonly StoreOperation[]): Promise<void>;
  /** Releases the store's lock, if it has one. The store cannot be used afterwards. */
  close(): Promise<void>;
}

/** Copies a value through JSON, refusing what JSON cannot hold (bigint, undefined, functions, NaN). */
export function copyJson(value: JsonValue): JsonValue {
  checkJson(value, '');
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function checkJson(value: unknown, path: string): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`stored value${path} is not a finite number`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => checkJson(item, `${path}[${i}]`));
    return;
  }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      checkJson(item, `${path}.${key}`);
    }
    return;
  }
  throw new TypeError(`stored value${path} is a ${typeof value}, which JSON cannot hold; encode bigint as a decimal string`);
}

function checkKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0) throw new TypeError('store key must be a non-empty string');
}

/** Checks a batch before anything is written, so a bad operation leaves the store untouched. */
export function checkOperations(operations: readonly StoreOperation[]): StoreOperation[] {
  return operations.map((operation) => {
    checkKey(operation.key);
    if (operation.type === 'delete') return { type: 'delete', key: operation.key };
    if (operation.type !== 'set') throw new TypeError(`unknown store operation ${String((operation as { type: unknown }).type)}`);
    return { type: 'set', key: operation.key, value: copyJson(operation.value) };
  });
}

/** Applies checked operations to a map; shared by the memory and file stores. */
export function applyOperations(entries: Map<string, JsonValue>, operations: readonly StoreOperation[]): void {
  for (const operation of operations) {
    if (operation.type === 'set') entries.set(operation.key, operation.value);
    else entries.delete(operation.key);
  }
}

/** The entries of a map under a prefix, sorted and copied. */
export function listEntries(entries: ReadonlyMap<string, JsonValue>, prefix: string): [string, JsonValue][] {
  return [...entries.keys()]
    .filter((key) => key.startsWith(prefix))
    .sort()
    .map((key) => [key, copyJson(entries.get(key)!)]);
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
    if (!open) throw new Error('this wallet store is closed');
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
    async close() {
      open = false;
    },
  };
}

/** A bigint as stored: a decimal string. */
export function encodeBigint(value: bigint): string {
  return value.toString(10);
}

/** Reads a stored decimal string back as a bigint, refusing anything else. */
export function decodeBigint(value: unknown, what: string): bigint {
  if (typeof value !== 'string' || !/^-?(0|[1-9][0-9]*)$/.test(value)) throw new Error(`stored ${what} is not a decimal integer string`);
  return BigInt(value);
}

/** Bytes as stored: lowercase hex. */
export function encodeHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Reads stored hex back as bytes, refusing anything else. */
export function decodeHex(value: unknown, what: string): Uint8Array {
  if (typeof value !== 'string' || value.length % 2 !== 0 || !/^[0-9a-f]*$/.test(value)) throw new Error(`stored ${what} is not lowercase hex`);
  return Uint8Array.from(value.match(/../g) ?? [], (byte) => parseInt(byte, 16));
}
