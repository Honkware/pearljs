// Message signing against Oyster's signmessage and verifymessage. Schnorr
// nonces differ between btcec and tiny-secp256k1, so pearljs signatures are
// checked by verifying them, not by comparing bytes.

import { BIP32Factory } from 'bip32';
import * as ecc from 'tiny-secp256k1';
import { describe, expect, it } from 'vitest';
import {
  deriveSigningAccountFromSeed,
  encodeAddress,
  MAX_MESSAGE_LENGTH,
  messageSignatureFormat,
  networks,
  signMessage,
  verifyMessage,
} from '../src/index.js';
import vectors from '../vectors/pearl-go.json' with { type: 'json' };
import { hexToBytes } from './vector-helpers.js';

const account = deriveSigningAccountFromSeed(hexToBytes(vectors.bip86.seed), networks.mainnet);
const address = account.deriveAddress(0);

function base64(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes));
}

describe('message signing', () => {
  it('signs from the same address Oyster used', () => {
    expect(vectors.messages.every((item) => item.path.endsWith('/0/0'))).toBe(true);
    expect(vectors.messages[0]!.address).toBe(address);
  });

  for (const expected of vectors.messages) {
    it(`agrees with Oyster on ${expected.name}`, () => {
      if (expected.signError !== '') {
        expect(() => account.signMessage(expected.message, { index: 0 })).toThrow(
          `more than the ${MAX_MESSAGE_LENGTH} Oyster can sign`,
        );
        return;
      }
      expect(verifyMessage(expected.address, expected.signature, expected.message, networks.mainnet)).toBe(
        expected.valid,
      );
      if (expected.address === address) {
        const signature = account.signMessage(expected.message, { index: 0 });
        expect(verifyMessage(address, signature, expected.message, networks.mainnet)).toBe(true);
      }
    });
  }

  for (const expected of vectors.messageSighashes) {
    it(`answers ${expected.pearljsValid} for ${expected.name}, where Pearl answers ${expected.pearlValid} and anySighashType follows Pearl`, () => {
      const format = expected.format as 'oyster' | 'bip322';
      expect(verifyMessage(expected.address, expected.signature, expected.message, networks.mainnet, { format })).toBe(expected.pearljsValid);
      expect(verifyMessage(expected.address, expected.signature, expected.message, networks.mainnet, { format: 'any' })).toBe(expected.pearljsValid);
      expect(messageSignatureFormat(expected.address, expected.signature, expected.message, networks.mainnet)).toBe(expected.pearljsValid ? format : undefined);
      expect(verifyMessage(expected.address, expected.signature, expected.message, networks.mainnet, { format, anySighashType: true })).toBe(expected.pearlValid);
    });
  }

  it('gives the empty message and a lone NUL one Oyster-format signature and two BIP-322 ones', () => {
    expect(verifyMessage(address, account.signMessage('', { index: 0 }), '\u0000', networks.mainnet)).toBe(true);
    expect(verifyMessage(address, account.signMessage('', { index: 0, format: 'bip322' }), '\u0000', networks.mainnet, { format: 'bip322' })).toBe(false);
    expect(verifyMessage(address, account.signMessage('\u0000', { index: 0, format: 'bip322' }), '', networks.mainnet, { format: 'bip322' })).toBe(false);
  });

  it('produces a one-item witness with a 64-byte signature, so always SIGHASH_DEFAULT', () => {
    for (const format of ['oyster', 'bip322'] as const) {
      const signature = account.signMessage('Hello, Pearl', { index: 0, format });
      const bytes = Uint8Array.from(atob(signature), (char) => char.charCodeAt(0));
      expect(bytes).toHaveLength(66);
      expect([bytes[0], bytes[1]]).toEqual([1, 64]);
    }
  });

  it('rejects a changed signature', () => {
    const signature = account.signMessage('Hello, Pearl', { index: 0 });
    const bytes = Uint8Array.from(atob(signature), (char) => char.charCodeAt(0));
    bytes[10] = bytes[10]! ^ 1;
    expect(verifyMessage(address, base64([...bytes]), 'Hello, Pearl', networks.mainnet)).toBe(false);
  });

  it('honours the sighash byte of a 65-byte signature', () => {
    const plain = Uint8Array.from(
      atob(vectors.messages.find((item) => item.name === 'ascii')!.signature),
      (char) => char.charCodeAt(0),
    );
    // A DEFAULT signature with 0x01 appended signs a different hash, so it
    // must fail; this checks the hash type is honoured, not ignored.
    expect(verifyMessage(address, base64([1, 65, ...plain.slice(2), 0x01]), 'Hello, Pearl', networks.mainnet)).toBe(
      false,
    );
  });

  it('answers false for addresses that are not P2TR on the network and for script-path witnesses', () => {
    const p2mrAddress = vectors.addresses.find((item) => item.network === 'mainnet' && item.kind === 'p2mr')!.address;
    const signature = vectors.messages[1]!.signature;
    expect(verifyMessage(p2mrAddress, signature, 'Hello, Pearl', networks.mainnet)).toBe(false);
    const twoItems = base64([2, 1, 0x51, 1, 0xc0]);
    expect(verifyMessage(address, twoItems, 'Hello, Pearl', networks.mainnet)).toBe(false);
    const good = account.signMessage('Hello, Pearl', { index: 0 });
    expect(verifyMessage(address, good, 'Hello, Pearl', networks.mainnet)).toBe(true);
    expect(verifyMessage(address, good, 'Hello, Pearl', networks.regtest)).toBe(false);
    expect(verifyMessage('not an address', good, 'Hello, Pearl', networks.mainnet)).toBe(false);
    expect(verifyMessage(address, good, 'x'.repeat(81), networks.mainnet)).toBe(false);
  });

  it('answers false for malformed signatures', () => {
    expect(verifyMessage(address, 'not base64!', 'x', networks.mainnet)).toBe(false);
    expect(verifyMessage(address, base64([1, 64, 1, 2]), 'x', networks.mainnet)).toBe(false);
    expect(verifyMessage(address, base64([0]), 'x', networks.mainnet)).toBe(false);
    expect(verifyMessage(address, base64([1, 3, 1, 2, 3]), 'x', networks.mainnet)).toBe(false);
  });

  it('signs with a raw private key for that key\'s BIP86 address', () => {
    const privateKey = BIP32Factory(ecc)
      .fromSeed(hexToBytes(vectors.bip86.seed), {
        wif: networks.mainnet.wif,
        bip32: { public: networks.mainnet.hdPublicKeyId, private: networks.mainnet.hdPrivateKeyId },
      })
      .derivePath(`${vectors.bip86.accountPath}/0/1`).privateKey!;
    const signature = signMessage(privateKey, 'raw key');
    expect(verifyMessage(account.deriveAddress(1), signature, 'raw key', networks.mainnet)).toBe(true);
    expect(verifyMessage(account.deriveAddress(0), signature, 'raw key', networks.mainnet)).toBe(false);
    expect(() => signMessage(new Uint8Array(32), 'x')).toThrow('invalid private key');
  });

  it('answers false for an address whose program is not a point on the curve', () => {
    // Oyster's script engine fails to parse the key and reports the signature invalid.
    const offCurve = Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 5 : 0));
    expect(ecc.isXOnlyPoint(offCurve)).toBe(false);
    const signature = account.signMessage('Hello, Pearl', { index: 0 });
    expect(verifyMessage(encodeAddress({ version: 1, program: offCurve }, networks.mainnet), signature, 'Hello, Pearl', networks.mainnet)).toBe(
      false,
    );
  });

  it('does not accept lengths written in more bytes than they need, as wire.ReadVarInt does not', () => {
    const signature = Uint8Array.from(atob(account.signMessage('hello', { index: 0 })), (char) => char.charCodeAt(0));
    expect(verifyMessage(address, base64([...signature]), 'hello', networks.mainnet)).toBe(true);
    const variants = [
      [0xfd, 1, 0, ...signature.slice(1)],
      [0xfe, 1, 0, 0, 0, ...signature.slice(1)],
      [0xff, 1, 0, 0, 0, 0, 0, 0, 0, ...signature.slice(1)],
      [1, 0xfd, 0x40, 0, ...signature.slice(2)],
      [1, 0xfe, 0x40, 0, 0, 0, ...signature.slice(2)],
      [1, 0xff, 0x40, 0, 0, 0, 0, 0, 0, 0, ...signature.slice(2)],
    ];
    for (const bytes of variants) {
      expect(verifyMessage(address, base64(bytes), 'hello', networks.mainnet)).toBe(false);
    }
    // 0xfd is the first length that needs the three-byte form.
    expect(verifyMessage(address, base64([1, 0xfd, 0xfd, 0, ...new Array<number>(253).fill(0)]), 'hello', networks.mainnet)).toBe(
      false,
    );
    expect(verifyMessage(address, base64([1, 0xfd, 0xfc, 0, ...new Array<number>(252).fill(0)]), 'hello', networks.mainnet)).toBe(false);
  });

  it('refuses a message with a lone surrogate instead of signing U+FFFD for it', () => {
    for (const message of ['a\ud800', 'a\udfff', '\udc00\ud800']) {
      expect(() => account.signMessage(message, { index: 0 })).toThrow('lone surrogate');
      const signature = account.signMessage('a\ufffd', { index: 0 });
      expect(verifyMessage(address, signature, message, networks.mainnet)).toBe(false);
    }
    // A surrogate pair is an ordinary character.
    const signature = account.signMessage('a\ud83d\ude00', { index: 0 });
    expect(verifyMessage(address, signature, 'a😀', networks.mainnet)).toBe(true);
  });

  it('rejects arguments of the wrong type with clear errors', () => {
    const key = new Uint8Array(32).fill(1);
    expect(() => signMessage(key, undefined as unknown as string)).toThrow('message must be a string');
    expect(() => signMessage('01'.repeat(32) as unknown as Uint8Array, 'x')).toThrow('invalid private key');
    expect(() => signMessage(undefined as unknown as Uint8Array, 'x')).toThrow('invalid private key');
    expect(() => verifyMessage(address, undefined as unknown as string, 'x', networks.mainnet)).toThrow(
      'signature must be a base64 string',
    );
    expect(() => verifyMessage(address, 'AA==', 5 as unknown as string, networks.mainnet)).toThrow(
      'message must be a string',
    );
    expect(() => verifyMessage(5 as unknown as string, 'AA==', 'x', networks.mainnet)).toThrow(TypeError);
    expect(() => verifyMessage(address, 'AA==', 'x', undefined as unknown as typeof networks.mainnet)).toThrow(TypeError);
  });

  it('mixes fresh randomness into every signature unless auxRand is given', () => {
    const key = new Uint8Array(32).fill(1);
    const first = signMessage(key, 'same message');
    const second = signMessage(key, 'same message');
    expect(first).not.toBe(second);
    const keyAddress = account.deriveAddress(0);
    expect(account.signMessage('m', { index: 0 })).not.toBe(account.signMessage('m', { index: 0 }));
    expect(verifyMessage(keyAddress, account.signMessage('m', { index: 0 }), 'm', networks.mainnet)).toBe(true);

    const auxRand = new Uint8Array(32).fill(9);
    expect(signMessage(key, 'same message', { auxRand })).toBe(signMessage(key, 'same message', { auxRand }));
    expect(account.signMessage('m', { index: 0, auxRand })).toBe(account.signMessage('m', { index: 0, auxRand }));
    expect(signMessage(key, 'same message', { auxRand })).not.toBe(
      signMessage(key, 'same message', { auxRand: new Uint8Array(32) }),
    );
    expect(() => signMessage(key, 'x', { auxRand: new Uint8Array(31) })).toThrow('auxRand must be 32 bytes');
    // The caller's key is not the one that gets wiped.
    expect(key.every((byte) => byte === 1)).toBe(true);
  });
});
