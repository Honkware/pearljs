// k-of-n OP_CHECKSIGADD leaves finalized like Pearl's psbt.Finalize: one
// witness item per key in reverse script order, empty where a key did not
// sign, and signatures beyond the threshold dropped in script order.

import * as ecc from 'tiny-secp256k1';
import { describe, expect, it } from 'vitest';
import {
  assembleScriptTree,
  createPsbt,
  deriveSigningAccountFromSeed,
  finalizePsbt,
  networks,
  parseTransaction,
  prepareTaprootScriptPathInput,
  tapscriptSighash,
  transactionId,
} from '../src/index.js';
import vectors from '../vectors/pearl-go.json' with { type: 'json' };
import { bytesToHex, hexToBytes } from './vector-helpers.js';

const account = deriveSigningAccountFromSeed(hexToBytes(vectors.bip86.seed), networks.mainnet);
// generate.go derives multi_a keys at account/0/(20 + key index).
const KEY_OFFSET = 20;

function signedPsbt(expected: (typeof vectors.multiASpends)[number], signers = expected.signerIndices) {
  const tree = assembleScriptTree([hexToBytes(expected.leafScript)]);
  const psbt = createPsbt(parseTransaction(expected.unsignedTxHex));
  prepareTaprootScriptPathInput(psbt, 0, {
    internalPubkey: hexToBytes(expected.internalPubKey),
    tree,
    leafIndex: 0,
    value: BigInt(expected.prevouts[0]!.value),
  });
  for (const index of signers) {
    account.signScriptPathInput(psbt, 0, { index: KEY_OFFSET + index, leafHash: tree.leaves[0]!.leafHash });
  }
  return { psbt, tree };
}

describe('multi_a finalization', () => {
  for (const expected of vectors.multiASpends) {
    it(`lays out the witness like Pearl for ${expected.name}`, () => {
      const { psbt, tree } = signedPsbt(expected);
      const tx = finalizePsbt(psbt);
      const witness = tx.ins[0]!.witness;
      expect(witness.map((item) => item.length)).toEqual(expected.witnessLengths);

      const goWitness = parseTransaction(expected.finalTxHex).ins[0]!.witness;
      expect(bytesToHex(witness[witness.length - 2]!)).toBe(bytesToHex(goWitness[goWitness.length - 2]!));
      expect(bytesToHex(witness[witness.length - 1]!)).toBe(bytesToHex(goWitness[goWitness.length - 1]!));

      // Item i of the stack belongs to key n-1-i of the script.
      const prevouts = expected.prevouts.map((p) => ({ script: hexToBytes(p.script), value: BigInt(p.value) }));
      const hash = tapscriptSighash(tx, 0, prevouts, tree.leaves[0]!.leafHash);
      const keys = expected.keyIndices.map((index) => account.derivePublicKey(KEY_OFFSET + index));
      witness.slice(0, keys.length).forEach((signature, i) => {
        if (signature.length === 0) return;
        expect(ecc.verifySchnorr(hash, keys[keys.length - 1 - i]!, signature)).toBe(true);
      });
      expect(transactionId(tx)).toBe(transactionId(parseTransaction(expected.finalTxHex)));
    });
  }

  it('refuses to finalize with fewer signatures than the threshold', () => {
    const expected = vectors.multiASpends.find((item) => item.name === '3-of-5-signed-by-1-3-4')!;
    const { psbt } = signedPsbt(expected, [1, 3]);
    expect(() => finalizePsbt(psbt)).toThrow('2 of the 3 signatures');
  });

  it('refuses to finalize a signature that does not verify', () => {
    const expected = vectors.multiASpends.find((item) => item.name === '3-of-5-signed-by-1-3-4')!;
    const { psbt } = signedPsbt(expected);
    const sig = psbt.data.inputs[0]!.tapScriptSig![0]!;
    sig.signature = Uint8Array.from(sig.signature, (byte, i) => (i === 63 ? byte ^ 1 : byte));
    expect(() => finalizePsbt(psbt)).toThrow(
      `PSBT input 0 has an invalid script-path signature for key ${bytesToHex(sig.pubkey)}`,
    );
  });
});
