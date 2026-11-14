// P2MR spends through XMSS leaves against spends Pearl's script engine
// accepted, plus the one-time index rules of the XMSS signer.

import { describe, expect, it } from 'vitest';
import {
  assembleScriptTree,
  createMemoryXmssIndexStore,
  createTransaction,
  createXmssSigner,
  p2mr,
  p2mrControlBlock,
  parseTransaction,
  serializeTransaction,
  signXmssP2mrInput,
  tapscriptSighash,
  transactionId,
  xmssKeygen,
  xmssLeafScript,
} from '../src/index.js';
import type { XmssIndexStore } from '../src/index.js';
import vectors from '../vectors/pearl-go.json' with { type: 'json' };
import mainnetSpend from './fixtures/pr111-mainnet-xmss-spend.json' with { type: 'json' };
import { bytesToHex, hexToBytes } from './vector-helpers.js';

function keyVector(name: string) {
  return vectors.xmss.keys.find((item) => item.name === name)!;
}

/** A store that hands out one fixed index, so signatures match the vectors. */
function fixedStore(index: number): XmssIndexStore & { calls: number } {
  return {
    calls: 0,
    reserve() {
      this.calls += 1;
      return index;
    },
  };
}

function prevoutsOf(expected: { prevouts: { script: string; value: number }[] }) {
  return expected.prevouts.map((p) => ({ script: hexToBytes(p.script), value: BigInt(p.value) }));
}

describe('P2MR spends through XMSS leaves', () => {
  for (const expected of vectors.xmss.spends) {
    it(`matches Go for ${expected.name}`, async () => {
      const key = keyVector(expected.key);
      const store = fixedStore(expected.msgUid);
      const signer = createXmssSigner(hexToBytes(key.privateSeed), hexToBytes(key.publicSeed), store);
      expect(bytesToHex(xmssLeafScript(signer.publicKey))).toBe(expected.leafScripts[0]);

      const tree = assembleScriptTree(expected.leafScripts.map(hexToBytes));
      expect(bytesToHex(p2mrControlBlock(tree, expected.leafIndex))).toBe(expected.controlBlock);

      const tx = parseTransaction(expected.unsignedTxHex);
      const prevouts = prevoutsOf(expected);
      const leafHash = tree.leaves[expected.leafIndex]!.leafHash;
      expect(bytesToHex(tapscriptSighash(tx, expected.inputIndex, prevouts, leafHash))).toBe(expected.sighash);

      await signXmssP2mrInput(tx, expected.inputIndex, signer, {
        prevouts,
        tree,
        leafIndex: expected.leafIndex,
        trustPrevouts: true, // vector prevouts point at synthetic transactions
      });
      expect(store.calls).toBe(1);
      const witness = tx.ins[expected.inputIndex]!.witness;
      expect(witness).toHaveLength(7);
      expect(bytesToHex(Uint8Array.from(witness.slice(0, 5).flatMap((chunk) => [...chunk])))).toBe(
        expected.signature,
      );

      const goTx = parseTransaction(expected.finalTxHex);
      goTx.ins.forEach((input, index) => {
        if (index !== expected.inputIndex) tx.setWitness(index, input.witness);
      });
      expect(serializeTransaction(tx)).toBe(expected.finalTxHex);
      expect(transactionId(tx)).toBe(expected.txid);
    });
  }

  it('refuses an all-P2MR XMSS spend without previous transactions', async () => {
    const expected = vectors.xmss.spends.find((item) => item.name === 'p2mr-xmss-single-leaf')!;
    const key = keyVector(expected.key);
    const store = fixedStore(5);
    const signer = createXmssSigner(hexToBytes(key.privateSeed), hexToBytes(key.publicSeed), store);
    const tree = assembleScriptTree(expected.leafScripts.map(hexToBytes));
    const tx = parseTransaction(expected.unsignedTxHex);
    await expect(
      signXmssP2mrInput(tx, 0, signer, { prevouts: prevoutsOf(expected), tree, leafIndex: 0 }),
    ).rejects.toThrow('previous transactions');
    expect(store.calls).toBe(0);
  });

  it('refuses a leaf that is not the signer key', async () => {
    const expected = vectors.xmss.spends.find((item) => item.name === 'p2mr-xmss-with-schnorr-leaf')!;
    const other = keyVector('a');
    const signer = createXmssSigner(hexToBytes(other.privateSeed), hexToBytes(other.publicSeed), fixedStore(0));
    const tree = assembleScriptTree(expected.leafScripts.map(hexToBytes));
    const tx = parseTransaction(expected.unsignedTxHex);
    await expect(
      signXmssP2mrInput(tx, 0, signer, { prevouts: prevoutsOf(expected), tree, leafIndex: 0, trustPrevouts: true }),
    ).rejects.toThrow('not the XMSS leaf of the signer key');
  });
});

describe('XMSS signer indices', () => {
  const key = keyVector('c');
  const seeds = [hexToBytes(key.privateSeed), hexToBytes(key.publicSeed)] as const;
  const message = new Uint8Array(32).fill(7);

  it('takes a new index from the store for every signature', async () => {
    const signer = createXmssSigner(...seeds, createMemoryXmssIndexStore());
    const first = await signer.sign(message);
    const second = await signer.sign(message);
    expect(bytesToHex(first.slice(0, 4))).toBe('00000000');
    expect(bytesToHex(second.slice(0, 4))).toBe('00000001');
  });

  it('refuses once the key has used its 31 signatures', async () => {
    const signer = createXmssSigner(...seeds, fixedStore(31));
    await expect(signer.sign(message)).rejects.toThrow('used all 31 of its signatures');
  });

  it('refuses an index the store did not reserve properly', async () => {
    const signer = createXmssSigner(...seeds, fixedStore(-1));
    await expect(signer.sign(message)).rejects.toThrow('index store returned -1');
  });
});

describe('pearl-research-labs/pearl#111 mainnet spend', () => {
  it('rebuilds the recorded mainnet transaction byte for byte', async () => {
    const recorded = mainnetSpend;
    const keyA = createXmssSigner(
      hexToBytes(recorded.seedA.privateSeed),
      hexToBytes(recorded.seedA.publicSeed),
      fixedStore(recorded.msgUid),
    );
    const keyB = xmssKeygen(hexToBytes(recorded.seedB.privateSeed), hexToBytes(recorded.seedB.publicSeed));
    const treeA = assembleScriptTree([xmssLeafScript(keyA.publicKey)]);
    const treeB = assembleScriptTree([xmssLeafScript(keyB.publicKey)]);
    const scriptA = p2mr({ merkleRoot: treeA.root }).output;
    const scriptB = p2mr({ merkleRoot: treeB.root }).output;

    // xmsstxn.BuildSpend: version 2, one final-sequence input, one output.
    const tx = createTransaction(2);
    tx.addInput(hexToBytes(recorded.fundingTxid).reverse(), recorded.fundingVout, 0xffffffff);
    tx.addOutput(scriptB, BigInt(recorded.fundingValue - recorded.fee));
    await signXmssP2mrInput(tx, 0, keyA, {
      prevouts: [{ script: scriptA, value: BigInt(recorded.fundingValue) }],
      tree: treeA,
      leafIndex: 0,
      trustPrevouts: true, // the funding transaction itself is not in the fixture
    });

    expect(serializeTransaction(tx)).toBe(recorded.spendTxHex);
    expect(transactionId(tx)).toBe(recorded.spendTxid);
  });
});
