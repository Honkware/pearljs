// A map that forgets its least recently used entries past a size, for caches a server's answers fill.

export class BoundedMap<K, V> {
  readonly #items = new Map<K, V>();
  readonly #max: number;

  constructor(max: number) {
    this.#max = max;
  }

  get size(): number {
    return this.#items.size;
  }

  get(key: K): V | undefined {
    const value = this.#items.get(key);
    if (value !== undefined) {
      this.#items.delete(key);
      this.#items.set(key, value);
    }
    return value;
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  set(key: K, value: V): void {
    this.#items.delete(key);
    this.#items.set(key, value);
    if (this.#items.size > this.#max) this.#items.delete(this.#items.keys().next().value as K);
  }

  clear(): void {
    this.#items.clear();
  }
}

// Entries blockbookBackend keeps; tests lower them, for backends made after.
export const BLOCKBOOK_CACHE_LIMITS = {
  /** Transactions read, by txid. */
  transactions: 10_000,
  /** Downloaded blocks with their txids. */
  blocks: 1_000,
  /** Placements and block hashes checked, as short strings. */
  checks: 100_000,
};
