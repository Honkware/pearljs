import { BIP32Factory } from 'bip32';
import * as ecc from 'tiny-secp256k1';
import { describe, expect, it } from 'vitest';
import {
  assembleScriptTree,
  checksigScript,
  createPsbt,
  deriveSigningAccountFromSeed,
  finalizePsbt,
  fromOutputScript,
  networks,
  p2mr,
  p2mrControlBlock,
  p2tr,
  parseP2mrControlBlock,
  parseTaprootControlBlock,
  parseTransaction,
  prepareTaprootScriptPathInput,
  serializeTransaction,
  signTaprootScriptPathInput,
  tapscriptSighash,
  taprootControlBlock,
  taprootOutputKey,
  transactionId,
  verifyP2mrLeafCommitment,
  verifyTaprootLeafCommitment,
  witnessTransactionId,
} from '../src/index.js';
import type { Psbt, ScriptTree } from '../src/index.js';
import vectors from '../vectors/pearl-go.json' with { type: 'json' };
import { bytesToHex, hexToBytes } from './vector-helpers.js';

const seed = hexToBytes(vectors.bip86.seed);
const account = deriveSigningAccountFromSeed(seed, networks.mainnet);
const internalPubkey = hexToBytes(vectors.scriptTrees[0]!.internalPubKey);

/** Leaf i is <x-only key of account/0/i> OP_CHECKSIG, as in generate.go. */
function keyTree(leafCount: number): ScriptTree {
  return assembleScriptTree(
    Array.from({ length: leafCount }, (_, index) => checksigScript(account.derivePublicKey(index))),
  );
}

function prepareInput(
  psbt: Psbt,
  tree: ScriptTree,
  expected: { leafIndex: number; value: number; hashType: number },
): void {
  prepareTaprootScriptPathInput(psbt, 0, {
    internalPubkey,
    tree,
    leafIndex: expected.leafIndex,
    value: BigInt(expected.value),
    sighashType: expected.hashType,
  });
}

function vectorPrevouts(expected: { prevouts: { script: string; value: number }[] }) {
  return expected.prevouts.map((prevout) => ({
    script: hexToBytes(prevout.script),
    value: BigInt(prevout.value),
  }));
}

function spendVector(name: string) {
  const vector = vectors.scriptPathSpends.find((item) => item.name === name);
  if (vector === undefined) throw new Error(`missing script-path vector ${name}`);
  return vector;
}

/** Go's final transaction with its signature replaced by ours. */
function expectedWithSignature(finalTxHex: string, signature: Uint8Array): string {
  const tx = parseTransaction(finalTxHex);
  const witness = tx.ins[0]!.witness;
  tx.setWitness(0, [signature, ...witness.slice(1)]);
  return serializeTransaction(tx);
}

describe('script trees', () => {
  it('matches Pearl AssembleTaprootScriptTree roots, proofs, and control blocks', () => {
    for (const expected of vectors.scriptTrees) {
      const tree = assembleScriptTree(expected.leaves.map((leaf) => hexToBytes(leaf.script)));
      expect(bytesToHex(tree.root)).toBe(expected.root);
      expect(bytesToHex(taprootOutputKey(internalPubkey, tree.root).outputKey)).toBe(
        expected.taprootOutputKey,
      );
      const trOutput = p2tr({ internalPubkey, merkleRoot: tree.root }).output;
      expect(fromOutputScript(trOutput, networks.mainnet)).toBe(expected.taprootAddress);
      expect(fromOutputScript(p2mr({ merkleRoot: tree.root }).output, networks.mainnet)).toBe(
        expected.p2mrAddress,
      );
      expected.leaves.forEach((leaf, index) => {
        const actual = tree.leaves[index]!;
        expect(bytesToHex(actual.leafHash)).toBe(leaf.leafHash);
        expect(bytesToHex(actual.proof)).toBe(leaf.proof);
        const trBlock = taprootControlBlock(internalPubkey, tree, index);
        const mrBlock = p2mrControlBlock(tree, index);
        expect(bytesToHex(trBlock)).toBe(leaf.taprootControlBlock);
        expect(bytesToHex(mrBlock)).toBe(leaf.p2mrControlBlock);
        verifyTaprootLeafCommitment(trBlock, trOutput.slice(2), actual.script);
        verifyP2mrLeafCommitment(mrBlock, tree.root, actual.script);
      });
    }
  });

  it('builds the same leaves the Go generator signed with', () => {
    for (const expected of vectors.scriptTrees) {
      const tree = keyTree(expected.leaves.length);
      expect(bytesToHex(tree.root)).toBe(expected.root);
    }
  });

  it('rejects empty and duplicate trees', () => {
    expect(() => assembleScriptTree([])).toThrow('at least one leaf');
    const script = checksigScript(account.derivePublicKey(0));
    expect(() => assembleScriptTree([script, script])).toThrow('distinct');
  });

  it('parses control blocks with Pearl size and parity rules', () => {
    const tree = keyTree(3);
    const trBlock = taprootControlBlock(internalPubkey, tree, 2);
    const parsedTr = parseTaprootControlBlock(trBlock);
    expect(parsedTr.leafVersion).toBe(0xc0);
    expect(bytesToHex(parsedTr.internalPubkey)).toBe(bytesToHex(internalPubkey));
    expect(parsedTr.proof).toHaveLength(32);

    const mrBlock = p2mrControlBlock(tree, 2);
    expect(parseP2mrControlBlock(mrBlock)).toMatchObject({ leafVersion: 0xc0 });
    expect(() => parseP2mrControlBlock(Uint8Array.of(0xc0))).toThrow('parity bit must be 1');
    expect(() => parseP2mrControlBlock(new Uint8Array(0))).toThrow('min is 1');
    expect(() => parseP2mrControlBlock(new Uint8Array(2).fill(0xc1))).toThrow('multiple of 32');
    expect(() => parseTaprootControlBlock(mrBlock.slice(0, 32))).toThrow('min is 33');
    expect(() => parseP2mrControlBlock(new Uint8Array(1 + 129 * 32).fill(0xc1))).toThrow('max is');
  });

  it('rejects a proof for a different root or script', () => {
    const tree = keyTree(3);
    const other = keyTree(4);
    const block = p2mrControlBlock(tree, 0);
    expect(() => verifyP2mrLeafCommitment(block, other.root, tree.leaves[0]!.script)).toThrow(
      'does not match',
    );
    expect(() => verifyP2mrLeafCommitment(block, tree.root, tree.leaves[1]!.script)).toThrow(
      'does not match',
    );
    const trBlock = taprootControlBlock(internalPubkey, tree, 0);
    const flipped = Uint8Array.from(trBlock);
    flipped[0] = flipped[0]! ^ 1;
    const program = p2tr({ internalPubkey, merkleRoot: tree.root }).output.slice(2);
    expect(() => verifyTaprootLeafCommitment(flipped, program, tree.leaves[0]!.script)).toThrow(
      'parity',
    );
  });
});

describe('P2TR script-path spends', () => {
  for (const expected of vectors.scriptPathSpends.filter((item) => item.kind === 'p2tr')) {
    it(`matches Go for ${expected.name}`, () => {
      const tree = keyTree(expected.leafCount);
      const leaf = tree.leaves[expected.leafIndex]!;
      expect(bytesToHex(leaf.script)).toBe(expected.leafScript);
      expect(bytesToHex(leaf.leafHash)).toBe(expected.leafHash);

      const psbt = createPsbt(parseTransaction(expected.unsignedTxHex));
      prepareInput(psbt, tree, expected);
      const input = psbt.data.inputs[0]!;
      expect(bytesToHex(input.witnessUtxo!.script)).toBe(expected.prevScript);
      expect(bytesToHex(input.tapLeafScript![0]!.controlBlock)).toBe(expected.controlBlock);
      expect(psbt.toBase64()).toBe(expected.preparedPsbt);

      const unsigned = parseTransaction(expected.unsignedTxHex);
      const prevouts = [{ script: hexToBytes(expected.prevScript), value: BigInt(expected.value) }];
      const sighash = tapscriptSighash(unsigned, 0, prevouts, leaf.leafHash, expected.hashType);
      expect(bytesToHex(sighash)).toBe(expected.sighash);

      account.signScriptPathInput(psbt, 0, { index: expected.leafIndex, leafHash: leaf.leafHash });
      const tx = finalizePsbt(psbt);
      const witness = tx.ins[0]!.witness;
      const signature = witness[0]!;
      expect(signature).toHaveLength(expected.signature.length / 2);
      expect(
        ecc.verifySchnorr(sighash, account.derivePublicKey(expected.leafIndex), signature.slice(0, 64)),
      ).toBe(true);
      expect(serializeTransaction(tx)).toBe(expectedWithSignature(expected.finalTxHex, signature));
      expect(transactionId(tx)).toBe(expected.txid);
    });
  }

  it('refuses a signer whose key is not in the leaf', () => {
    const expected = spendVector('p2tr-3-leaves-last-default');
    const tree = keyTree(3);
    const psbt = createPsbt(parseTransaction(expected.unsignedTxHex));
    prepareInput(psbt, tree, expected);
    expect(() =>
      account.signScriptPathInput(psbt, 0, { index: 0, leafHash: tree.leaves[2]!.leafHash }),
    ).toThrow('does not contain the signer key');
    expect(() =>
      account.signScriptPathInput(psbt, 0, { index: 0, leafHash: tree.leaves[0]!.leafHash }),
    ).toThrow('no tap leaf with that hash');
  });

  it('keeps key-path signing away from script-path inputs', () => {
    const expected = spendVector('p2tr-1-leaf-default');
    const psbt = createPsbt(parseTransaction(expected.unsignedTxHex));
    prepareInput(psbt, keyTree(1), expected);
    expect(() => account.signInput(psbt, 0, { index: 0 })).toThrow('key-path inputs only');
  });
});

describe('P2MR spends', () => {
  for (const expected of vectors.scriptPathSpends.filter((item) => item.kind === 'p2mr')) {
    it(`matches Go for ${expected.name}`, () => {
      const tree = keyTree(expected.leafCount);
      expect(bytesToHex(p2mr({ merkleRoot: tree.root }).output)).toBe(expected.prevScript);
      expect(bytesToHex(p2mrControlBlock(tree, expected.leafIndex))).toBe(expected.controlBlock);

      const tx = parseTransaction(expected.unsignedTxHex);
      const prevouts = vectorPrevouts(expected);
      const input = expected.inputIndex;
      const sighash = tapscriptSighash(
        tx,
        input,
        prevouts,
        tree.leaves[expected.leafIndex]!.leafHash,
        expected.hashType,
      );
      expect(bytesToHex(sighash)).toBe(expected.sighash);

      account.signP2mrInput(tx, input, {
        trustPrevouts: true, // vector prevouts point at synthetic transactions
        index: expected.leafIndex,
        prevouts,
        tree,
        leafIndex: expected.leafIndex,
        sighashType: expected.hashType,
      });
      const signature = tx.ins[input]!.witness[0]!;
      expect(signature).toHaveLength(expected.signature.length / 2);
      expect(
        ecc.verifySchnorr(sighash, account.derivePublicKey(expected.leafIndex), signature.slice(0, 64)),
      ).toBe(true);

      // Other inputs (the P2TR key-path input in the mixed vector) keep Go's witness.
      const goTx = parseTransaction(expected.finalTxHex);
      goTx.ins.forEach((goInput, index) => {
        if (index !== input) tx.setWitness(index, goInput.witness);
      });
      goTx.setWitness(input, [signature, ...goTx.ins[input]!.witness.slice(1)]);
      expect(serializeTransaction(tx)).toBe(serializeTransaction(goTx));
      expect(transactionId(tx)).toBe(expected.txid);
      expect(witnessTransactionId(tx)).toBe(witnessTransactionId(goTx));
    });
  }

  it('matches Pearl sighashes across P2TR and P2MR input mixes', () => {
    for (const expected of vectors.scriptPathSpends) {
      const tx = parseTransaction(expected.unsignedTxHex);
      const prevouts = vectorPrevouts(expected);
      const leafHash = hexToBytes(expected.leafHash);
      const bip341 = tx.hashForWitnessV1(
        expected.inputIndex,
        prevouts.map((prevout) => prevout.script),
        prevouts.map((prevout) => prevout.value),
        expected.hashType,
        leafHash,
      );
      const pearl = tapscriptSighash(tx, expected.inputIndex, prevouts, leafHash, expected.hashType);
      const hasP2tr = prevouts.some((prevout) => prevout.script[0] === 0x51);
      const anyoneCanPay = (expected.hashType & 0x80) !== 0;
      expect(bytesToHex(pearl) === bytesToHex(bip341), expected.name).toBe(hasP2tr || anyoneCanPay);
    }
  });

  it('refuses a tree the prevout does not commit to', () => {
    const expected = spendVector('p2mr-3-leaves-middle-all-anyonecanpay');
    const tx = parseTransaction(expected.unsignedTxHex);
    const prevouts = [{ script: hexToBytes(expected.prevScript), value: BigInt(expected.value) }];
    expect(() =>
      account.signP2mrInput(tx, 0, { index: 1, prevouts, tree: keyTree(4), leafIndex: 1 }),
    ).toThrow('does not match the witness program');
    expect(() =>
      account.signP2mrInput(tx, 0, { index: 0, prevouts, tree: keyTree(3), leafIndex: 1 }),
    ).toThrow('does not contain the signer key');
    expect(tx.ins[0]!.witness).toHaveLength(0);
  });

  it('refuses a P2TR prevout and a mismatched prevout count', () => {
    const expected = spendVector('p2tr-1-leaf-default');
    const tx = parseTransaction(expected.unsignedTxHex);
    const prevouts = [{ script: hexToBytes(expected.prevScript), value: BigInt(expected.value) }];
    expect(() =>
      account.signP2mrInput(tx, 0, { index: 0, prevouts, tree: keyTree(1), leafIndex: 0 }),
    ).toThrow('does not spend a P2MR output');
    expect(() => tapscriptSighash(tx, 0, [], keyTree(1).root)).toThrow('expected 1 prevouts');
  });
});

describe('generic signers', () => {
  it('signs a P2TR script path with a raw private key', () => {
    const expected = spendVector('p2tr-3-leaves-last-default');
    const tree = keyTree(3);
    const privateKey = BIP32Factory(ecc)
      .fromSeed(seed, {
        wif: networks.mainnet.wif,
        bip32: { public: networks.mainnet.hdPublicKeyId, private: networks.mainnet.hdPrivateKeyId },
      })
      .derivePath(expected.signerPath).privateKey!;
    const signer = {
      publicKey: ecc.pointFromScalar(privateKey)!,
      signSchnorr: (hash: Uint8Array) => ecc.signSchnorr(hash, privateKey),
    };
    const psbt = createPsbt(parseTransaction(expected.unsignedTxHex));
    prepareInput(psbt, tree, expected);
    signTaprootScriptPathInput(psbt, 0, signer, tree.leaves[2]!.leafHash);
    expect(transactionId(finalizePsbt(psbt))).toBe(expected.txid);
  });
});
