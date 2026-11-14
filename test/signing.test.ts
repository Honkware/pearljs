import { BIP32Factory } from 'bip32';
import { crypto as bitcoinCrypto } from 'bitcoinjs-lib';
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
import type { Psbt } from '../src/index.js';
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
        allowedSighashTypes: [expected.hashType],
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

  it('refuses a sighash type the PSBT brings unless the caller allows it', () => {
    const expected = preparedVector('default');
    const account = deriveSigningAccountFromSeed(seed, networks.mainnet);
    const prepared = createPsbt(parseTransaction(expected.unsignedTxHex));
    account.prepareInput(prepared, 0, { index: expected.index, value: BigInt(expected.value) });
    const none = Transaction.SIGHASH_NONE | Transaction.SIGHASH_ANYONECANPAY;

    // A coordinator hands the PSBT back with PSBT_IN_SIGHASH_TYPE added.
    const tampered = parsePsbt(prepared.toBase64());
    tampered.updateInput(0, { sighashType: none });
    const returned = (): Psbt => parsePsbt(tampered.toBase64());

    const psbt = returned();
    expect(() => account.signInput(psbt, 0, { index: expected.index })).toThrow(
      'asks for sighash type 0x82, which is not in allowedSighashTypes',
    );
    expect(() =>
      account.signInput(psbt, 0, { index: expected.index, allowedSighashTypes: [Transaction.SIGHASH_ALL] }),
    ).toThrow('not in allowedSighashTypes');
    expect(psbt.data.inputs[0]?.tapKeySig).toBeUndefined();

    const allowed = returned();
    account.signInput(allowed, 0, { index: expected.index, allowedSighashTypes: [none] });
    expect(allowed.data.inputs[0]?.tapKeySig?.[64]).toBe(none);

    // Listing other types does not let an input without the field sign with them.
    account.signInput(prepared, 0, { index: expected.index, allowedSighashTypes: [Transaction.SIGHASH_DEFAULT, none] });
    expect(prepared.data.inputs[0]?.tapKeySig).toHaveLength(64);
    expect(() =>
      account.signInput(returned(), 0, { index: expected.index, allowedSighashTypes: [0x04] }),
    ).toThrow('unsupported Taproot sighash');
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

  it('mixes fresh randomness into every signature unless auxRand is given', () => {
    const expected = preparedVector('default');
    const account = deriveSigningAccountFromSeed(seed, networks.mainnet);
    const sign = (auxRand?: Uint8Array): string => {
      const psbt = createPsbt(parseTransaction(expected.unsignedTxHex));
      account.prepareInput(psbt, 0, { index: expected.index, value: BigInt(expected.value) });
      account.signInput(psbt, 0, { index: expected.index, ...(auxRand === undefined ? {} : { auxRand }) });
      const signature = psbt.data.inputs[0]!.tapKeySig!;
      expect(
        ecc.verifySchnorr(hexToBytes(expected.sighash), hexToBytes(expected.tweakedPubKey), signature),
      ).toBe(true);
      return bytesToHex(signature);
    };
    expect(sign()).not.toBe(sign());
    const auxRand = new Uint8Array(32).fill(3);
    expect(sign(auxRand)).toBe(sign(auxRand));
    expect(sign(auxRand)).not.toBe(sign(new Uint8Array(32)));
    expect(() => sign(new Uint8Array(16))).toThrow('auxRand must be 32 bytes');

    // Without auxiliary randomness tiny-secp256k1 signs as if it were 32 zero bytes,
    // which is what every signature used before.
    const tweaked = BIP32Factory(ecc)
      .fromSeed(seed, {
        wif: networks.mainnet.wif,
        bip32: { public: networks.mainnet.hdPublicKeyId, private: networks.mainnet.hdPrivateKeyId },
      })
      .derivePath(expected.path)
      .tweak(bitcoinCrypto.taggedHash('TapTweak', hexToBytes(expected.internalPubKey)));
    expect(sign(new Uint8Array(32))).toBe(bytesToHex(tweaked.signSchnorr(hexToBytes(expected.sighash))));
  });

  it('stops signing once destroyed and keeps the watch-only side working', () => {
    const expected = preparedVector('default');
    const ownedSeed = Uint8Array.from(seed);
    const account = deriveSigningAccountFromSeed(ownedSeed, networks.mainnet);
    const addressBefore = account.deriveAddress(4);
    const psbt = createPsbt(parseTransaction(expected.unsignedTxHex));
    account.prepareInput(psbt, 0, { index: expected.index, value: BigInt(expected.value) });
    account.signMessage('before', { index: 0 });

    account.destroy();
    account.destroy();
    expect(() => account.signInput(psbt, 0, { index: expected.index })).toThrow('has been destroyed');
    expect(() => account.signMessage('after', { index: 0 })).toThrow('has been destroyed');
    expect(() =>
      account.signScriptPathInput(psbt, 0, { index: 0, leafHash: new Uint8Array(32) }),
    ).toThrow('has been destroyed');
    expect(() =>
      account.signP2mrInput(parseTransaction(expected.unsignedTxHex), 0, {
        index: 0,
        prevouts: [],
        tree: { root: new Uint8Array(32), leaves: [] },
        leafIndex: 0,
      }),
    ).toThrow('has been destroyed');
    expect(psbt.data.inputs[0]?.tapKeySig).toBeUndefined();

    expect(account.deriveAddress(4)).toBe(addressBefore);
    expect(account.watchOnlyAccount().extendedPublicKey()).toBe(
      deriveSigningAccountFromSeed(seed, networks.mainnet).watchOnlyAccount().extendedPublicKey(),
    );
    // The seed is the caller's to wipe.
    expect(bytesToHex(ownedSeed)).toBe(vectors.bip86.seed);
  });

  it('rejects a seed that is not bytes with a clear error', () => {
    expect(() => deriveSigningAccountFromSeed(vectors.bip86.seed as unknown as Uint8Array, networks.mainnet)).toThrow(
      'seed must be a Uint8Array',
    );
    expect(() => deriveSigningAccountFromSeed(undefined as unknown as Uint8Array, networks.mainnet)).toThrow(TypeError);
  });
});
