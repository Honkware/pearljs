// BIP158 compact block filters as Pearl builds them (node/btcutil/gcs and
// gcs/builder): Golomb-coded sets with P = 19 and M = 784931, keyed by the
// first 16 bytes of the block hash. Pearl's block hash covers the 108-byte
// header, so keys differ from Bitcoin's for the same transactions.
//
// Matching follows Pearl's Go code, false positives included. Its MatchAny
// switches to a hash-set path once there are at least N/2 queries, and that
// path compares only the low 32 bits of each value, so above 5471 entries it
// matches some items that Match does not.

import { hash256 } from './crypto.js';
import { blockHash } from './blockheader.js';
import type { PearlBlock } from './block.js';

/** Golomb-Rice parameter of Pearl's basic filter (builder.DefaultP). */
export const BASIC_FILTER_P = 19;
/** False-positive modulus of Pearl's basic filter (builder.DefaultM). */
export const BASIC_FILTER_M = 784931;
/** getcfilter's filter type for the basic filter, the only one pearld builds. */
export const BASIC_FILTER_TYPE = 0;

export interface GcsParams {
  readonly p: number;
  readonly m: number;
}

export interface CompactFilter {
  /** Number of distinct items in the set. */
  readonly n: number;
  readonly p: number;
  readonly m: number;
  /** The Golomb-coded bits, without the N prefix. */
  readonly data: Uint8Array;
}

const BASIC: GcsParams = { p: BASIC_FILTER_P, m: BASIC_FILTER_M };
const TWO_32 = 2 ** 32;

/** SipHash-2-4 of data under a 16-byte key, as aead/siphash's Sum64. */
export function sipHash24(key: Uint8Array, data: Uint8Array): bigint {
  if (key.length !== 16) throw new RangeError(`SipHash key must be 16 bytes, got ${key.length}`);
  const [hi, lo] = sipHash(key, data);
  return (BigInt(hi) << 32n) | BigInt(lo);
}

// Each 64-bit lane is a pair of uint32 words, high then low, in v.
function sipHash(key: Uint8Array, data: Uint8Array): [number, number] {
  const k = new DataView(key.buffer, key.byteOffset, 16);
  const k0h = k.getUint32(4, true);
  const k0l = k.getUint32(0, true);
  const k1h = k.getUint32(12, true);
  const k1l = k.getUint32(8, true);
  const v = new Uint32Array([
    k0h ^ 0x736f6d65, k0l ^ 0x70736575,
    k1h ^ 0x646f7261, k1l ^ 0x6e646f6d,
    k0h ^ 0x6c796765, k0l ^ 0x6e657261,
    k1h ^ 0x74656462, k1l ^ 0x79746573,
  ]);
  const add = (a: number, b: number) => {
    const lo = v[a + 1]! + v[b + 1]!;
    v[a] = v[a]! + v[b]! + (lo > 0xffffffff ? 1 : 0);
    v[a + 1] = lo;
  };
  const rotl = (a: number, n: number) => {
    let h = v[a]!;
    let l = v[a + 1]!;
    if (n >= 32) [h, l, n] = [l, h, n - 32];
    if (n > 0) [h, l] = [(h << n) | (l >>> (32 - n)), (l << n) | (h >>> (32 - n))];
    v[a] = h;
    v[a + 1] = l;
  };
  const xor = (a: number, b: number) => {
    v[a] = v[a]! ^ v[b]!;
    v[a + 1] = v[a + 1]! ^ v[b + 1]!;
  };
  const round = () => {
    add(0, 2); rotl(2, 13); xor(2, 0); rotl(0, 32);
    add(4, 6); rotl(6, 16); xor(6, 4);
    add(0, 6); rotl(6, 21); xor(6, 0);
    add(4, 2); rotl(2, 17); xor(2, 4); rotl(4, 32);
  };
  const compress = (mh: number, ml: number, rounds: number) => {
    v[6] = v[6]! ^ mh;
    v[7] = v[7]! ^ ml;
    for (let i = 0; i < rounds; i++) round();
    v[0] = v[0]! ^ mh;
    v[1] = v[1]! ^ ml;
  };

  const d = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const whole = data.length - (data.length % 8);
  for (let i = 0; i < whole; i += 8) compress(d.getUint32(i + 4, true), d.getUint32(i, true), 2);
  const tail = new Uint8Array(8);
  tail.set(data.subarray(whole));
  tail[7] = data.length & 0xff;
  const t = new DataView(tail.buffer);
  compress(t.getUint32(4, true), t.getUint32(0, true), 2);
  v[5] = v[5]! ^ 0xff;
  for (let i = 0; i < 4; i++) round();
  return [(v[0]! ^ v[2]! ^ v[4]! ^ v[6]!) >>> 0, (v[1]! ^ v[3]! ^ v[5]! ^ v[7]!) >>> 0];
}

function checkParams({ p, m }: GcsParams, n: number): void {
  if (!Number.isInteger(p) || p < 0 || p > 32) throw new RangeError('P must be an integer from 0 to 32');
  if (!Number.isInteger(m) || m < 1 || m >= TWO_32) throw new RangeError('M must be an integer from 1 to 2^32 - 1');
  if (!Number.isInteger(n) || n < 0 || n >= TWO_32) throw new RangeError('N must fit in 32 bits');
  if (n * m > Number.MAX_SAFE_INTEGER) throw new RangeError('N * M is too large');
}

// gcs.fastReduction: the high 64 bits of hash * N*M, a value below N*M.
function reduce(key: Uint8Array, item: Uint8Array, modulus: number): number {
  const [hi, lo] = sipHash(key, item);
  return Number((((BigInt(hi) << 32n) | BigInt(lo)) * BigInt(modulus)) >> 64n);
}

function toKey(key: Uint8Array): Uint8Array {
  if (!(key instanceof Uint8Array) || key.length !== 16) throw new RangeError('filter key must be 16 bytes');
  return key;
}

/**
 * Builds a filter over the distinct items, as gcs.BuildGCSFilter after the
 * builder's deduplication.
 */
export function buildFilter(key: Uint8Array, items: readonly Uint8Array[], params: GcsParams = BASIC): CompactFilter {
  toKey(key);
  const distinct = new Map<string, Uint8Array>();
  for (const item of items) distinct.set(hex(item), item);
  const n = distinct.size;
  checkParams(params, n);
  const { p, m } = params;
  const modulus = n * m;
  const values = [...distinct.values()].map((item) => reduce(key, item, modulus)).sort((a, b) => a - b);

  const bits: number[] = [];
  const scale = 2 ** p;
  let last = 0;
  for (const value of values) {
    const delta = value - last;
    const quotient = Math.floor(delta / scale);
    const remainder = delta - quotient * scale;
    for (let i = 0; i < quotient; i++) bits.push(1);
    bits.push(0);
    for (let i = p - 1; i >= 0; i--) bits.push(Math.floor(remainder / 2 ** i) % 2);
    last = value;
  }
  const data = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((bit, i) => {
    if (bit) data[i >> 3] = data[i >> 3]! | (0x80 >> (i & 7));
  });
  return { n, p, m, data };
}

/**
 * Pearl's basic filter for a block (builder.BuildBasicFilter): every
 * non-empty output script that does not start with OP_RETURN, and every
 * non-empty script the block's inputs spend. Spent scripts are not in the
 * block, so the caller supplies them, coinbase excepted.
 */
export function buildBasicFilter(block: PearlBlock, prevOutScripts: readonly Uint8Array[]): CompactFilter {
  const items: Uint8Array[] = [];
  for (const tx of block.transactions) {
    for (const out of tx.outs) {
      if (out.script.length > 0 && out.script[0] !== 0x6a) items.push(out.script);
    }
  }
  // Pearl drops empty prevout scripts but keeps ones starting with OP_RETURN.
  for (const script of prevOutScripts) if (script.length > 0) items.push(script);
  return buildFilter(filterKey(blockHash(block.header)), items);
}

/**
 * Decodes a filter in its N-prefixed wire form, as getcfilter returns it in
 * hex. P and M are not in the encoding; they default to the basic filter's.
 */
export function decodeFilter(filter: string | Uint8Array, params: GcsParams = BASIC): CompactFilter {
  const bytes = typeof filter === 'string' ? unhex(filter) : filter;
  const [n, size] = readVarInt(bytes);
  checkParams(params, n);
  return { n, p: params.p, m: params.m, data: bytes.slice(size) };
}

/** The N-prefixed wire form, gcs.Filter.NBytes. */
export function encodeFilter(filter: CompactFilter): Uint8Array {
  const prefix = writeVarInt(filter.n);
  const out = new Uint8Array(prefix.length + filter.data.length);
  out.set(prefix);
  out.set(filter.data, prefix.length);
  return out;
}

/**
 * The filter key for a block: the first 16 bytes of its hash in internal
 * order. A string is read as display hex, the form RPC methods use; bytes are
 * taken in internal order, as blockHash returns them.
 */
export function filterKey(blockHashValue: string | Uint8Array): Uint8Array {
  return toInternal(blockHashValue, 'block hash').slice(0, 16);
}

const decoded = new WeakMap<CompactFilter, number[]>();

// Every value up to the end of the data, as Pearl's readers see them: a
// truncated value ends the list. HashMatchAny reads all of them, Match and
// ZipMatchAny only the first N.
function values(filter: CompactFilter): number[] {
  const cached = decoded.get(filter);
  if (cached !== undefined) return cached;
  const { data, p } = filter;
  const total = data.length * 8;
  const scale = 2 ** p;
  const out: number[] = [];
  let pos = 0;
  let value = 0;
  const bit = () => (data[pos >> 3]! >> (7 - (pos++ & 7))) & 1;
  for (;;) {
    // A unary quotient ended by a zero, then P remainder bits; running out
    // of bits anywhere ends the list, as Pearl's bit reader does.
    let quotient = 0;
    let ended = false;
    while (pos < total) {
      if (bit() === 0) {
        ended = true;
        break;
      }
      quotient++;
    }
    if (!ended || pos + p > total) break;
    let remainder = 0;
    for (let i = 0; i < p; i++) remainder = remainder * 2 + bit();
    value += quotient * scale + remainder;
    if (value > Number.MAX_SAFE_INTEGER) throw new RangeError('filter value out of range');
    out.push(value);
  }
  decoded.set(filter, out);
  return out;
}

/** Whether the item may be in the set, as gcs.Filter.Match. */
export function matchFilter(filter: CompactFilter, key: Uint8Array, item: Uint8Array): boolean {
  const term = reduce(toKey(key), item, filter.n * filter.m);
  const all = values(filter);
  for (let i = 0; i < Math.min(filter.n, all.length); i++) {
    if (all[i] === term) return true;
    if (all[i]! > term) return false;
  }
  return false;
}

/**
 * Whether any item may be in the set, as gcs.Filter.MatchAny, including its
 * 32-bit comparison when there are at least N/2 items.
 */
export function matchAnyFilter(filter: CompactFilter, key: Uint8Array, items: readonly Uint8Array[]): boolean {
  toKey(key);
  if (items.length === 0) return false;
  const modulus = filter.n * filter.m;
  const terms = items.map((item) => reduce(key, item, modulus));
  const all = values(filter);
  if (items.length >= Math.floor(filter.n / 2)) {
    const low = new Set(all.map((value) => value % TWO_32));
    return terms.some((term) => low.has(term % TWO_32));
  }
  const prefix = new Set(all.slice(0, filter.n));
  return terms.some((term) => prefix.has(term));
}

/** Double SHA-256 of the N-prefixed filter, in internal order. */
export function filterHash(filter: CompactFilter): Uint8Array {
  return hash256(encodeFilter(filter));
}

/**
 * The filter header that commits to this filter and the previous block's
 * header, in internal order. A string is read as display hex, as
 * getcfilterheader returns it. The genesis block's previous header is zero.
 */
export function filterHeader(filter: CompactFilter, prevHeader: string | Uint8Array): Uint8Array {
  const input = new Uint8Array(64);
  input.set(filterHash(filter));
  input.set(toInternal(prevHeader, 'previous filter header'), 32);
  return hash256(input);
}

/** A filter header or hash as display hex, the form getcfilterheader returns. */
export function filterHeaderHex(header: Uint8Array): string {
  return hex(Uint8Array.from(header).reverse());
}

/**
 * Checks a run of consecutive filters against their headers, starting from
 * the header before the first. Throws at the first filter whose header does
 * not follow; returns the last header.
 */
export function checkFilterHeaders(
  prevHeader: string | Uint8Array,
  chain: readonly { readonly filter: CompactFilter; readonly header: string | Uint8Array }[],
): Uint8Array {
  let prev = toInternal(prevHeader, 'previous filter header');
  chain.forEach(({ filter, header }, i) => {
    const computed = filterHeader(filter, prev);
    const expected = toInternal(header, 'filter header');
    if (hex(computed) !== hex(expected)) {
      throw new Error(
        `filter ${i} does not match its header: computed ${filterHeaderHex(computed)}, expected ${filterHeaderHex(expected)}`,
      );
    }
    prev = computed;
  });
  return prev;
}

/** Anything with a JSON-RPC call, such as PearldClient or PearlWsClient. */
export interface FilterRpc {
  call<T = unknown>(method: string, params?: readonly unknown[]): Promise<T>;
}

export interface BlockFilter {
  readonly blockHash: string;
  readonly key: Uint8Array;
  readonly filter: CompactFilter;
  /** getcfilterheader's value, set when the filter was checked against it. */
  readonly header?: string;
}

/**
 * Fetches a block's basic filter with getcfilter. With prevHeader, the
 * filter header of the block before, it also fetches getcfilterheader and
 * throws unless the filter hashes to it. Both come from the same node, so
 * this detects corruption, not a lying node; compare headers across sources
 * for that. pearld needs its CF index, which is on unless --nocfilters.
 */
export async function getBlockFilter(client: FilterRpc, blockHashHex: string, prevHeader?: string): Promise<BlockFilter> {
  const filter = decodeFilter(await client.call<string>('getcfilter', [blockHashHex, BASIC_FILTER_TYPE]));
  const key = filterKey(blockHashHex);
  if (prevHeader === undefined) return { blockHash: blockHashHex, key, filter };
  const header = await client.call<string>('getcfilterheader', [blockHashHex, BASIC_FILTER_TYPE]);
  checkFilterHeaders(prevHeader, [{ filter, header }]);
  return { blockHash: blockHashHex, key, filter, header };
}

function readVarInt(bytes: Uint8Array): [number, number] {
  if (bytes.length < 1) throw new Error('filter is empty');
  const first = bytes[0]!;
  const width = first < 0xfd ? 0 : first === 0xfd ? 2 : first === 0xfe ? 4 : 8;
  if (bytes.length < 1 + width) throw new Error('filter ends inside its item count');
  if (width === 0) return [first, 1];
  let value = 0;
  for (let i = width; i >= 1; i--) value = value * 256 + bytes[i]!;
  // wire.ReadVarInt refuses encodings longer than needed.
  const min = width === 2 ? 0xfd : width === 4 ? 0x10000 : TWO_32;
  if (value < min) throw new Error(`non-canonical varint ${value} for filter item count`);
  if (value >= TWO_32) throw new RangeError('filter item count does not fit in 32 bits');
  return [value, 1 + width];
}

function writeVarInt(n: number): Uint8Array {
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, n >> 8);
  return Uint8Array.of(0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24);
}

function toInternal(value: string | Uint8Array, label: string): Uint8Array {
  const bytes = typeof value === 'string' ? unhex(value).reverse() : value;
  if (bytes.length !== 32) throw new RangeError(`${label} must be 32 bytes`);
  return bytes;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function unhex(text: string): Uint8Array {
  if (text.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(text)) throw new Error('expected hex');
  const bytes = new Uint8Array(text.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}
