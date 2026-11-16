// What the stores share: checking operations before any is
// applied, applying them to a map, and copying values in and out. Also the
// encodings wallet records use for amounts and bytes. Not a subpath export.

import type { JsonValue, StoreExpectation, StoreOperation } from '../store.js';
import { StoreError } from '../errors.js';
import { toHex } from './bytes.js';

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

export function checkKey(key: string): void {
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

// JSON with object keys in order, so two values are equal exactly when their text is.
function canonical(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(',')}}`;
}

/** Whether a stored value (undefined: none) is the one expected, whatever the order of its object keys. */
export function sameJson(stored: JsonValue | undefined, expected: JsonValue | undefined): boolean {
  if (stored === undefined || expected === undefined) return stored === expected;
  return canonical(stored) === canonical(expected);
}

/** Checks the expectations of a compareAndSet before anything is read. */
export function checkExpectations(expected: readonly StoreExpectation[]): StoreExpectation[] {
  return expected.map(({ key, value }) => {
    checkKey(key);
    return { key, value: value === undefined ? undefined : copyJson(value) };
  });
}

/** Whether every expectation holds in a map. */
export function expectationsHold(entries: ReadonlyMap<string, JsonValue>, expected: readonly StoreExpectation[]): boolean {
  return expected.every(({ key, value }) => sameJson(entries.get(key), value));
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

/** A bigint as stored: a decimal string. */
export function encodeBigint(value: bigint): string {
  return value.toString(10);
}

/** Reads a stored decimal string back as a bigint, refusing anything else. */
export function decodeBigint(value: unknown, what: string): bigint {
  if (typeof value !== 'string' || !/^-?(0|[1-9][0-9]*)$/.test(value)) throw new StoreError('STORE_INVALID', `stored ${what} is not a decimal integer string`);
  return BigInt(value);
}

/** Bytes as stored: lowercase hex. */
export function encodeHex(bytes: Uint8Array): string {
  return toHex(bytes);
}

/** Reads stored hex back as bytes, refusing anything else. */
export function decodeHex(value: unknown, what: string): Uint8Array {
  if (typeof value !== 'string' || value.length % 2 !== 0 || !/^[0-9a-f]*$/.test(value)) throw new StoreError('STORE_INVALID', `stored ${what} is not lowercase hex`);
  return Uint8Array.from(value.match(/../g) ?? [], (byte) => parseInt(byte, 16));
}
