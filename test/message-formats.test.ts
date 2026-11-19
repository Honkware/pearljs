// BIP-322 simple signatures and pearld's legacy compact signatures, against
// Pearl's Go code (vectors.messageFormats) and BIP-322's own test vectors.
// Legacy signatures are deterministic in btcec and tiny-secp256k1 alike, so
// those are compared byte for byte; Schnorr ones are checked by verifying.

import { address as btcAddress } from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { describe, expect, it } from 'vitest';
import {
  bip322MessageHash,
  bip322Transactions,
  customNetwork,
  decodeWif,
  deriveSigningAccountFromSeed,
  keyPathAddress,
  legacyMessageHash,
  messageSignatureFormat,
  networks,
  signMessage,
  verifyMessage,
} from '../src/index.js';
import { taggedHash } from '../src/script.js';
import vectors from '../vectors/pearl-go.json' with { type: 'json' };
import bip322 from './fixtures/bip322-vectors.json' with { type: 'json' };
import { bytesToHex, hexToBytes } from './vector-helpers.js';

const account = deriveSigningAccountFromSeed(hexToBytes(vectors.bip86.seed), networks.mainnet);
const address = account.deriveAddress(0);
const scriptOf = (addr: string): Uint8Array => {
  const program = btcAddress.fromBech32(addr);
  return Uint8Array.from([program.version === 0 ? 0 : 0x50 + program.version, program.data.length, ...program.data]);
};
const bitcoin = customNetwork(networks.mainnet, { bech32Hrp: 'bc', wif: 0x80 });

function unbase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

describe('BIP-322 simple signatures', () => {
  it('signs for the address Pearl signed for', () => {
    expect(vectors.messageFormats.every((item) => item.address === address && item.path.endsWith('/0/0'))).toBe(true);
  });

  for (const expected of vectors.messageFormats) {
    it(`builds Pearl's transactions and sighash and verifies Pearl's signature for ${expected.name}`, () => {
      expect(bytesToHex(bip322MessageHash(expected.message))).toBe(expected.bip322MessageHash);
      const script = scriptOf(address);
      const { toSpend, toSign } = bip322Transactions(script, expected.message);
      expect(toSpend.getId()).toBe(expected.bip322ToSpendTxid);
      expect(bytesToHex(toSign.toBuffer())).toBe(expected.bip322ToSignHex);
      expect(bytesToHex(toSign.hashForWitnessV1(0, [script], [0n], 0))).toBe(expected.bip322Sighash);

      expect(expected.bip322Valid).toBe(true);
      expect(verifyMessage(address, expected.bip322Signature, expected.message, networks.mainnet, { format: 'bip322' })).toBe(true);
      expect(messageSignatureFormat(address, expected.bip322Signature, expected.message, networks.mainnet)).toBe('bip322');
      // Oyster's verifier refuses it, and so does the default format here.
      expect(expected.oysterAccepts).toBe(false);
      expect(verifyMessage(address, expected.bip322Signature, expected.message, networks.mainnet)).toBe(false);

      const ours = account.signMessage(expected.message, { index: 0, format: 'bip322' });
      const witness = unbase64(ours);
      expect([witness[0], witness[1]]).toEqual([1, 64]);
      expect(ecc.verifySchnorr(hexToBytes(expected.bip322Sighash), script.subarray(2), witness.subarray(2))).toBe(true);
    });
  }

  it('signs messages longer than the 80 bytes Oyster can carry', () => {
    const long = vectors.messageFormats.find((item) => item.name === 'three-hundred-bytes')!;
    expect(long.message.length).toBe(300);
    const signature = account.signMessage(long.message, { index: 0, format: 'bip322' });
    expect(verifyMessage(address, signature, long.message, networks.mainnet, { format: 'bip322' })).toBe(true);
    expect(() => account.signMessage(long.message, { index: 0 })).toThrow('more than the 80 Oyster can sign');
  });

  for (const expected of bip322.txHashes) {
    it(`matches BIP-322's hashes for ${JSON.stringify(expected.message)}`, () => {
      expect(bytesToHex(bip322MessageHash(expected.message))).toBe(expected.message_hash);
      const { toSpend, toSign } = bip322Transactions(scriptOf(expected.address), expected.message);
      expect(toSpend.getId()).toBe(expected.to_spend_tx_hash);
      expect(toSign.getId()).toBe(expected.to_sign_tx_hash);
    });
  }

  for (const expected of bip322.simple) {
    it(`verifies BIP-322's P2TR vector ${JSON.stringify(expected.message)} and signs for its key`, () => {
      const { privateKey } = decodeWif(expected.private_keys[0]!, bitcoin);
      expect(keyPathAddress(privateKey, bitcoin)).toBe(expected.address);
      for (const signature of expected.bip322_signatures) {
        expect(verifyMessage(expected.address, signature, expected.message, bitcoin, { format: 'bip322' })).toBe(true);
        expect(verifyMessage(expected.address, signature, `${expected.message}!`, bitcoin, { format: 'bip322' })).toBe(false);
      }
      const ours = signMessage(privateKey, expected.message, { format: 'bip322' });
      expect(verifyMessage(expected.address, ours, expected.message, bitcoin, { format: 'bip322' })).toBe(true);
      expect(verifyMessage(expected.address, `smp${ours}`, expected.message, bitcoin, { format: 'bip322' })).toBe(true);
    });
  }

  for (const expected of bip322.errors) {
    it(`refuses BIP-322's error case: ${expected.description}`, () => {
      expect(verifyMessage(expected.address, expected.signature, expected.message, bitcoin, { format: 'any' })).toBe(false);
    });
  }
});

describe('legacy compact signatures', () => {
  for (const expected of vectors.messageFormats) {
    it(`signs ${expected.name} byte for byte as pearld does and verifies its signatures`, () => {
      expect(bytesToHex(legacyMessageHash(expected.message))).toBe(expected.legacyHash);
      const { privateKey, compressed } = decodeWif(expected.legacyWif, networks.mainnet);
      expect(compressed).toBe(true);
      expect(signMessage(privateKey, expected.message, { format: 'legacy' })).toBe(expected.legacySignature);
      expect(account.signMessage(expected.message, { index: 0, format: 'legacy' })).toBe(expected.legacySignature);
      expect(bytesToHex(ecc.pointFromScalar(privateKey, true)!)).toBe(expected.legacyRecoveredKey);
      for (const signature of [expected.legacySignature, expected.legacyUncompressedSignature]) {
        expect(verifyMessage(address, signature, expected.message, networks.mainnet, { format: 'legacy' })).toBe(true);
        expect(messageSignatureFormat(address, signature, expected.message, networks.mainnet)).toBe('legacy');
        expect(verifyMessage(account.deriveAddress(1), signature, expected.message, networks.mainnet, { format: 'legacy' })).toBe(false);
        expect(verifyMessage(address, signature, `${expected.message}.`, networks.mainnet, { format: 'legacy' })).toBe(false);
      }
      // The header byte carries the compression flag: 31 to 34 compressed, 27 to 30 not.
      expect(unbase64(expected.legacySignature)[0]).toBeGreaterThanOrEqual(31);
      expect(unbase64(expected.legacyUncompressedSignature)[0]).toBeLessThanOrEqual(30);
    });
  }

  it('refuses header bytes ecdsa.RecoverCompact refuses', () => {
    const signature = unbase64(vectors.messageFormats[1]!.legacySignature);
    for (const header of [26, 35, 39, 0]) {
      const changed = btoa(String.fromCharCode(header, ...signature.subarray(1)));
      expect(verifyMessage(address, changed, vectors.messageFormats[1]!.message, networks.mainnet, { format: 'legacy' })).toBe(false);
    }
    expect(verifyMessage(address, btoa('short'), 'x', networks.mainnet, { format: 'legacy' })).toBe(false);
  });
});

describe('choosing a format', () => {
  it('tells the three formats apart and accepts any of them on request', () => {
    const message = 'I set mdl1qexampleexampleexampleexampleexample';
    for (const format of ['oyster', 'bip322', 'legacy'] as const) {
      const signature = account.signMessage(message, { index: 0, format });
      expect(messageSignatureFormat(address, signature, message, networks.mainnet)).toBe(format);
      expect(verifyMessage(address, signature, message, networks.mainnet, { format: 'any' })).toBe(true);
      for (const other of ['oyster', 'bip322', 'legacy'] as const) {
        expect(verifyMessage(address, signature, message, networks.mainnet, { format: other })).toBe(other === format);
      }
    }
    expect(messageSignatureFormat(address, account.signMessage('a', { index: 0 }), 'b', networks.mainnet)).toBeUndefined();
  });

  it('signs in Oyster format by default and refuses an unknown format', () => {
    const signature = account.signMessage('hello', { index: 0 });
    expect(messageSignatureFormat(address, signature, 'hello', networks.mainnet)).toBe('oyster');
    expect(() => account.signMessage('hello', { index: 0, format: 'bip137' as 'legacy' })).toThrow('unknown message format');
    expect(() => verifyMessage(address, signature, 'hello', networks.mainnet, { format: 'x' as 'any' })).toThrow(TypeError);
  });

  it('computes the BIP-322 hash with the BIP340 tag', () => {
    expect(bip322MessageHash('abc')).toEqual(taggedHash('BIP0322-signed-message', new TextEncoder().encode('abc')));
  });
});
