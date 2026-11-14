// P2MR script-path inputs carried in a PSBT, against PSBTs built with
// Pearl's psbt package: the same fields byte for byte before and after
// signing, Pearl's witness layout on finalization, and the input-value check
// fed from each input's nonWitnessUtxo.

import { BIP32Factory } from 'bip32';
import * as ecc from 'tiny-secp256k1';
import { describe, expect, it } from 'vitest';
import {
  assembleScriptTree,
  createPsbt,
  deriveSigningAccountFromSeed,
  finalizePsbt,
  networks,
  p2mr,
  parsePsbt,
  parseTransaction,
  prepareP2mrScriptPathInput,
  serializeTransaction,
  signP2mrScriptPathInput,
  signP2mrScriptPathInputAsync,
  signTaprootScriptPathInput,
  Transaction,
  witnessTransactionId,
} from '../src/index.js';
import type { Psbt, ScriptTree, TapscriptSignerAsync } from '../src/index.js';
import vectors from '../vectors/pearl-go.json' with { type: 'json' };
import { bytesToHex, hexToBytes } from './vector-helpers.js';

const seed = hexToBytes(vectors.bip86.seed);
const account = deriveSigningAccountFromSeed(seed, networks.mainnet);
const root = BIP32Factory(ecc).fromSeed(seed, {
  wif: networks.mainnet.wif,
  bip32: { public: networks.mainnet.hdPublicKeyId, private: networks.mainnet.hdPrivateKeyId },
});

type Vector = (typeof vectors.p2mrPsbts)[number];
type InputVector = Vector['inputs'][number];

function vectorNamed(name: string): Vector {
  const vector = vectors.p2mrPsbts.find((item) => item.name === name);
  if (vector === undefined) throw new Error(`missing P2MR PSBT vector ${name}`);
  return vector;
}

function treeOf(input: InputVector): ScriptTree {
  return assembleScriptTree(input.leafScripts.map(hexToBytes));
}

/** The vector's unsigned transaction with every input prepared as generate.go does. */
function preparedPsbt(vector: Vector, withPrevious: (index: number) => boolean = () => true): Psbt {
  const psbt = createPsbt(parseTransaction(vector.unsignedTxHex));
  vector.inputs.forEach((input, index) => {
    const value = BigInt(vector.prevouts[index]!.value);
    if (input.kind === 'p2tr-key') {
      account.prepareInput(psbt, index, { index: 1, change: true, value });
      return;
    }
    prepareP2mrScriptPathInput(psbt, index, {
      tree: treeOf(input),
      leafIndex: input.leafIndex,
      value,
      sighashType: input.hashType,
      ...(withPrevious(index) && input.previousTxHex !== ''
        ? { previousTransaction: parseTransaction(input.previousTxHex) }
        : {}),
    });
  });
  return psbt;
}

/** Signs every input and returns, per input, the pairs of Go and pearljs signatures. */
function signAll(vector: Vector, psbt: Psbt): [string, string][] {
  const pairs: [string, string][] = [];
  vector.inputs.forEach((input, index) => {
    const sighash = hexToBytes(input.sighash);
    if (input.kind === 'p2tr-key') {
      account.signInput(psbt, index, { index: 1, change: true });
      const signature = psbt.data.inputs[index]!.tapKeySig!;
      const outputKey = hexToBytes(vector.prevouts[index]!.script).slice(2);
      expect(ecc.verifySchnorr(sighash, outputKey, signature.slice(0, 64))).toBe(true);
      pairs.push([input.signatures[0]!, bytesToHex(signature)]);
      return;
    }
    const leafHash = treeOf(input).leaves[input.leafIndex]!.leafHash;
    input.signers.forEach((signer, i) => {
      account.signScriptPathInput(psbt, index, { index: signer, leafHash, allowedSighashTypes: [input.hashType] });
      const key = account.derivePublicKey(signer);
      const signature = psbt.data.inputs[index]!.tapScriptSig!.find((sig) => bytesToHex(sig.pubkey) === bytesToHex(key))!
        .signature;
      expect(ecc.verifySchnorr(sighash, key, signature.slice(0, 64))).toBe(true);
      pairs.push([input.signatures[i]!, bytesToHex(signature)]);
    });
  });
  return pairs;
}

/** Go's bytes with its signatures replaced by ours, since Schnorr nonces differ. */
function withSignatures(goHex: string, pairs: [string, string][]): string {
  return pairs.reduce((hex, [go, ours]) => {
    expect(hex).toContain(go);
    return hex.replaceAll(go, ours);
  }, goHex);
}

const base64Hex = (base64: string): string => Buffer.from(base64, 'base64').toString('hex');

describe('P2MR script paths through PSBT', () => {
  for (const vector of vectors.p2mrPsbts) {
    it(`builds, signs and finalizes ${vector.name} like Pearl`, () => {
      vector.inputs.forEach((input, index) => {
        if (input.kind !== 'p2mr') return;
        expect(bytesToHex(p2mr({ merkleRoot: treeOf(input).root }).output)).toBe(vector.prevouts[index]!.script);
      });
      const psbt = preparedPsbt(vector);
      expect(psbt.toBase64()).toBe(vector.preparedPsbt);

      const pairs = signAll(vector, psbt);
      expect(bytesToHex(psbt.toBuffer())).toBe(withSignatures(base64Hex(vector.signedPsbt), pairs));

      const tx = finalizePsbt(psbt);
      expect(serializeTransaction(tx)).toBe(withSignatures(vector.finalTxHex, pairs));
    });

    it(`finalizes Go's signed PSBT for ${vector.name} into Go's transaction`, () => {
      const tx = finalizePsbt(parsePsbt(vector.signedPsbt));
      expect(serializeTransaction(tx)).toBe(vector.finalTxHex);
      expect(witnessTransactionId(tx)).toBe(vector.wtxid);
    });
  }

  it('lays out a multi_a witness with an empty item for the key that did not sign', () => {
    const vector = vectorNamed('p2mr-multi-a-2-of-3-default');
    const witness = parseTransaction(vector.finalTxHex).ins[0]!.witness;
    expect(witness.slice(0, 3).map((item) => item.length)).toEqual([64, 0, 64]);
  });

  it('refuses an all-P2MR input unless every input carries its previous transaction', () => {
    const vector = vectorNamed('p2mr-two-inputs-default');
    const psbt = preparedPsbt(vector, (index) => index === 1);
    expect(psbt.data.inputs[1]!.nonWitnessUtxo).toBeDefined();
    const leafHash = treeOf(vector.inputs[0]!).leaves[1]!.leafHash;
    expect(() => account.signScriptPathInput(psbt, 0, { index: 1, leafHash })).toThrow('nonWitnessUtxo');
    expect(psbt.data.inputs[0]!.tapScriptSig).toBeUndefined();
  });

  it('refuses a witness UTXO value the previous transaction does not back', () => {
    const vector = vectorNamed('p2mr-1-leaf-default');
    const psbt = preparedPsbt(vector);
    const utxo = psbt.data.inputs[0]!.witnessUtxo!;
    psbt.data.inputs[0]!.witnessUtxo = { script: utxo.script, value: utxo.value - 1n };
    const leafHash = treeOf(vector.inputs[0]!).leaves[0]!.leafHash;
    expect(() => account.signScriptPathInput(psbt, 0, { index: 0, leafHash })).toThrow('does not match');
    expect(psbt.data.inputs[0]!.tapScriptSig).toBeUndefined();
  });

  it('signs without previous transactions when told to trust the prevouts', () => {
    const vector = vectorNamed('p2mr-1-leaf-default');
    const psbt = preparedPsbt(vector, () => false);
    const leafHash = treeOf(vector.inputs[0]!).leaves[0]!.leafHash;
    account.signScriptPathInput(psbt, 0, { index: 0, leafHash, trustPrevouts: true });
    const signature = psbt.data.inputs[0]!.tapScriptSig![0]!.signature;
    expect(ecc.verifySchnorr(hexToBytes(vector.inputs[0]!.sighash), account.derivePublicKey(0), signature)).toBe(true);
  });

  it('refuses a previous transaction that is not the one the input spends', () => {
    const vector = vectorNamed('p2mr-two-inputs-default');
    const psbt = createPsbt(parseTransaction(vector.unsignedTxHex));
    const input = vector.inputs[1]!;
    expect(() =>
      prepareP2mrScriptPathInput(psbt, 0, {
        tree: treeOf(vector.inputs[0]!),
        leafIndex: 1,
        value: BigInt(vector.prevouts[0]!.value),
        previousTransaction: parseTransaction(input.previousTxHex),
      }),
    ).toThrow('not the one PSBT input 0 spends');
  });

  it('rejects a control block that does not open the output', () => {
    const vector = vectorNamed('p2mr-4-leaves-third-all');
    const psbt = preparedPsbt(vector);
    const leaf = psbt.data.inputs[0]!.tapLeafScript![0]!;
    leaf.controlBlock = Uint8Array.from([...leaf.controlBlock.slice(0, 33), ...leaf.controlBlock.slice(1, 33)]);
    const leafHash = treeOf(vector.inputs[0]!).leaves[2]!.leafHash;
    expect(() => account.signScriptPathInput(psbt, 0, { index: 2, leafHash })).toThrow('P2MR merkle proof');
  });

  it('keeps P2MR inputs away from the Taproot script-path signer', () => {
    const vector = vectorNamed('p2mr-1-leaf-default');
    const psbt = preparedPsbt(vector);
    const child = root.derivePath(`${vectors.bip86.accountPath}/0/0`);
    const leafHash = treeOf(vector.inputs[0]!).leaves[0]!.leafHash;
    expect(() => signTaprootScriptPathInput(psbt, 0, child, { leafHash })).toThrow('signP2mrScriptPathInput');
  });

  it('finalizes only verified signatures of keys the leaf pushes', () => {
    const vector = vectorNamed('p2mr-1-leaf-default');
    const leafHash = treeOf(vector.inputs[0]!).leaves[0]!.leafHash;
    const good = finalizePsbt(parsePsbt(vector.signedPsbt));
    const junk = { pubkey: new Uint8Array(32).fill(2), leafHash, signature: new Uint8Array(64).fill(9) };

    // A signature for a key the leaf does not push is left out of the witness.
    const extra = parsePsbt(vector.signedPsbt);
    extra.data.inputs[0]!.tapScriptSig!.unshift(junk);
    expect(serializeTransaction(finalizePsbt(extra))).toBe(serializeTransaction(good));

    const onlyJunk = parsePsbt(vector.signedPsbt);
    onlyJunk.data.inputs[0]!.tapScriptSig = [junk];
    expect(() => finalizePsbt(onlyJunk)).toThrow('PSBT input 0 has no signature for a key its leaf pushes');

    // A signature that does not verify would only be rejected by the node.
    const key = bytesToHex(account.derivePublicKey(0));
    for (const signature of [new Uint8Array(64).fill(1), new Uint8Array(63), new Uint8Array(65)]) {
      const corrupted = parsePsbt(vector.signedPsbt);
      corrupted.data.inputs[0]!.tapScriptSig![0]!.signature = signature;
      expect(() => finalizePsbt(corrupted)).toThrow(`PSBT input 0 has an invalid script-path signature for key ${key}`);
    }
    const flipped = parsePsbt(vector.signedPsbt);
    const original = flipped.data.inputs[0]!.tapScriptSig![0]!.signature;
    flipped.data.inputs[0]!.tapScriptSig![0]!.signature = Uint8Array.from(original, (byte, i) => (i === 40 ? byte ^ 1 : byte));
    expect(() => finalizePsbt(flipped)).toThrow('invalid script-path signature');

    // A valid signature under another sighash type than its last byte claims.
    const retyped = parsePsbt(vector.signedPsbt);
    retyped.data.inputs[0]!.tapScriptSig![0]!.signature = Uint8Array.from([...original, Transaction.SIGHASH_ALL]);
    expect(() => finalizePsbt(retyped)).toThrow('invalid script-path signature');
  });

  it('checks multi_a signatures and the leaf commitment before finalizing', () => {
    const vector = vectorNamed('p2mr-multi-a-2-of-3-default');
    const corrupted = parsePsbt(vector.signedPsbt);
    const sig = corrupted.data.inputs[0]!.tapScriptSig![1]!;
    sig.signature = Uint8Array.from(sig.signature, (byte, i) => (i === 0 ? byte ^ 1 : byte));
    expect(() => finalizePsbt(corrupted)).toThrow(
      `PSBT input 0 has an invalid script-path signature for key ${bytesToHex(sig.pubkey)}`,
    );

    const wrongProof = parsePsbt(vectorNamed('p2mr-4-leaves-third-all').signedPsbt);
    const leaf = wrongProof.data.inputs[0]!.tapLeafScript![0]!;
    leaf.controlBlock = Uint8Array.from([...leaf.controlBlock.slice(0, 33), ...leaf.controlBlock.slice(1, 33)]);
    expect(() => finalizePsbt(wrongProof)).toThrow('P2MR merkle proof does not match');
  });

  it('refuses a sighash type the PSBT brings unless the caller allows it', () => {
    const vector = vectorNamed('p2mr-1-leaf-default');
    const leafHash = treeOf(vector.inputs[0]!).leaves[0]!.leafHash;
    const child = root.derivePath(`${vectors.bip86.accountPath}/0/0`);
    const tampered = parsePsbt(preparedPsbt(vector).toBase64());
    tampered.updateInput(0, { sighashType: Transaction.SIGHASH_NONE });
    const returned = (): Psbt => parsePsbt(tampered.toBase64());

    const psbt = returned();
    expect(() => account.signScriptPathInput(psbt, 0, { index: 0, leafHash })).toThrow(
      'asks for sighash type 0x02, which is not in allowedSighashTypes',
    );
    expect(() => signP2mrScriptPathInput(psbt, 0, child, { leafHash })).toThrow('not in allowedSighashTypes');
    expect(psbt.data.inputs[0]!.tapScriptSig).toBeUndefined();

    const allowed = returned();
    signP2mrScriptPathInput(allowed, 0, child, { leafHash, allowedSighashTypes: [Transaction.SIGHASH_NONE] });
    expect(allowed.data.inputs[0]!.tapScriptSig![0]!.signature[64]).toBe(Transaction.SIGHASH_NONE);
  });

  it('asks an async signer only once the checks pass', async () => {
    const vector = vectorNamed('p2mr-3-leaves-first-none');
    const child = root.derivePath(`${vectors.bip86.accountPath}/0/0`);
    let calls = 0;
    const signer: TapscriptSignerAsync = {
      publicKey: child.publicKey,
      async signSchnorr(hash) {
        calls += 1;
        return child.signSchnorr(hash);
      },
    };
    const leafHash = treeOf(vector.inputs[0]!).leaves[0]!.leafHash;

    const refused = preparedPsbt(vector, () => false);
    await expect(
      signP2mrScriptPathInputAsync(refused, 0, signer, { leafHash, allowedSighashTypes: [Transaction.SIGHASH_NONE] }),
    ).rejects.toThrow('nonWitnessUtxo');
    expect(calls).toBe(0);

    const psbt = preparedPsbt(vector);
    await expect(signP2mrScriptPathInputAsync(psbt, 0, signer, { leafHash })).rejects.toThrow(
      'not in allowedSighashTypes',
    );
    expect(calls).toBe(0);
    await signP2mrScriptPathInputAsync(psbt, 0, signer, { leafHash, allowedSighashTypes: [Transaction.SIGHASH_NONE] });
    expect(calls).toBe(1);
    const signature = psbt.data.inputs[0]!.tapScriptSig![0]!.signature;
    expect(signature).toHaveLength(65);
    const pairs: [string, string][] = [[vector.inputs[0]!.signatures[0]!, bytesToHex(signature)]];
    expect(serializeTransaction(finalizePsbt(psbt))).toBe(withSignatures(vector.finalTxHex, pairs));
  });
});
