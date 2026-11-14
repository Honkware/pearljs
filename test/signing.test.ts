import * as ecc from 'tiny-secp256k1';
import { describe, expect, it } from 'vitest';
import {
  createPsbt,
  deriveSigningAccountFromSeed,
  finalizePsbt,
  networks,
  p2tr,
  parsePsbt,
  parseTransaction,
  serializeTransaction,
  Transaction,
  transactionId,
} from '../src/index.js';
import vectors from '../vectors/pearl-go.json' with { type: 'json' };
import { bytesToHex, hexToBytes } from './vector-helpers.js';

const seed = hexToBytes(vectors.bip86.seed);

function preparedVector(name: string) {
  const vector = vectors.signing.find((item) => item.name === name);
  if (vector === undefined) throw new Error(`missing signing vector ${name}`);
  return vector;
}

describe('BIP86 signing accounts', () => {
  it('keeps the watch-only account neutered', () => {
    const account = deriveSigningAccountFromSeed(seed, networks.mainnet);
    expect(account.watchOnlyAccount().node.isNeutered()).toBe(true);
    expect(account.watchOnlyAccount().node.privateKey).toBeUndefined();
    expect(account.path).toBe(vectors.bip86.accountPath);
    expect(account.deriveAddress(0)).toBe(
      account.watchOnlyAccount().deriveAddress(0),
    );
  });

  it('prepares, signs, finalizes, and extracts each Go vector', () => {
    for (const expected of vectors.signing) {
      const account = deriveSigningAccountFromSeed(seed, networks.mainnet);
      const psbt = createPsbt(parseTransaction(expected.unsignedTxHex));
      account.prepareInput(psbt, 0, {
        index: expected.index,
        change: expected.change,
        value: BigInt(expected.value),
        sighashType: expected.hashType,
      });
      expect(psbt.toBase64()).toBe(expected.preparedPsbt);
      const prepared = psbt.data.inputs[0];
      expect(prepared?.tapBip32Derivation?.[0]).toMatchObject({
        pubkey: hexToBytes(expected.internalPubKey),
        masterFingerprint: hexToBytes(expected.masterFingerprint),
        path: expected.path,
        leafHashes: [],
      });

      account.signInput(psbt, 0, {
        index: expected.index,
        change: expected.change,
      });
      const signature = psbt.data.inputs[0]?.tapKeySig;
      if (signature === undefined) throw new Error('missing Taproot signature');
      expect(signature.length).toBe(
        expected.hashType === Transaction.SIGHASH_DEFAULT ? 64 : 65,
      );
      if (expected.hashType !== Transaction.SIGHASH_DEFAULT) {
        expect(signature[64]).toBe(expected.hashType);
      }
      expect(
        ecc.verifySchnorr(
          hexToBytes(expected.sighash),
          hexToBytes(expected.tweakedPubKey),
          signature.subarray(0, 64),
        ),
      ).toBe(true);

      const finalTx = finalizePsbt(psbt);
      expect(serializeTransaction(finalTx, false)).toBe(expected.unsignedTxHex);
      expect(transactionId(finalTx)).toBe(expected.txid);
      expect(finalTx.ins[0]?.witness).toHaveLength(1);
      expect(bytesToHex(finalTx.ins[0]?.witness[0] ?? new Uint8Array())).toBe(
        bytesToHex(signature),
      );
    }
  });

  it('extracts Pearl Go finalized PSBTs without changing their signatures', () => {
    for (const expected of vectors.signing) {
      const tx = finalizePsbt(parsePsbt(expected.finalPsbt));
      expect(serializeTransaction(tx)).toBe(expected.finalTxHex);
      expect(transactionId(tx)).toBe(expected.txid);
    }
  });

  it('adds the internal key missing from Pearl-decorated inputs', () => {
    const expected = preparedVector('default');
    const account = deriveSigningAccountFromSeed(seed, networks.mainnet);
    const psbt = createPsbt(parseTransaction(expected.unsignedTxHex));
    psbt.updateInput(0, {
      witnessUtxo: {
        script: p2tr({ internalPubkey: hexToBytes(expected.internalPubKey) }).output,
        value: BigInt(expected.value),
      },
    });
    expect(psbt.data.inputs[0]?.tapInternalKey).toBeUndefined();
    account.signInput(psbt, 0, { index: expected.index });
    expect(bytesToHex(psbt.data.inputs[0]?.tapInternalKey ?? new Uint8Array())).toBe(
      expected.internalPubKey,
    );
    expect(psbt.data.inputs[0]?.tapKeySig).toHaveLength(64);
  });

  it('rejects a witness UTXO belonging to a different child', () => {
    const expected = preparedVector('default');
    const account = deriveSigningAccountFromSeed(seed, networks.mainnet);
    const psbt = createPsbt(parseTransaction(expected.unsignedTxHex));
    account.prepareInput(psbt, 0, {
      index: expected.index,
      value: BigInt(expected.value),
    });
    expect(() => account.signInput(psbt, 0, { index: 1 })).toThrow(
      'does not match the account child',
    );
  });

  it('rejects script-path inputs and unsupported sighashes', () => {
    const expected = preparedVector('default');
    const account = deriveSigningAccountFromSeed(seed, networks.mainnet);
    const psbt = createPsbt(parseTransaction(expected.unsignedTxHex));
    expect(() =>
      account.prepareInput(psbt, 0, {
        index: 0,
        value: BigInt(expected.value),
        sighashType: 0x04,
      }),
    ).toThrow('unsupported Taproot sighash');

    account.prepareInput(psbt, 0, { index: 0, value: BigInt(expected.value) });
    psbt.updateInput(0, { tapMerkleRoot: new Uint8Array(32) });
    expect(() => account.signInput(psbt, 0, { index: 0 })).toThrow('key-path inputs only');
  });

  it('rejects invalid input indices and values', () => {
    const account = deriveSigningAccountFromSeed(seed, networks.mainnet);
    const expected = preparedVector('default');
    const psbt = createPsbt(parseTransaction(expected.unsignedTxHex));
    expect(() =>
      account.prepareInput(psbt, 1, { index: 0, value: 1n }),
    ).toThrow(RangeError);
    expect(() =>
      account.prepareInput(psbt, 0, { index: 0, value: -1n }),
    ).toThrow('amount bounds');
    expect(() =>
      account.prepareInput(psbt, 0, {
        index: 0,
        value: 1 as unknown as bigint,
      }),
    ).toThrow(TypeError);
  });
});
