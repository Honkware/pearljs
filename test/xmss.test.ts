// XMSS against Pearl's own library: key pairs, signatures and verification
// must match byte for byte, since both sides are deterministic.

import { describe, expect, it } from 'vitest';
import { XMSS_MAX_SIGNATURES, xmssKeygen, xmssSign, xmssVerify } from '../src/index.js';
import vectors from '../vectors/pearl-go.json' with { type: 'json' };
import { bytesToHex, hexToBytes } from './vector-helpers.js';

function keyVector(name: string) {
  const key = vectors.xmss.keys.find((item) => item.name === name);
  if (key === undefined) throw new Error(`missing XMSS key ${name}`);
  return key;
}

describe('XMSS', () => {
  it('derives the same key pairs as Pearl', () => {
    for (const expected of vectors.xmss.keys) {
      const pair = xmssKeygen(hexToBytes(expected.privateSeed), hexToBytes(expected.publicSeed));
      expect(bytesToHex(pair.publicKey)).toBe(expected.publicKey);
      expect(bytesToHex(pair.secretKey)).toBe(expected.secretKey);
    }
  });

  it('produces the same signatures as Pearl for indices 0 to 30', () => {
    for (const expected of vectors.xmss.signatures.filter((item) => item.valid)) {
      const key = keyVector(expected.key);
      const signature = xmssSign(hexToBytes(key.secretKey), expected.msgUid, hexToBytes(expected.message));
      expect(bytesToHex(signature)).toBe(expected.signature);
    }
  });

  it('agrees with Pearl on which signatures verify', () => {
    for (const expected of vectors.xmss.signatures) {
      const key = keyVector(expected.key);
      expect(
        xmssVerify(hexToBytes(key.publicKey), hexToBytes(expected.message), hexToBytes(expected.signature)),
      ).toBe(expected.valid);
    }
  });

  it('refuses index 31, where Pearl returns a signature that does not verify', () => {
    const broken = vectors.xmss.signatures.find((item) => item.msgUid === 31)!;
    expect(broken.valid).toBe(false);
    expect(XMSS_MAX_SIGNATURES).toBe(31);
    const key = keyVector(broken.key);
    expect(() => xmssSign(hexToBytes(key.secretKey), 31, hexToBytes(broken.message))).toThrow('0 to 30');
    expect(() => xmssSign(hexToBytes(key.secretKey), -1, hexToBytes(broken.message))).toThrow('0 to 30');
  });

  it('rejects a changed message or a flipped signature bit', () => {
    const expected = vectors.xmss.signatures.find((item) => item.key === 'a' && item.msgUid === 7)!;
    const publicKey = hexToBytes(keyVector('a').publicKey);
    const message = hexToBytes(expected.message);
    const signature = hexToBytes(expected.signature);
    const otherMessage = Uint8Array.from(message);
    otherMessage[31] = otherMessage[31]! ^ 1;
    expect(xmssVerify(publicKey, otherMessage, signature)).toBe(false);
    for (const at of [0, 4, 40, 2200, 2339]) {
      const flipped = Uint8Array.from(signature);
      flipped[at] = flipped[at]! ^ 0x80;
      expect(xmssVerify(publicKey, message, flipped)).toBe(false);
    }
    expect(xmssVerify(publicKey, message, signature.slice(1))).toBe(false);
  });

  it('answers false for arguments that are not bytes', () => {
    const expected = vectors.xmss.signatures.find((item) => item.valid)!;
    const args = [
      hexToBytes(keyVector(expected.key).publicKey),
      hexToBytes(expected.message),
      hexToBytes(expected.signature),
    ] as const;
    expect(xmssVerify(...args)).toBe(true);
    for (const bad of [undefined, null, expected.signature, 7, Array.from(args[2])]) {
      for (let position = 0; position < 3; position += 1) {
        const mixed = args.map((arg, i) => (i === position ? bad : arg)) as unknown as typeof args;
        expect(xmssVerify(...mixed)).toBe(false);
      }
    }
  });

  it('checks seed and message lengths', () => {
    const key = keyVector('b');
    expect(() => xmssKeygen(new Uint8Array(32), hexToBytes(key.publicSeed))).toThrow('private seed must be 64 bytes');
    expect(() => xmssSign(hexToBytes(key.secretKey), 0, new Uint8Array(31))).toThrow('message must be 32 bytes');
  });
});
