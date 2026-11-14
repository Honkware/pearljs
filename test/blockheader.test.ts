import { describe, expect, it } from 'vitest';
import vectors from '../vectors/pearl-go.json' with { type: 'json' };
import { bytesToHex, hexToBytes } from './vector-helpers.js';
import {
  BLOCK_HEADER_SIZE,
  blockHash,
  blockHashHex,
  parseBlockHeader,
  serializeBlockHeader,
} from '../src/blockheader.js';
import type { PearlBlockHeader } from '../src/blockheader.js';

interface BlockHeaderVector {
  name: string;
  hex: string;
  hash: string;
  version: number;
  timestamp: number;
  bits: number;
}

const blockHeaderVectors =
  (vectors as { blockHeaders?: BlockHeaderVector[] }).blockHeaders ?? [];

function sampleHeader(): PearlBlockHeader {
  return {
    version: 2,
    prevBlock: new Uint8Array(32).fill(0x11),
    merkleRoot: new Uint8Array(32).fill(0x22),
    timestamp: 1700000000,
    bits: 0x1d00ffff,
    proofCommitment: new Uint8Array(32).fill(0x33),
  };
}

describe('Go block header vectors', () => {
  it('provides block header vectors', () => {
    expect(blockHeaderVectors.length).toBeGreaterThan(0);
  });

  it('parses, serializes, and hashes each vector', () => {
    for (const expected of blockHeaderVectors) {
      const bytes = hexToBytes(expected.hex);
      expect(bytes.length).toBe(BLOCK_HEADER_SIZE);

      const header = parseBlockHeader(bytes);
      expect(header.version).toBe(expected.version);
      expect(header.timestamp).toBe(expected.timestamp);
      expect(header.bits).toBe(expected.bits);
      expect(bytesToHex(header.prevBlock)).toBe(expected.hex.slice(8, 72));
      expect(bytesToHex(header.merkleRoot)).toBe(expected.hex.slice(72, 136));
      expect(bytesToHex(header.proofCommitment)).toBe(expected.hex.slice(152, 216));

      expect(bytesToHex(serializeBlockHeader(header))).toBe(expected.hex);
      expect(blockHashHex(header)).toBe(expected.hash);
      // chainhash display hex is the reversed internal-order digest.
      expect(bytesToHex(blockHash(header).slice().reverse())).toBe(expected.hash);
    }
  });
});

describe('serializeBlockHeader', () => {
  it('serializes fields at their wire offsets in little-endian order', () => {
    const hex = bytesToHex(serializeBlockHeader(sampleHeader()));
    expect(hex).toBe(
      '02000000' +
        '11'.repeat(32) +
        '22'.repeat(32) +
        '00f15365' +
        'ffff001d' +
        '33'.repeat(32),
    );
  });

  it('round-trips extreme version, timestamp, and bits values', () => {
    const header = {
      ...sampleHeader(),
      version: -1,
      timestamp: 0xffffffff,
      bits: 0xffffffff,
    };
    expect(parseBlockHeader(serializeBlockHeader(header))).toEqual(header);
    expect(parseBlockHeader(serializeBlockHeader({ ...header, version: -0x80000000 })).version).toBe(
      -0x80000000,
    );
  });

  it('rejects versions outside the signed 32-bit range', () => {
    for (const version of [-0x80000001, 0x80000000, 1.5, NaN]) {
      expect(() => serializeBlockHeader({ ...sampleHeader(), version })).toThrow(RangeError);
    }
  });

  it('rejects timestamps and bits outside the unsigned 32-bit range', () => {
    for (const value of [-1, 0x100000000, 1.5, NaN]) {
      expect(() => serializeBlockHeader({ ...sampleHeader(), timestamp: value })).toThrow(
        RangeError,
      );
      expect(() => serializeBlockHeader({ ...sampleHeader(), bits: value })).toThrow(RangeError);
    }
  });

  it('rejects hash fields that are not 32 bytes', () => {
    for (const field of ['prevBlock', 'merkleRoot', 'proofCommitment'] as const) {
      for (const length of [0, 31, 33]) {
        expect(() =>
          serializeBlockHeader({ ...sampleHeader(), [field]: new Uint8Array(length) }),
        ).toThrow(RangeError);
      }
      expect(() =>
        serializeBlockHeader({ ...sampleHeader(), [field]: [1, 2, 3] as unknown as Uint8Array }),
      ).toThrow(TypeError);
    }
  });
});

describe('parseBlockHeader', () => {
  it('rejects headers with malformed lengths', () => {
    for (const length of [0, 1, BLOCK_HEADER_SIZE - 1, BLOCK_HEADER_SIZE + 1]) {
      expect(() => parseBlockHeader(new Uint8Array(length))).toThrow(RangeError);
    }
  });

  it('rejects non-Uint8Array input', () => {
    expect(() =>
      parseBlockHeader(new Array<number>(BLOCK_HEADER_SIZE).fill(0) as unknown as Uint8Array),
    ).toThrow(TypeError);
  });

  it('parses negative versions and maximum unsigned scalars', () => {
    const bytes = new Uint8Array(BLOCK_HEADER_SIZE);
    const view = new DataView(bytes.buffer);
    view.setInt32(0, -2, true);
    view.setUint32(68, 0xffffffff, true);
    view.setUint32(72, 0xffffffff, true);
    const header = parseBlockHeader(bytes);
    expect(header.version).toBe(-2);
    expect(header.timestamp).toBe(0xffffffff);
    expect(header.bits).toBe(0xffffffff);
  });

  it('copies caller data in both directions', () => {
    const bytes = hexToBytes(blockHeaderVectors[0]?.hex ?? bytesToHex(serializeBlockHeader(sampleHeader())));
    const snapshot = bytesToHex(bytes);

    const header = parseBlockHeader(bytes);
    bytes.fill(0xff);
    expect(bytesToHex(serializeBlockHeader(header))).toBe(snapshot);

    header.prevBlock.fill(0);
    header.merkleRoot.fill(0);
    header.proofCommitment.fill(0);
    expect(bytesToHex(serializeBlockHeader(header))).not.toBe(snapshot);
    expect(bytesToHex(parseBlockHeader(hexToBytes(snapshot)).prevBlock)).toBe(snapshot.slice(8, 72));
  });
});

describe('blockHash and blockHashHex', () => {
  it('matches an independently computed double-SHA256 digest', () => {
    // Digest computed with Python hashlib for this fixed header.
    const header = sampleHeader();
    expect(bytesToHex(blockHash(header))).toBe(
      '9cffda5439f3d5f3217f8cd0d8c7dfec32a0c92df395ceb9cf8804b5edf22591',
    );
    expect(blockHashHex(header)).toBe(
      '9125f2edb50488cfb9ce95f32dc9a032ecdfc7d8d08c7f21f3d5f33954daff9c',
    );
  });

  it('returns a fresh digest on each call', () => {
    const header = sampleHeader();
    const first = blockHash(header);
    first.fill(0);
    expect(bytesToHex(blockHash(header))).toBe(
      '9cffda5439f3d5f3217f8cd0d8c7dfec32a0c92df395ceb9cf8804b5edf22591',
    );
  });

  it('validates the header before hashing', () => {
    expect(() =>
      blockHash({ ...sampleHeader(), merkleRoot: new Uint8Array(16) }),
    ).toThrow(RangeError);
    expect(() => blockHashHex({ ...sampleHeader(), version: 0x80000000 })).toThrow(RangeError);
  });
});
