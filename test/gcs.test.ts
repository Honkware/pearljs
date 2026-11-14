// Compact filters against vectors written by Pearl's gcs and gcs/builder
// packages (vectors/gcs/generate.go): SipHash, block filters byte for byte,
// filter hashes and the header chain, and Match and MatchAny results,
// false positives included, at fixed inputs.

import { describe, expect, it } from 'vitest';
import {
  BASIC_FILTER_M,
  BASIC_FILTER_P,
  buildBasicFilter,
  buildFilter,
  checkFilterHeaders,
  decodeFilter,
  encodeFilter,
  filterHash,
  filterHeader,
  filterHeaderHex,
  filterKey,
  PearldRpc,
  matchAnyFilter,
  matchFilter,
  parseBlock,
  sha256,
  sipHash24,
  type CompactFilter,
} from '../src/index.js';
import vectors from '../vectors/gcs.json' with { type: 'json' };
import { bytesToHex, hexToBytes } from './vector-helpers.js';

// The generator's item(tag, i): sha256(tag || be32(i)) cut to 8 + i%25 bytes.
function item(tag: string, i: number): Uint8Array {
  const input = new Uint8Array([...new TextEncoder().encode(tag), 0, 0, 0, 0]);
  new DataView(input.buffer).setUint32(input.length - 4, i);
  return sha256(input).slice(0, 8 + (i % 25));
}

function items(tag: string, from: number, count: number): Uint8Array[] {
  return Array.from({ length: count }, (_, i) => item(tag, from + i));
}

interface AnyVector {
  items: string[];
  tag?: string;
  from?: number;
  count?: number;
  matchAny: boolean;
  zip: boolean;
  hash: boolean;
}

function queries(vector: AnyVector): Uint8Array[] {
  return [...vector.items.map(hexToBytes), ...items(vector.tag ?? '', vector.from ?? 0, vector.count ?? 0)];
}

describe('Pearl compact filters', () => {
  it('uses the parameters of Pearl builder', () => {
    expect([BASIC_FILTER_P, BASIC_FILTER_M]).toEqual([vectors.defaults.p, vectors.defaults.m]);
  });

  it('computes SipHash-2-4 as Pearl does for every tail length', () => {
    for (const v of vectors.siphash) {
      expect(sipHash24(hexToBytes(v.key), hexToBytes(v.data)).toString(16).padStart(16, '0')).toBe(v.hash);
    }
  });

  it('builds the filter pearld indexes for each block, byte for byte', () => {
    for (const v of vectors.blocks) {
      const block = parseBlock(hexToBytes(v.blockHex));
      const filter = buildBasicFilter(block, v.prevOutScripts.map(hexToBytes));
      expect(filter.n, v.name).toBe(v.n);
      expect(bytesToHex(encodeFilter(filter)), v.name).toBe(v.filter);
      expect(bytesToHex(filterKey(v.blockHash)), v.name).toBe(v.key);
    }
  });

  it('hashes filters and chains their headers as cfindex does', () => {
    for (const v of vectors.blocks) {
      const filter = decodeFilter(v.filter);
      expect(filterHeaderHex(filterHash(filter)), v.name).toBe(v.filterHash);
      expect(filterHeaderHex(filterHeader(filter, v.prevHeader)), v.name).toBe(v.header);
    }
    const chain = vectors.blocks.map((v) => ({ filter: decodeFilter(v.filter), header: v.header }));
    const last = checkFilterHeaders(vectors.blocks[0]!.prevHeader, chain);
    expect(filterHeaderHex(last)).toBe(vectors.blocks.at(-1)!.header);
  });

  it('names the first filter whose header does not follow', () => {
    const chain = vectors.blocks.map((v) => ({ filter: decodeFilter(v.filter), header: v.header }));
    const swapped = [chain[0]!, chain[2]!, chain[1]!, ...chain.slice(3)];
    expect(() => checkFilterHeaders(vectors.blocks[0]!.prevHeader, swapped)).toThrow(/^filter 1 does not match/);
  });

  it('matches block items exactly as Pearl does', () => {
    for (const v of vectors.blocks) {
      const filter = decodeFilter(v.filter);
      const key = hexToBytes(v.key);
      for (const m of v.matches) expect(matchFilter(filter, key, hexToBytes(m.item)), `${v.name} ${m.item}`).toBe(m.match);
      for (const q of v.matchAny) expect(matchAnyFilter(filter, key, queries(q)), v.name).toBe(q.matchAny);
    }
  });

  it('builds synthetic filters at other parameters byte for byte', () => {
    for (const s of vectors.synthetic) {
      const filter = buildFilter(hexToBytes(s.key), items(s.tag, 0, s.count), s.params);
      expect(bytesToHex(encodeFilter(filter)), s.name).toBe(s.filter);
    }
  });

  it('reproduces Pearl false positives and its 32-bit MatchAny path', () => {
    for (const s of vectors.synthetic) {
      const filter = decodeFilter(s.filter, s.params);
      const key = hexToBytes(s.key);
      for (const m of s.matches) expect(matchFilter(filter, key, hexToBytes(m.item)), `${s.name} ${m.item}`).toBe(m.match);
      for (const q of s.matchAny) expect(matchAnyFilter(filter, key, queries(q)), `${s.name} ${q.count}`).toBe(q.matchAny);
    }
    // The wide filter's pinned item matches only on the hash path.
    const wide = vectors.synthetic.find((s) => s.name === 'wide')!;
    expect(wide.matchAny.map((q) => [q.matchAny, q.zip, q.hash])).toContainEqual([true, false, true]);
    const coarse = vectors.synthetic.find((s) => s.name === 'coarse')!;
    expect(coarse.matches.slice(10).some((m) => m.match)).toBe(true);
  });

  it('counts duplicates once and drops empty and OP_RETURN outputs', () => {
    const edge = vectors.blocks.find((v) => v.name === 'edge-outputs')!;
    const filter = decodeFilter(edge.filter);
    const key = hexToBytes(edge.key);
    expect(filter.n).toBe(edge.n);
    expect(matchFilter(filter, key, Uint8Array.of(0x6a, 0x01, 0x2a))).toBe(false);
    // An OP_RETURN prevout script is kept.
    expect(matchFilter(filter, key, Uint8Array.of(0x6a, 0x00))).toBe(true);
  });

  it('refuses malformed encodings and parameters', () => {
    expect(() => decodeFilter('')).toThrow(/empty/);
    expect(() => decodeFilter('fd0100')).toThrow(/non-canonical/);
    expect(() => decodeFilter('fe01')).toThrow(/ends inside/);
    expect(() => decodeFilter('zz')).toThrow(/hex/);
    expect(() => buildFilter(new Uint8Array(16), [], { p: 33, m: 1 })).toThrow(/P must/);
    expect(() => buildFilter(new Uint8Array(15), [])).toThrow(/16 bytes/);
  });

  it('treats a truncated filter as ending early, like Pearl reader', () => {
    const v = vectors.blocks.find((b) => b.name === 'v3-four-spends')!;
    const full = decodeFilter(v.filter);
    const cut: CompactFilter = { ...full, data: full.data.slice(0, 2) };
    const present = v.matches.filter((m) => m.match).map((m) => hexToBytes(m.item));
    expect(present.some((script) => matchFilter(full, hexToBytes(v.key), script))).toBe(true);
    expect(present.every((script) => !matchFilter(cut, hexToBytes(v.key), script))).toBe(true);
  });

  it('fetches a filter and checks it against getcfilterheader', async () => {
    const [prev, v] = [vectors.blocks[5]!, vectors.blocks[6]!];
    const calls: unknown[][] = [];
    const client = {
      call: async <T>(method: string, params: readonly unknown[] = []): Promise<T> => {
        calls.push([method, ...params]);
        return (method === 'getcfilter' ? v.filter : v.header) as T;
      },
    };
    const fetched = await new PearldRpc(client).getCFilter(v.blockHash, prev.header);
    expect(fetched.header).toBe(v.header);
    expect(bytesToHex(fetched.key)).toBe(v.key);
    expect(calls).toEqual([
      ['getcfilter', v.blockHash, 0],
      ['getcfilterheader', v.blockHash, 0],
    ]);
    await expect(new PearldRpc(client).getCFilter(v.blockHash, v.header)).rejects.toThrow(/does not match its header/);
  });
});
