import { describe, expect, it } from 'vitest';
import { encodeAddress, toOutputScript } from '../src/address.js';
import { mainnet } from '../src/networks.js';
import { embed, MAX_EMBED_DATA_SIZE, p2mr, p2tr } from '../src/payments.js';

const hex = (u: Uint8Array) => Buffer.from(u).toString('hex');
const unhex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'));

// x-only serialization of the secp256k1 generator point.
const INTERNAL_KEY = unhex(
  '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
);

// Tweaked output key for INTERNAL_KEY with no script tree, cross-checked
// against an independent pure-math implementation of BIP341
// taproot_tweak_pubkey. Not derived only from this package.
const TWEAKED_KEY =
  'da4710964f7852695de2da025290e24af6d8c281de5a0b902b7135fd9fd74d21';

const MERKLE_ROOT = unhex(`0000000000000000000000000000000000000000000000000000000000000001`);

describe('p2tr', () => {
  it('builds a key-path P2TR output from an x-only internal key', () => {
    const p = p2tr({ internalPubkey: INTERNAL_KEY });
    expect(p.name).toBe('p2tr');
    expect(hex(p.output)).toBe(`5120${TWEAKED_KEY}`);
    expect(hex(p.internalPubkey)).toBe(hex(INTERNAL_KEY));
  });

  it('produces the output that toOutputScript builds for the tweaked key', () => {
    const p = p2tr({ internalPubkey: INTERNAL_KEY });
    const address = encodeAddress(
      { version: 1, program: unhex(TWEAKED_KEY) },
      mainnet,
    );
    expect(hex(toOutputScript(address, mainnet))).toBe(hex(p.output));
  });

  it('rejects internal keys that are not 32 bytes', () => {
    expect(() => p2tr({ internalPubkey: new Uint8Array(31) })).toThrow(
      /32 bytes/,
    );
    expect(() => p2tr({ internalPubkey: new Uint8Array(33) })).toThrow(
      /32 bytes/,
    );
  });

  it('rejects an x-only key that does not lift to a curve point', () => {
    // 0xffff... is >= the field prime, so it is not a valid x coordinate.
    expect(() =>
      p2tr({ internalPubkey: new Uint8Array(32).fill(0xff) }),
    ).toThrow();
  });

  it('copies caller input and returned bytes', () => {
    const key = Uint8Array.from(INTERNAL_KEY);
    const p = p2tr({ internalPubkey: key });
    key.fill(0);
    expect(hex(p.internalPubkey)).toBe(hex(INTERNAL_KEY));
    p.output.fill(0);
    const again = p2tr({ internalPubkey: INTERNAL_KEY });
    expect(hex(again.output)).toBe(`5120${TWEAKED_KEY}`);
  });
});

describe('p2mr', () => {
  it('builds an OP_2 <merkle root> output', () => {
    const p = p2mr({ merkleRoot: MERKLE_ROOT });
    expect(p.name).toBe('p2mr');
    expect(hex(p.output)).toBe(`5220${hex(MERKLE_ROOT)}`);
    expect(hex(p.merkleRoot)).toBe(hex(MERKLE_ROOT));
  });

  it('rejects merkle roots that are not 32 bytes', () => {
    expect(() => p2mr({ merkleRoot: new Uint8Array(31) })).toThrow(/32 bytes/);
    expect(() => p2mr({ merkleRoot: new Uint8Array(33) })).toThrow(/32 bytes/);
  });

  it('copies caller input', () => {
    const root = Uint8Array.from(MERKLE_ROOT);
    const p = p2mr({ merkleRoot: root });
    root.fill(0);
    expect(hex(p.merkleRoot)).toBe(hex(MERKLE_ROOT));
  });
});

describe('embed', () => {
  it('caps data at 80 bytes', () => {
    expect(MAX_EMBED_DATA_SIZE).toBe(80);
    expect(() => embed({ data: new Uint8Array(81) })).toThrow(/80/);
    expect(() => embed({ data: new Uint8Array(80) })).not.toThrow();
  });

  it('pushes empty data as OP_RETURN OP_0, matching txscript NullDataScript', () => {
    const p = embed({ data: new Uint8Array(0) });
    expect(p.name).toBe('embed');
    expect(hex(p.output)).toBe('6a00');
  });

  it('uses Pearl small-integer opcodes for one-byte numeric data', () => {
    expect(hex(embed({ data: unhex('00') }).output)).toBe('6a00');
    expect(hex(embed({ data: unhex('01') }).output)).toBe('6a51');
    expect(hex(embed({ data: unhex('10') }).output)).toBe('6a60');
    expect(hex(embed({ data: unhex('81') }).output)).toBe('6a4f');
    expect(hex(embed({ data: unhex('11') }).output)).toBe('6a0111');
  });

  it('uses a direct push for up to 75 bytes', () => {
    expect(hex(embed({ data: unhex('deadbeef') }).output)).toBe('6a04deadbeef');
    const data = new Uint8Array(75).fill(0xaa);
    expect(hex(embed({ data }).output)).toBe(`6a4b${hex(data)}`);
  });

  it('uses OP_PUSHDATA1 from 76 bytes up', () => {
    const data76 = new Uint8Array(76).fill(0xbb);
    expect(hex(embed({ data: data76 }).output)).toBe(`6a4c4c${hex(data76)}`);
    const data80 = new Uint8Array(80).fill(0xcc);
    expect(hex(embed({ data: data80 }).output)).toBe(`6a4c50${hex(data80)}`);
  });

  it('is push-only after OP_RETURN', () => {
    for (const len of [0, 1, 75, 76, 80]) {
      const { output } = embed({ data: new Uint8Array(len).fill(0x42) });
      expect(output[0]).toBe(0x6a);
      // Walk the script: each element must be a push of exactly its
      // announced length, and the pushes must consume the script exactly.
      let i = 1;
      while (i < output.length) {
        const op = output[i] as number;
        expect(op <= 0x4c).toBe(true);
        if (op === 0x4c) {
          const pushed = output[i + 1] as number;
          i += 2 + pushed;
        } else {
          i += 1 + op; // OP_0 is 0, direct pushes announce their length
        }
      }
      expect(i).toBe(output.length);
    }
  });

  it('copies caller input', () => {
    const data = unhex('deadbeef');
    const p = embed({ data });
    data.fill(0);
    expect(hex(p.data)).toBe('deadbeef');
    expect(hex(p.output)).toBe('6a04deadbeef');
  });
});
