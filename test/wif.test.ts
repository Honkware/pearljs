// WIF private keys against btcutil.NewWIF and DecodeWIF, and the address
// Oyster's importprivkey gives an imported key.

import { describe, expect, it } from 'vitest';
import { decodeWif, encodeWif, keyPathAddress, networks, signMessage, verifyMessage } from '../src/index.js';
import vectors from '../vectors/pearl-go.json' with { type: 'json' };
import { bytesToHex, hexToBytes, networkNamed } from './vector-helpers.js';

describe('WIF private keys', () => {
  for (const expected of vectors.wif) {
    const label = `${expected.network} ${expected.privateKey.slice(0, 8)} ${expected.compressed ? 'compressed' : 'uncompressed'}`;
    it(`matches Pearl for ${label}`, () => {
      const network = networkNamed(expected.network);
      const privateKey = hexToBytes(expected.privateKey);
      expect(encodeWif(privateKey, network, expected.compressed)).toBe(expected.wif);
      const decoded = decodeWif(expected.wif, network);
      expect(bytesToHex(decoded.privateKey)).toBe(expected.privateKey);
      expect(decoded.compressed).toBe(expected.compressed);
      expect(keyPathAddress(privateKey, network)).toBe(expected.address);
    });
  }

  for (const expected of vectors.badWif) {
    it(`rejects ${expected.name} with Pearl's error`, () => {
      expect(() => decodeWif(expected.wif, networks.mainnet)).toThrow(expected.error);
    });
  }

  it('rejects a WIF with an extra leading 1, which decodes to an extra zero byte', () => {
    // Checked against btcutil.DecodeWIF, which returns "malformed private key".
    expect(() => decodeWif(`1${vectors.wif[0]!.wif}`, networks.mainnet)).toThrow('malformed private key');
  });

  it('refuses a key for another network, as importprivkey does', () => {
    const testnetWif = vectors.wif.find((item) => item.network === 'testnet')!.wif;
    expect(() => decodeWif(testnetWif, networks.mainnet)).toThrow('not intended for mainnet');
    // testnet, testnet2 and regtest share the WIF byte 0xef.
    expect(() => decodeWif(testnetWif, networks.regtest)).not.toThrow();
  });

  it('signs a message for an imported key that verifies at its address', () => {
    const imported = vectors.wif.find((item) => item.network === 'mainnet' && item.compressed)!;
    const { privateKey } = decodeWif(imported.wif, networks.mainnet);
    const signature = signMessage(privateKey, 'imported key');
    expect(verifyMessage(keyPathAddress(privateKey, networks.mainnet), signature, 'imported key', networks.mainnet)).toBe(true);
  });

  it('refuses to encode an invalid private key', () => {
    expect(() => encodeWif(new Uint8Array(32), networks.mainnet)).toThrow('invalid private key');
  });
});
