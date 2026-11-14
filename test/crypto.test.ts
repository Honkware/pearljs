// Hash helpers against published constants and Pearl's own data: the BIP32
// master fingerprint from the Go signing vectors and a Go transaction's txid.

import { BIP32Factory } from 'bip32';
import * as ecc from 'tiny-secp256k1';
import { describe, expect, it } from 'vitest';
import { hash160, hash256, networks, sha256 } from '../src/index.js';
import vectors from '../vectors/pearl-go.json' with { type: 'json' };
import { bytesToHex, hexToBytes } from './vector-helpers.js';

describe('hash helpers', () => {
  it('match the published values for empty input', () => {
    const empty = new Uint8Array(0);
    expect(bytesToHex(sha256(empty))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(bytesToHex(hash256(empty))).toBe('5df6e0e2761359d30a8275058e299fcc0381534545f55cf43e41983f5d4c9456');
    expect(bytesToHex(hash160(empty))).toBe('b472a266d0bd89c13706a4132ccfb16f7c3b9fcb');
  });

  it('hash160 gives the master fingerprint Pearl records', () => {
    const master = BIP32Factory(ecc).fromSeed(hexToBytes(vectors.bip86.seed), {
      wif: networks.mainnet.wif,
      bip32: { public: networks.mainnet.hdPublicKeyId, private: networks.mainnet.hdPrivateKeyId },
    });
    expect(bytesToHex(hash160(master.publicKey).slice(0, 4))).toBe(vectors.signing[0]!.masterFingerprint);
  });

  it('hash256 of a transaction without witnesses is its txid', () => {
    const expected = vectors.transactions.find((item) => item.name === 'witness')!;
    const txid = bytesToHex(hash256(hexToBytes(expected.noWitnessHex)).reverse());
    expect(txid).toBe(expected.txid);
  });
});
