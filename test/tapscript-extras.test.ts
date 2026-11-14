// Annexes and OP_CODESEPARATOR in script-path spends. Every sighash here was
// computed by Pearl's txscript for a spend its script engine then accepted
// (vectors.tapscriptExtras), on P2TR and P2MR outputs.

import * as ecc from 'tiny-secp256k1';
import { describe, expect, it } from 'vitest';
import {
  assembleScriptTree,
  codeSeparatorPositions,
  deriveSigningAccountFromSeed,
  inspectTransaction,
  networks,
  parseTransaction,
  scriptPathWitness,
  serializeTransaction,
  signTapscriptUnchecked,
  tapLeafHash,
  tapscriptSighash,
  transactionId,
} from '../src/index.js';
import vectors from '../vectors/pearl-go.json' with { type: 'json' };
import { bytesToHex, hexToBytes } from './vector-helpers.js';

const account = deriveSigningAccountFromSeed(hexToBytes(vectors.bip86.seed), networks.mainnet);
const NO_SEPARATOR = 0xffffffff;

describe('script-path spends with an annex or a code separator', () => {
  it('has vectors for each alone and both together, on both output types', () => {
    const kinds = new Set(
      vectors.tapscriptExtras.map((v) => [v.kind, ...(v.annex === '' ? [] : ['annex']), ...(v.codeSepPositions.length > 0 ? ['codesep'] : [])].join(' ')),
    );
    expect(kinds).toEqual(new Set(['p2tr annex', 'p2mr annex', 'p2tr codesep', 'p2mr codesep', 'p2mr annex codesep', 'p2tr annex codesep']));
  });

  for (const expected of vectors.tapscriptExtras) {
    const prevouts = expected.prevouts.map((p) => ({ script: hexToBytes(p.script), value: BigInt(p.value) }));
    const inputIndex = prevouts.length - 1;
    const script = hexToBytes(expected.leafScript);
    const annex = expected.annex === '' ? undefined : hexToBytes(expected.annex);
    const context = (codeSepPos: number) => ({
      prevouts,
      sighashType: expected.hashType,
      ...(annex === undefined ? {} : { annex }),
      ...(codeSepPos === NO_SEPARATOR ? {} : { codeSeparatorPosition: codeSepPos }),
    });

    it(`matches Pearl for ${expected.name}`, () => {
      const tx = parseTransaction(expected.unsignedTxHex);
      expect(codeSeparatorPositions(script)).toEqual(expected.codeSepPositions);

      for (const sig of expected.signatures) {
        const hash = tapscriptSighash(tx, inputIndex, { ...context(sig.codeSepPos), leafHash: tapLeafHash(script) });
        expect(bytesToHex(hash), `key ${sig.keyIndex}`).toBe(sig.sighash);

        const signer = account.tapscriptSigner({ index: sig.keyIndex });
        const signature = signTapscriptUnchecked(tx, inputIndex, signer, { ...context(sig.codeSepPos), script });
        expect(signature).toHaveLength(sig.signature.length / 2);
        expect(ecc.verifySchnorr(hexToBytes(sig.sighash), signer.publicKey, signature.subarray(0, 64))).toBe(true);
      }

      // The witness Pearl's engine accepted, rebuilt from its signatures.
      const final = parseTransaction(expected.finalTxHex);
      const witness = scriptPathWitness(expected.signatures.map((sig) => hexToBytes(sig.signature)), script, hexToBytes(expected.controlBlock), annex);
      final.ins.forEach((input, i) => tx.setWitness(i, i === inputIndex ? witness : input.witness));
      expect(serializeTransaction(tx)).toBe(expected.finalTxHex);
      expect(transactionId(tx)).toBe(expected.txid);

      const inspected = inspectTransaction(tx, prevouts, networks.mainnet).inputs[inputIndex]!;
      expect(inspected.spend.type).toBe('scriptPath');
      expect(inspected.annex === undefined ? '' : bytesToHex(inspected.annex)).toBe(expected.annex);
    });
  }

  it('signs a single-key P2MR leaf for an annex and ends the witness with it', () => {
    const expected = vectors.tapscriptExtras.find((v) => v.name === 'p2mr-annex')!;
    const tx = parseTransaction(expected.unsignedTxHex);
    const script = hexToBytes(expected.leafScript);
    const annex = hexToBytes(expected.annex);
    const sig = expected.signatures[0]!;
    account.signP2mrInput(tx, 0, {
      index: sig.keyIndex,
      prevouts: expected.prevouts.map((p) => ({ script: hexToBytes(p.script), value: BigInt(p.value) })),
      tree: assembleScriptTree([script]),
      leafIndex: 0,
      annex,
      trustPrevouts: true,
      // The vector leaves half its input to the fee.
      maxFeeRate: 10n ** 12n,
    });
    const witness = tx.ins[0]!.witness;
    expect(witness).toHaveLength(4);
    expect(witness[3]).toEqual(annex);
    expect(ecc.verifySchnorr(hexToBytes(sig.sighash), account.derivePublicKey(sig.keyIndex), witness[0]!)).toBe(true);
    expect(transactionId(tx)).toBe(expected.txid);
  });

  it('refuses an annex that does not start with 0x50 and a separator position that is not one', () => {
    const expected = vectors.tapscriptExtras[0]!;
    const tx = parseTransaction(expected.unsignedTxHex);
    const prevouts = expected.prevouts.map((p) => ({ script: hexToBytes(p.script), value: BigInt(p.value) }));
    const leafHash = tapLeafHash(hexToBytes(expected.leafScript));
    expect(() => tapscriptSighash(tx, 0, { prevouts, leafHash, annex: Uint8Array.of(0x51) })).toThrow('must be bytes that start with 0x50');
    expect(() => tapscriptSighash(tx, 0, { prevouts, leafHash, annex: new Uint8Array(0) })).toThrow('must be bytes that start with 0x50');
    expect(() => scriptPathWitness([], new Uint8Array(1), new Uint8Array(1), Uint8Array.of(1))).toThrow('must be bytes that start with 0x50');
    expect(() => tapscriptSighash(tx, 0, { prevouts, leafHash, codeSeparatorPosition: -1 })).toThrow(RangeError);
    expect(() => tapscriptSighash(tx, 0, { prevouts, leafHash, codeSeparatorPosition: 0xffffffff })).toThrow(RangeError);
    expect(() => codeSeparatorPositions(Uint8Array.of(0x4c))).toThrow('requires 1 bytes');
  });
});
