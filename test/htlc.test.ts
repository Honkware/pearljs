// Hash timelock leaves against Pearl's script engine (vectors.htlcs: claim and
// refund spends of two-leaf trees in P2TR and P2MR outputs, with the engine's
// verdict on each), and spends pearljs builds through finalizeScriptPathInput
// checked by the interpreter.

import * as ecc from 'tiny-secp256k1';
import { describe, expect, it } from 'vitest';
import {
  addInputByTxid,
  assembleScriptTree,
  checksigScript,
  createPsbt,
  createTransaction,
  deriveSigningAccountFromSeed,
  encodeAddress,
  encodeSequence,
  estimateVsize,
  extractHtlcPreimage,
  finalizePsbt,
  finalizeScriptPathInput,
  hashlockScript,
  htlcLeaves,
  htlcStack,
  htlcStackSizes,
  multiAScript,
  networks,
  p2mr,
  p2tr,
  parseHtlcLeaf,
  parseTransaction,
  prepareP2mrScriptPathInput,
  prepareTaprootScriptPathInput,
  sha256,
  hash160,
  tapscriptSighash,
  toOutputScript,
  verifyInput,
} from '../src/index.js';
import type { HtlcTimelock, ScriptTree } from '../src/index.js';
import vectors from '../vectors/pearl-go.json' with { type: 'json' };
import { bytesToHex, hexToBytes } from './vector-helpers.js';

const network = networks.mainnet;
const account = deriveSigningAccountFromSeed(hexToBytes(vectors.bip86.seed), network);
const [first] = vectors.htlcs;
const CLAIM = first!.claimKey;
const REFUND = first!.refundKey;
const preimage = hexToBytes(first!.preimage);
const internalPubkey = hexToBytes(first!.internalPubKey);
const timelockOf = (lock: string, value: number): HtlcTimelock => (lock === 'cltv' ? { locktime: value } : { sequence: value });

describe('htlcLeaves', () => {
  for (const expected of vectors.htlcs.filter((item) => item.name.endsWith('-claim'))) {
    it(`builds the leaves and output Pearl spent for ${expected.name.replace(/-claim$/, '')}`, () => {
      const { claim, refund } = htlcLeaves({
        hash: hexToBytes(expected.hash),
        claimKey: account.derivePublicKey(expected.claimKey),
        refundKey: account.derivePublicKey(expected.refundKey),
        timelock: timelockOf(expected.lock, expected.lockValue),
      });
      expect(bytesToHex(claim)).toBe(expected.claimLeaf);
      expect(bytesToHex(refund)).toBe(expected.refundLeaf);
      const tree = assembleScriptTree([claim, refund]);
      expect(bytesToHex(tree.root)).toBe(expected.root);
      const output = expected.container === 'p2tr' ? p2tr({ internalPubkey, merkleRoot: tree.root }).output : p2mr({ merkleRoot: tree.root }).output;
      expect(bytesToHex(output)).toBe(expected.prevScript);
      expect(encodeAddress({ version: output[0] === 0x51 ? 1 : 2, program: output.subarray(2) }, network)).toBe(expected.address);
      expect(parseHtlcLeaf(claim)).toEqual({
        kind: 'claim',
        hashType: expected.hashType,
        hash: hexToBytes(expected.hash),
        key: account.derivePublicKey(expected.claimKey),
      });
      expect(parseHtlcLeaf(refund)).toEqual({ kind: 'refund', timelock: timelockOf(expected.lock, expected.lockValue), key: account.derivePublicKey(expected.refundKey) });
    });
  }

  it('hashes with SHA-256 for a 32-byte hash and HASH160 for a 20-byte one, and refuses other lengths', () => {
    expect(bytesToHex(sha256(preimage))).toBe(vectors.htlcs.find((item) => item.hashType === 'sha256')!.hash);
    expect(bytesToHex(hash160(preimage))).toBe(vectors.htlcs.find((item) => item.hashType === 'hash160')!.hash);
    expect(() => hashlockScript(new Uint8Array(31), checksigScript(account.derivePublicKey(1)))).toThrow('hash must be a 32-byte SHA-256 or a 20-byte HASH160');
    const key = account.derivePublicKey(1);
    expect(() => htlcLeaves({ hash: sha256(preimage), claimKey: key.subarray(1), refundKey: key, timelock: { locktime: 1 } })).toThrow('claimKey must be a 32-byte x-only key');
    expect(() => htlcLeaves({ hash: sha256(preimage), claimKey: key, refundKey: key, timelock: { sequence: 0x10000 } })).toThrow(RangeError);
    expect(() => htlcLeaves({ hash: sha256(preimage), claimKey: key, refundKey: key, timelock: {} as HtlcTimelock })).toThrow(TypeError);
  });

  it('reads back only the leaves it builds', () => {
    const key = account.derivePublicKey(1);
    expect(parseHtlcLeaf(checksigScript(key))).toBeNull();
    expect(parseHtlcLeaf(multiAScript([key, account.derivePublicKey(2)], 1))).toBeNull();
    expect(parseHtlcLeaf(hashlockScript(sha256(preimage), multiAScript([key, account.derivePublicKey(2)], 1)))).toBeNull();
    // A lock written with more bytes than it needs is not one htlcLeaves writes.
    expect(parseHtlcLeaf(Uint8Array.from([2, 10, 0, 0xb1, 0x75, 32, ...key, 0xac]))).toBeNull();
    expect(parseHtlcLeaf(Uint8Array.from([0x5a, 0xb1, 0x75, 32, ...key, 0xac]))).toEqual({ kind: 'refund', timelock: { locktime: 10 }, key });
    expect(parseHtlcLeaf(Uint8Array.from([0x4c]))).toBeNull();
  });
});

describe("Pearl's verdicts on HTLC spends", () => {
  for (const expected of vectors.htlcs) {
    it(`${expected.error === '' ? 'accepts' : 'refuses'} ${expected.name} as Pearl's engine does`, () => {
      const tx = parseTransaction(expected.spendTxHex);
      const result = verifyInput(tx, 0, [{ script: hexToBytes(expected.prevScript), value: BigInt(expected.value) }]);
      if (expected.error === '') expect(result).toEqual({ ok: true });
      else expect(result).toMatchObject({ ok: false, message: expected.error });
    });
  }

  it("computes Pearl's sighash for each leaf, and signs over it with the leaf's key", () => {
    for (const expected of vectors.htlcs.filter((item) => item.name.endsWith('-claim') || item.name.endsWith('-refund'))) {
      const tx = parseTransaction(expected.unsignedTxHex);
      const leaf = hexToBytes(expected.leafIndex === 0 ? expected.claimLeaf : expected.refundLeaf);
      const tree = assembleScriptTree([hexToBytes(expected.claimLeaf), hexToBytes(expected.refundLeaf)]);
      const hash = tapscriptSighash(tx, 0, {
        prevouts: [{ script: hexToBytes(expected.prevScript), value: BigInt(expected.value) }],
        leafHash: tree.leaves[expected.leafIndex]!.leafHash,
      });
      expect(bytesToHex(hash)).toBe(expected.sighash);
      const parsed = parseHtlcLeaf(leaf)!;
      const signature = account.tapscriptSigner({ index: expected.leafIndex === 0 ? CLAIM : REFUND }).signSchnorr(hash);
      expect(ecc.verifySchnorr(hash, parsed.key, signature)).toBe(true);
    }
  });

  it("finds the preimage in Pearl's claims and not in its refunds", () => {
    for (const expected of vectors.htlcs.filter((item) => item.error === '')) {
      const found = extractHtlcPreimage(parseTransaction(expected.spendTxHex), hexToBytes(expected.hash));
      if (expected.leafIndex === 0) expect(found).toEqual({ preimage, inputIndex: 0 });
      else expect(found).toBeNull();
    }
    const claim = parseTransaction(vectors.htlcs.find((item) => item.name === 'p2tr-cltv-sha256-claim')!.spendTxHex);
    expect(extractHtlcPreimage(claim, sha256(new Uint8Array(32)))).toBeNull();
    expect(() => extractHtlcPreimage(claim, new Uint8Array(31))).toThrow('hash must be');
  });
});

interface Contract {
  tree: ScriptTree;
  output: Uint8Array;
  viaP2mr: boolean;
  timelock: HtlcTimelock;
}

function contract(viaP2mr: boolean, timelock: HtlcTimelock): Contract {
  const { claim, refund } = htlcLeaves({ hash: sha256(preimage), claimKey: account.derivePublicKey(CLAIM), refundKey: account.derivePublicKey(REFUND), timelock });
  const tree = assembleScriptTree([claim, refund]);
  const output = viaP2mr ? p2mr({ merkleRoot: tree.root }).output : p2tr({ internalPubkey, merkleRoot: tree.root }).output;
  return { tree, output, viaP2mr, timelock };
}

/** Spends the contract through a leaf, signed by the child at `signer`, finalized with htlcStack. */
function spendThrough(c: Contract, leafIndex: number, fields: { locktime?: number; sequence?: number; signer?: number; preimage?: Uint8Array }) {
  const value = 50_000_000n;
  const funding = createTransaction(2);
  addInputByTxid(funding, 'cc'.repeat(32), 0);
  funding.addOutput(c.output, value);
  const tx = createTransaction(2);
  tx.locktime = fields.locktime ?? 0;
  addInputByTxid(tx, funding.getId(), 0, fields.sequence ?? 0xffffffff);
  tx.addOutput(toOutputScript(account.deriveAddress(9), network), value - 5_000n);
  const psbt = createPsbt(tx);
  if (c.viaP2mr) prepareP2mrScriptPathInput(psbt, 0, { tree: c.tree, leafIndex, value, previousTransaction: funding });
  else prepareTaprootScriptPathInput(psbt, 0, { internalPubkey, tree: c.tree, leafIndex, value });
  const leaf = c.tree.leaves[leafIndex]!;
  account.signScriptPathInput(psbt, 0, { index: fields.signer ?? (leafIndex === 0 ? CLAIM : REFUND), leafHash: leaf.leafHash });
  return {
    psbt,
    prevouts: [{ script: c.output, value }],
    finish: () => {
      finalizeScriptPathInput(psbt, 0, { stack: htlcStack(leaf.script, fields.preimage === undefined ? {} : { preimage: fields.preimage }) });
      return finalizePsbt(psbt);
    },
  };
}

describe('spending HTLC leaves through finalizeScriptPathInput', () => {
  for (const viaP2mr of [false, true]) {
    for (const timelock of [{ locktime: 800_000 }, { sequence: encodeSequence({ blocks: 144 }) }] as HtlcTimelock[]) {
      const label = `${viaP2mr ? 'P2MR' : 'P2TR'} ${'locktime' in timelock ? 'CLTV' : 'CSV'}`;

      it(`claims a ${label} contract with the preimage, at the size htlcStackSizes predicts`, () => {
        const c = contract(viaP2mr, timelock);
        const spend = spendThrough(c, 0, { preimage });
        const tx = spend.finish();
        expect(verifyInput(tx, 0, spend.prevouts)).toEqual({ ok: true });
        expect(tx.ins[0]!.witness.map((item) => item.length).slice(0, 2)).toEqual([64, 32]);
        const estimate = estimateVsize(tx, [{ type: 'scriptPath', tree: c.tree, leafIndex: 0, p2mr: viaP2mr, stack: htlcStackSizes(c.tree.leaves[0]!.script) }]);
        expect(estimate).toBe(tx.virtualSize());
        expect(extractHtlcPreimage(tx, sha256(preimage))).toEqual({ preimage, inputIndex: 0 });
      });

      it(`refunds a ${label} contract once the lock is met, and not before`, () => {
        const c = contract(viaP2mr, timelock);
        const met = 'locktime' in timelock ? { locktime: timelock.locktime, sequence: 0xfffffffe } : { sequence: timelock.sequence };
        const spend = spendThrough(c, 1, met);
        const tx = spend.finish();
        expect(verifyInput(tx, 0, spend.prevouts)).toEqual({ ok: true });
        expect(estimateVsize(tx, [{ type: 'scriptPath', tree: c.tree, leafIndex: 1, p2mr: viaP2mr, stack: htlcStackSizes(c.tree.leaves[1]!.script) }])).toBe(tx.virtualSize());

        const early = 'locktime' in timelock ? { locktime: timelock.locktime - 1, sequence: 0xfffffffe } : { sequence: timelock.sequence - 1 };
        expect(() => spendThrough(c, 1, early).finish()).toThrow(expect.objectContaining({ scriptCode: 'ErrUnsatisfiedLockTime' }));
      });

      it(`refuses a ${label} spend without the right preimage or by the other key`, () => {
        const c = contract(viaP2mr, timelock);
        const wrong = Uint8Array.from(preimage);
        wrong[0]! ^= 1;
        expect(() => spendThrough(c, 0, { preimage: wrong }).finish()).toThrow(expect.objectContaining({ code: 'PREIMAGE_INVALID' }));
        expect(() => spendThrough(c, 0, {}).finish()).toThrow(expect.objectContaining({ code: 'PREIMAGE_INVALID' }));
        expect(() => spendThrough(c, 0, { preimage: Uint8Array.of(...preimage, 0) }).finish()).toThrow(expect.objectContaining({ code: 'PREIMAGE_INVALID' }));
        // The other party's key is not in the leaf, so its signer refuses.
        expect(() => spendThrough(c, 0, { preimage, signer: REFUND })).toThrow('the leaf script does not contain the signer key');
        expect(() => spendThrough(c, 1, { ...('locktime' in timelock ? { locktime: timelock.locktime, sequence: 0 } : { sequence: timelock.sequence }), signer: CLAIM })).toThrow(
          'the leaf script does not contain the signer key',
        );
      });
    }
  }

  it('sizes a signature with a sighash byte at 65 bytes, and refuses to size other leaves', () => {
    const c = contract(false, { locktime: 10 });
    expect(htlcStackSizes(c.tree.leaves[0]!.script, 1)).toEqual([65, 32]);
    expect(htlcStackSizes(c.tree.leaves[1]!.script)).toEqual([64]);
    expect(() => htlcStackSizes(checksigScript(account.derivePublicKey(1)))).toThrow('not an HTLC claim or refund leaf');
  });
});
