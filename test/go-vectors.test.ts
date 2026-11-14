import { describe, expect, it } from 'vitest';
import vectors from '../vectors/pearl-go.json' with { type: 'json' };
import {
  scriptFromVectors,
  bytesToHex,
  hexToBytes,
  networkNamed,
} from './vector-helpers.js';
import {
  createPsbt,
  deriveAccountFromSeed,
  encodeAddress,
  fromOutputScript,
  networks,
  parsePsbt,
  parseTransaction,
  serializeTransaction,
  toOutputScript,
  transactionId,
  witnessTransactionId,
} from '../src/index.js';

describe('Pearl Go compatibility vectors', () => {
  it('matches chaincfg network parameters', () => {
    for (const expected of vectors.networks) {
      expect(networkNamed(expected.name)).toMatchObject(expected);
    }
    expect(vectors.networks).toHaveLength(Object.keys(networks).length);
  });

  it('matches Go Taproot and P2MR addresses and scripts', () => {
    for (const expected of vectors.addresses) {
      const network = networkNamed(expected.network);
      const version = expected.kind === 'p2tr' ? 1 : 2;
      const program = hexToBytes(expected.program);
      expect(encodeAddress({ version, program }, network)).toBe(expected.address);
      expect(bytesToHex(toOutputScript(expected.address, network))).toBe(expected.script);
      expect(fromOutputScript(hexToBytes(expected.script), network)).toBe(expected.address);
    }
  });

  it('matches Go BIP86 account and child derivation', () => {
    const account = deriveAccountFromSeed(
      hexToBytes(vectors.bip86.seed),
      networkNamed(vectors.bip86.network),
    );
    expect(account.path).toBe(vectors.bip86.accountPath);
    expect(account.extendedPublicKey()).toBe(vectors.bip86.accountXpub);
    for (const expected of vectors.bip86.children) {
      const [change, index] = expected.path.split('/').slice(-2).map(Number);
      if (change === undefined || index === undefined) {
        throw new Error(`invalid child vector path: ${expected.path}`);
      }
      expect(bytesToHex(account.derivePublicKey(index, change === 1))).toBe(
        expected.internalPubKey,
      );
      expect(account.deriveAddress(index, change === 1)).toBe(expected.address);
    }
  });

  it('matches Go transaction serialization, txids, and wtxids', () => {
    for (const expected of vectors.transactions) {
      const tx = parseTransaction(expected.hex);
      expect(serializeTransaction(tx)).toBe(expected.hex);
      expect(serializeTransaction(tx, false)).toBe(expected.noWitnessHex);
      expect(transactionId(tx)).toBe(expected.txid);
      expect(witnessTransactionId(tx)).toBe(expected.wtxid);
    }
  });

  it('matches Go PSBT serialization including witness UTXO data', () => {
    const parsed = parsePsbt(vectors.psbt.base64);
    expect(parsed.toBase64()).toBe(vectors.psbt.base64);

    const tx = parseTransaction(vectors.psbt.unsignedTxHex);
    const created = createPsbt(tx);
    created.updateInput(0, {
      witnessUtxo: {
        script: scriptFromVectors('mainnet', 'p2tr'),
        value: 200000000n,
      },
    });
    expect(created.toBase64()).toBe(vectors.psbt.base64);
  });

  it('matches Go BIP341 signature hashes', () => {
    const tx = parseTransaction(vectors.psbt.unsignedTxHex);
    const scripts = [scriptFromVectors('mainnet', 'p2tr')];
    for (const expected of vectors.sighashes) {
      expect(bytesToHex(tx.hashForWitnessV1(0, scripts, [200000000n], expected.hashType))).toBe(
        expected.hash,
      );
    }
  });
});
