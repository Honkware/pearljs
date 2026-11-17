// Leaves that take more than signatures, co-signed through PSBT: a hash lock
// with a signature, a timelock with a preimage and an OP_CAT leaf, under P2TR
// and P2MR. Pearl's engine accepted the Go transactions; finalization here
// must produce the same bytes, and must never write a witness the engine
// would refuse.

import { describe, expect, it } from 'vitest';
import {
  OP_CODES,
  PearlError,
  ScriptRejectedError,
  SigningError,
  addInputByTxid,
  assembleScriptTree,
  checksigScript,
  compileScript,
  createPsbt,
  createTransaction,
  csvScript,
  deriveSigningAccountFromSeed,
  encodeSequence,
  finalizePsbt,
  finalizeScriptPathInput,
  networks,
  p2mr,
  p2tr,
  parsePsbt,
  parseTransaction,
  prepareP2mrScriptPathInput,
  prepareTaprootScriptPathInput,
  serializeTransaction,
  sha256,
  tapLeafHash,
  toOutputScript,
  transactionId,
  verifyFinalizedPsbt,
} from '../src/index.js';
import type { Psbt, ScriptTree, Transaction } from '../src/index.js';
import vectors from '../vectors/pearl-go.json' with { type: 'json' };
import { bytesToHex, hexToBytes } from './vector-helpers.js';

const network = networks.mainnet;
const seed = hexToBytes(vectors.bip86.seed);
const alice = deriveSigningAccountFromSeed(seed, network);
const bob = deriveSigningAccountFromSeed(seed, network, 1);
const A = alice.derivePublicKey(0);
const B = bob.derivePublicKey(0);
const internalPubkey = hexToBytes(vectors.customLeaves[0]!.internalPubKey);
const VALUE = 100_000_000n;

type Kind = 'p2tr' | 'p2mr';
const kinds: Kind[] = ['p2tr', 'p2mr'];

function error(run: () => unknown): PearlError {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(PearlError);
    return err as PearlError;
  }
  throw new Error('nothing was thrown');
}

/** What one side sends the other: the PSBT as base64, parsed again on arrival. */
function sent(psbt: Psbt): Psbt {
  return parsePsbt(psbt.toBase64());
}

function outputScript(kind: Kind, tree: ScriptTree): Uint8Array {
  return kind === 'p2tr' ? p2tr({ internalPubkey, merkleRoot: tree.root }).output : p2mr({ merkleRoot: tree.root }).output;
}

/** A funding transaction paying the tree and a prepared PSBT that spends it through one leaf. */
function spendOf(
  kind: Kind,
  tree: ScriptTree,
  leafIndex: number,
  shape: { locktime?: number; sequence?: number } = {},
): { psbt: Psbt; funding: Transaction } {
  const funding = createTransaction(2);
  addInputByTxid(funding, 'cc'.repeat(32), 0);
  funding.addOutput(outputScript(kind, tree), VALUE);
  const tx = createTransaction(2);
  tx.locktime = shape.locktime ?? 0;
  addInputByTxid(tx, funding.getId(), 0, shape.sequence ?? 0xfffffffd);
  tx.addOutput(toOutputScript(alice.deriveAddress(9), network), VALUE - 10_000n);
  const psbt = createPsbt(tx);
  if (kind === 'p2tr') prepareTaprootScriptPathInput(psbt, 0, { internalPubkey, tree, leafIndex, value: VALUE });
  else prepareP2mrScriptPathInput(psbt, 0, { tree, leafIndex, value: VALUE, previousTransaction: funding });
  return { psbt, funding };
}

const secret = new TextEncoder().encode('swap secret 42');
const blob = new TextEncoder().encode('pearl-covenant');
const hashLock = compileScript([OP_CODES.OP_SHA256, sha256(secret), OP_CODES.OP_EQUALVERIFY, A, OP_CODES.OP_CHECKSIG]);
const twoParty = compileScript([
  OP_CODES.OP_SHA256, sha256(secret), OP_CODES.OP_EQUALVERIFY, A, OP_CODES.OP_CHECKSIGVERIFY, B, OP_CODES.OP_CHECKSIG,
]);
const catLeaf = compileScript([OP_CODES.OP_CAT, OP_CODES.OP_SHA256, sha256(blob), OP_CODES.OP_EQUAL]);

describe("custom leaves against Pearl's engine", () => {
  const signer = alice.derivePublicKey(40);

  for (const vector of vectors.customLeaves) {
    const kind = vector.kind as Kind;
    const leafScript = hexToBytes(vector.leafScript);
    const tree = assembleScriptTree([leafScript]);
    const stack = vector.stack.map(hexToBytes);

    function prepared(): Psbt {
      const psbt = createPsbt(parseTransaction(vector.unsignedTxHex));
      const value = BigInt(vector.prevouts[0]!.value);
      if (kind === 'p2tr') prepareTaprootScriptPathInput(psbt, 0, { internalPubkey, tree, leafIndex: 0, value });
      else prepareP2mrScriptPathInput(psbt, 0, { tree, leafIndex: 0, value });
      expect(bytesToHex(psbt.data.inputs[0]!.witnessUtxo!.script)).toBe(vector.prevouts[0]!.script);
      expect(bytesToHex(psbt.data.inputs[0]!.tapLeafScript![0]!.controlBlock)).toBe(vector.controlBlock);
      return psbt;
    }

    it(`finalizes ${vector.name} into Go's transaction from Go's signature and the caller's items`, () => {
      const psbt = prepared();
      if (vector.signatureAt >= 0) {
        psbt.updateInput(0, {
          tapScriptSig: [{ pubkey: signer, leafHash: tree.leaves[0]!.leafHash, signature: stack[vector.signatureAt]! }],
        });
      }
      const received = sent(psbt);
      finalizeScriptPathInput(received, 0, {
        stack: (signatureFor) => stack.map((item, i) => (i === vector.signatureAt ? signatureFor(signer) : item)),
      });
      expect(serializeTransaction(finalizePsbt(received))).toBe(vector.finalTxHex);
      expect(verifyFinalizedPsbt(received)).toEqual({ ok: true });
    });

    it(`signs ${vector.name} here, refuses to finalize it from signatures alone, and takes the items`, () => {
      let psbt = prepared();
      if (vector.signatureAt >= 0) {
        alice.signScriptPathInput(psbt, 0, { index: 40, leafHash: tree.leaves[0]!.leafHash, trustPrevouts: true });
      }
      psbt = sent(psbt);
      const refused = error(() => finalizePsbt(psbt));
      expect(refused).toBeInstanceOf(SigningError);
      expect(refused.code).toBe('WITNESS_ITEMS_NEEDED');
      expect(refused.message).toContain('finalizeScriptPathInput(psbt, 0, { stack })');
      expect(refused.cause).toBeInstanceOf(ScriptRejectedError);
      const unfinished = error(() => verifyFinalizedPsbt(psbt));
      expect(unfinished).toBeInstanceOf(SigningError);
      expect(unfinished.code).toBe('INPUT_NOT_FINALIZED');
      expect(psbt.data.inputs[0]!.finalScriptWitness).toBeUndefined();

      finalizeScriptPathInput(psbt, 0, {
        stack: (signatureFor) => stack.map((item, i) => (i === vector.signatureAt ? signatureFor(signer) : item)),
      });
      const tx = finalizePsbt(sent(psbt));
      expect(transactionId(tx)).toBe(vector.txid);
      expect(tx.ins[0]!.witness.slice(-2).map(bytesToHex)).toEqual([vector.leafScript, vector.controlBlock]);
      expect(verifyFinalizedPsbt(psbt)).toEqual({ ok: true });
    });
  }
});

describe('finalizing a leaf with caller-supplied items', () => {
  for (const kind of kinds) {
    it(`co-signs a two-party hash lock on ${kind} across base64 round trips`, () => {
      const tree = assembleScriptTree([twoParty, checksigScript(B)]);
      const { leafHash } = tree.leaves[0]!;
      let { psbt } = spendOf(kind, tree, 0);
      psbt = sent(psbt);
      alice.signScriptPathInput(psbt, 0, { index: 0, leafHash });
      psbt = sent(psbt);
      bob.signScriptPathInput(psbt, 0, { index: 0, leafHash });
      psbt = sent(psbt);
      expect(error(() => finalizePsbt(psbt)).code).toBe('WITNESS_ITEMS_NEEDED');
      // B is checked last, so its signature is the deepest item.
      finalizeScriptPathInput(psbt, 0, { stack: (signatureFor) => [signatureFor(B), signatureFor(A), secret] });
      const tx = finalizePsbt(sent(psbt));
      expect(tx.ins[0]!.witness).toHaveLength(5);
      expect(verifyFinalizedPsbt(psbt)).toEqual({ ok: true });
    });

    it(`refuses a wrong preimage on ${kind} with the engine's code and writes nothing`, () => {
      const tree = assembleScriptTree([hashLock]);
      const { psbt } = spendOf(kind, tree, 0);
      alice.signScriptPathInput(psbt, 0, { index: 0, leafHash: tree.leaves[0]!.leafHash });
      const wrong = error(() =>
        finalizeScriptPathInput(psbt, 0, { stack: (signatureFor) => [signatureFor(A), new Uint8Array(14)] }),
      );
      expect(wrong).toBeInstanceOf(ScriptRejectedError);
      expect(wrong.code).toBe('SCRIPT_REJECTED');
      expect((wrong as ScriptRejectedError).scriptCode).toBe('ErrEqualVerify');
      expect((wrong as ScriptRejectedError).inputIndex).toBe(0);
      // The items in the wrong order hash the signature instead of the preimage.
      const swapped = error(() => finalizeScriptPathInput(psbt, 0, { stack: (signatureFor) => [secret, signatureFor(A)] }));
      expect((swapped as ScriptRejectedError).scriptCode).toBe('ErrEqualVerify');
      expect(psbt.data.inputs[0]!.finalScriptWitness).toBeUndefined();
      expect(() => psbt.extractTransaction()).toThrow();
    });

    it(`finalizes an OP_CAT leaf on ${kind} that has no signature at all`, () => {
      const tree = assembleScriptTree([catLeaf]);
      const { psbt } = spendOf(kind, tree, 0);
      const received = sent(psbt);
      expect(error(() => finalizePsbt(received)).code).toBe('WITNESS_ITEMS_NEEDED');
      expect((error(() => finalizeScriptPathInput(received, 0, { stack: [blob] })) as ScriptRejectedError).scriptCode).toBe(
        'ErrInvalidStackOperation',
      );
      finalizeScriptPathInput(received, 0, { stack: [blob.slice(0, 5), blob.slice(5)] });
      expect(finalizePsbt(received).ins[0]!.witness).toHaveLength(4);
      expect(verifyFinalizedPsbt(received)).toEqual({ ok: true });
    });

    it(`asks which leaf on ${kind} when several are listed and none is signed`, () => {
      const tree = assembleScriptTree([catLeaf, hashLock]);
      const { psbt } = spendOf(kind, tree, 0);
      const second = spendOf(kind, tree, 1).psbt.data.inputs[0]!.tapLeafScript!;
      psbt.updateInput(0, { tapLeafScript: second });
      const stack = [blob.slice(0, 5), blob.slice(5)];
      expect(error(() => finalizeScriptPathInput(psbt, 0, { stack })).message).toContain('pass leafHash');
      expect(error(() => finalizeScriptPathInput(psbt, 0, { stack, leafHash: tapLeafHash(checksigScript(A)) })).code).toBe(
        'INPUT_MISMATCH',
      );
      finalizeScriptPathInput(psbt, 0, { stack, leafHash: tree.leaves[0]!.leafHash });
      expect(verifyFinalizedPsbt(psbt)).toEqual({ ok: true });
    });

    it(`hands out only signatures that verify on ${kind}`, () => {
      const tree = assembleScriptTree([hashLock]);
      const { psbt } = spendOf(kind, tree, 0);
      const missing = error(() => finalizeScriptPathInput(psbt, 0, { stack: (signatureFor) => [signatureFor(A), secret] }));
      expect(missing.code).toBe('SIGNATURES_MISSING');
      const forged = new Uint8Array(64).fill(7);
      psbt.updateInput(0, { tapScriptSig: [{ pubkey: A, leafHash: tree.leaves[0]!.leafHash, signature: forged }] });
      expect(error(() => finalizeScriptPathInput(psbt, 0, { stack: [forged, secret] })).code).toBe('SIGNATURE_INVALID');
      expect(psbt.data.inputs[0]!.finalScriptWitness).toBeUndefined();
    });

    it(`gives signatureFor nothing made for another leaf or another key on ${kind}`, () => {
      const other = compileScript([OP_CODES.OP_SHA256, sha256(blob), OP_CODES.OP_EQUALVERIFY, A, OP_CODES.OP_CHECKSIG]);
      const tree = assembleScriptTree([hashLock, other]);
      const { psbt } = spendOf(kind, tree, 1);
      alice.signScriptPathInput(psbt, 0, { index: 0, leafHash: tree.leaves[1]!.leafHash });
      psbt.updateInput(0, { tapLeafScript: spendOf(kind, tree, 0).psbt.data.inputs[0]!.tapLeafScript! });
      // A signed the other leaf only.
      const wrongLeaf = error(() =>
        finalizeScriptPathInput(psbt, 0, { leafHash: tree.leaves[0]!.leafHash, stack: (signatureFor) => [signatureFor(A), secret] }),
      );
      expect(wrongLeaf.code).toBe('SIGNATURES_MISSING');
      // A signature filed under a key the leaf does not push is never looked at, so never handed out.
      psbt.updateInput(0, { tapScriptSig: [{ pubkey: B, leafHash: tree.leaves[1]!.leafHash, signature: new Uint8Array(64).fill(7) }] });
      const wrongKey = error(() =>
        finalizeScriptPathInput(psbt, 0, { leafHash: tree.leaves[1]!.leafHash, stack: (signatureFor) => [signatureFor(B), blob] }),
      );
      expect(wrongKey.code).toBe('SIGNATURES_MISSING');
      finalizeScriptPathInput(psbt, 0, { leafHash: tree.leaves[1]!.leafHash, stack: (signatureFor) => [signatureFor(A), blob] });
      expect(verifyFinalizedPsbt(psbt)).toEqual({ ok: true });
    });

    it(`still finalizes a timelocked checksig leaf on ${kind} from its signature, and refuses it while the lock holds`, () => {
      const tree = assembleScriptTree([csvScript(encodeSequence({ blocks: 144 }), checksigScript(A))]);
      const { leafHash } = tree.leaves[0]!;
      const mature = spendOf(kind, tree, 0, { sequence: 144 }).psbt;
      alice.signScriptPathInput(mature, 0, { index: 0, leafHash });
      expect(finalizePsbt(mature).ins[0]!.witness).toHaveLength(3);

      const early = spendOf(kind, tree, 0, { sequence: 10 }).psbt;
      alice.signScriptPathInput(early, 0, { index: 0, leafHash });
      const refused = error(() => finalizePsbt(early));
      expect((refused.cause as ScriptRejectedError).scriptCode).toBe('ErrUnsatisfiedLockTime');
      expect(early.data.inputs[0]!.finalScriptWitness).toBeUndefined();
    });
  }

  it('checks its arguments and the kind of input', () => {
    const tree = assembleScriptTree([catLeaf]);
    const { psbt } = spendOf('p2mr', tree, 0);
    expect(() => finalizeScriptPathInput(psbt, 1, { stack: [] })).toThrow(RangeError);
    expect(() => finalizeScriptPathInput(psbt, 0, { stack: 'aa' as unknown as Uint8Array[] })).toThrow(TypeError);
    finalizeScriptPathInput(psbt, 0, { stack: [blob.slice(0, 5), blob.slice(5)] });
    expect(error(() => finalizeScriptPathInput(psbt, 0, { stack: [] })).message).toContain('already finalized');

    const keyPath = parsePsbt(vectors.signing[0]!.signedPsbt);
    expect(error(() => finalizeScriptPathInput(keyPath, 0, { stack: [] })).code).toBe('INPUT_MISMATCH');
  });
});

describe('finalizePsbt refusals', () => {
  it('gives a typed error for an input with nothing to finalize it', () => {
    const bare = parsePsbt(vectors.signing[0]!.preparedPsbt);
    const refused = error(() => finalizePsbt(bare));
    expect(refused).toBeInstanceOf(SigningError);
    expect(refused.code).toBe('INPUT_NOT_FINALIZED');
    expect(refused.message).toContain('PSBT input 0');
  });

  it('refuses a key-path signature that does not verify', () => {
    const signed = parsePsbt(vectors.signing[0]!.signedPsbt);
    const forged = Uint8Array.from(signed.data.inputs[0]!.tapKeySig!);
    forged[5] = forged[5]! ^ 1;
    signed.data.inputs[0]!.tapKeySig = forged;
    const refused = error(() => finalizePsbt(signed));
    expect((refused as ScriptRejectedError).scriptCode).toBe('ErrTaprootSigInvalid');
  });

  it('leaves an input finalized with supplied items alone and finalizes the rest', () => {
    const tree = assembleScriptTree([hashLock]);
    const funding = createTransaction(2);
    addInputByTxid(funding, 'cc'.repeat(32), 0);
    funding.addOutput(p2mr({ merkleRoot: tree.root }).output, VALUE);
    funding.addOutput(toOutputScript(alice.deriveAddress(3), network), VALUE);
    const tx = createTransaction(2);
    addInputByTxid(tx, funding.getId(), 0);
    addInputByTxid(tx, funding.getId(), 1);
    tx.addOutput(toOutputScript(alice.deriveAddress(9), network), 2n * VALUE - 20_000n);
    const psbt = createPsbt(tx);
    prepareP2mrScriptPathInput(psbt, 0, { tree, leafIndex: 0, value: VALUE });
    alice.prepareInput(psbt, 1, { index: 3, value: VALUE });
    alice.signScriptPathInput(psbt, 0, { index: 0, leafHash: tree.leaves[0]!.leafHash });
    alice.signInput(psbt, 1);
    finalizeScriptPathInput(psbt, 0, { stack: (signatureFor) => [signatureFor(A), secret] });
    const received = sent(psbt);
    expect(finalizePsbt(received).ins.map((input) => input.witness.length)).toEqual([4, 1]);
    expect(verifyFinalizedPsbt(received)).toEqual({ ok: true });
  });
});
