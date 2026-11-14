// Leaf builders against leaves generate.go built with txscript.ScriptBuilder
// and spent through Pearl's script engine: CLTV and CSV leaves with spends
// before and after the lock matures, LockTimeToSequence, and multi_a leaves
// that Pearl's psbt.Finalize recognised.

import { describe, expect, it } from 'vitest';
import {
  checksigScript,
  cltvScript,
  csvScript,
  decodeSequence,
  deriveSigningAccountFromSeed,
  encodeSequence,
  multiAScript,
  networks,
  parseMultiA,
  parseTransaction,
  SEQUENCE_LOCKTIME_DISABLED,
} from '../src/index.js';
import vectors from '../vectors/pearl-go.json' with { type: 'json' };
import { bytesToHex, hexToBytes } from './vector-helpers.js';

const account = deriveSigningAccountFromSeed(hexToBytes(vectors.bip86.seed), networks.mainnet);

describe('timelock leaves', () => {
  for (const expected of vectors.leaves.timelocks.filter((item) => item.name !== 'csv-disabled-in-script')) {
    it(`build the ${expected.name} leaf Pearl spent`, () => {
      const tail = checksigScript(account.derivePublicKey(expected.keyIndex));
      const leaf = expected.kind === 'cltv' ? cltvScript(expected.value, tail) : csvScript(expected.value, tail);
      expect(bytesToHex(leaf)).toBe(expected.leafScript);
    });
  }

  it('read the spends Pearl refused as not yet mature', () => {
    for (const expected of vectors.leaves.timelocks.filter((item) => item.name.endsWith('before-maturity'))) {
      const spend = parseTransaction(expected.spendTxHex);
      if (expected.kind === 'cltv') {
        expect(spend.locktime).toBeLessThan(expected.value);
      } else {
        const want = decodeSequence(expected.value)!;
        const have = decodeSequence(spend.ins[0]!.sequence)!;
        expect(Object.keys(have)).toEqual(Object.keys(want));
        expect(Object.values(have)[0]).toBeLessThan(Object.values(want)[0]!);
      }
      expect(expected.error).toMatch(/^locktime requirement not satisfied/);
    }
  });

  it('refuses a locktime outside uint32', () => {
    const tail = checksigScript(new Uint8Array(32).fill(1));
    expect(() => cltvScript(-1, tail)).toThrow(RangeError);
    expect(() => cltvScript(2 ** 32, tail)).toThrow(RangeError);
  });

  it('refuses a CSV sequence that would not lock, though Pearl spends one', () => {
    const expected = vectors.leaves.timelocks.find((item) => item.name === 'csv-disabled-in-script')!;
    expect(expected.error).toBe('');
    const tail = checksigScript(account.derivePublicKey(expected.keyIndex));
    expect(() => csvScript(expected.value, tail)).toThrow(RangeError);
    expect(() => csvScript(0x10000, tail)).toThrow(RangeError);
  });
});

describe('BIP68 sequences', () => {
  it('encode like LockTimeToSequence', () => {
    for (const expected of vectors.leaves.sequences) {
      const lock = expected.isSeconds ? { seconds: expected.lockTime } : { blocks: expected.lockTime };
      expect(encodeSequence(lock), JSON.stringify(lock)).toBe(expected.sequence);
    }
  });

  it('decode to the lock calcSequenceLock applies', () => {
    expect(decodeSequence(144)).toEqual({ blocks: 144 });
    expect(decodeSequence(encodeSequence({ seconds: 1000 }))).toEqual({ seconds: 512 });
    expect(decodeSequence(0x0040ffff)).toEqual({ seconds: 0xffff * 512 });
    // Bits outside the type flag and the mask are ignored.
    expect(decodeSequence(0x7fbf0005)).toEqual({ blocks: 5 });
  });

  it('decode a sequence with the disable flag to no lock', () => {
    expect(decodeSequence(0xffffffff)).toBeNull();
    expect(decodeSequence(0xfffffffd)).toBeNull();
    expect(decodeSequence((SEQUENCE_LOCKTIME_DISABLED | 10) >>> 0)).toBeNull();
  });

  it('refuse a lock that does not fit in 16 bits', () => {
    expect(() => encodeSequence({ blocks: 0x10000 })).toThrow(RangeError);
    expect(() => encodeSequence({ seconds: 0x10000 * 512 })).toThrow(RangeError);
    expect(() => encodeSequence({ blocks: -1 })).toThrow(RangeError);
    expect(() => decodeSequence(2 ** 32)).toThrow(RangeError);
  });
});

describe('multiAScript', () => {
  const spends = [...vectors.multiASpends, vectors.leaves.multiA];
  const offset = (name: string): number => (name === vectors.leaves.multiA.name ? 50 : 20);

  for (const expected of spends) {
    it(`builds the ${expected.name} leaf Pearl finalized`, () => {
      const keys = expected.keyIndices.map((index) => account.derivePublicKey(offset(expected.name) + index));
      const leaf = multiAScript(keys, expected.threshold);
      expect(bytesToHex(leaf)).toBe(expected.leafScript);
      expect(parseMultiA(leaf)).toEqual({ keys, threshold: expected.threshold });
    });
  }

  it('refuses keys and thresholds Pearl would not finalize', () => {
    const keys = [1, 2, 3].map((byte) => new Uint8Array(32).fill(byte));
    expect(() => multiAScript([], 1)).toThrow(RangeError);
    expect(() => multiAScript(keys, 0)).toThrow(RangeError);
    expect(() => multiAScript(keys, 4)).toThrow(RangeError);
    expect(() => multiAScript([keys[0]!, new Uint8Array(33)], 1)).toThrow('must be 32 bytes');
    expect(() => multiAScript([keys[0]!, keys[1]!, keys[0]!], 2)).toThrow('duplicate');
  });
});
