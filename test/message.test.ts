// Message signing against Oyster's signmessage and verifymessage. Schnorr
// nonces differ between btcec and tiny-secp256k1, so pearljs signatures are
// checked by verifying them, not by comparing bytes.

import { BIP32Factory } from 'bip32';
import * as ecc from 'tiny-secp256k1';
import { describe, expect, it } from 'vitest';
import {
  deriveSigningAccountFromSeed,
  MAX_MESSAGE_LENGTH,
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

  it('produces a one-item witness with a 64-byte signature', () => {
    const signature = account.signMessage('Hello, Pearl', { index: 0 });
    const bytes = Uint8Array.from(atob(signature), (char) => char.charCodeAt(0));
    expect(bytes).toHaveLength(66);
    expect([bytes[0], bytes[1]]).toEqual([1, 64]);
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

  it('refuses addresses that are not P2TR and script-path witnesses', () => {
    const p2mrAddress = vectors.addresses.find((item) => item.network === 'mainnet' && item.kind === 'p2mr')!.address;
    const signature = vectors.messages[1]!.signature;
    expect(() => verifyMessage(p2mrAddress, signature, 'Hello, Pearl', networks.mainnet)).toThrow(
      'only Taproot addresses',
    );
    const twoItems = base64([2, 1, 0x51, 1, 0xc0]);
    expect(() => verifyMessage(address, twoItems, 'Hello, Pearl', networks.mainnet)).toThrow('script-path');
  });

  it('rejects malformed signatures', () => {
    expect(() => verifyMessage(address, 'not base64!', 'x', networks.mainnet)).toThrow('base64');
    expect(() => verifyMessage(address, base64([1, 64, 1, 2]), 'x', networks.mainnet)).toThrow('ends early');
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
});
