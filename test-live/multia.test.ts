// Leaves built by multiAScript, spent through P2TR and P2MR outputs by PSBT
// and mined by a regtest pearld: thresholds written as a small-int opcode
// and, above 16, as a pushed number, with exactly the threshold signing and
// with a signature too many.

import { expect, it } from 'vitest';
import {
  assembleScriptTree,
  checkStandard,
  checksigScript,
  createPsbt,
  createTransaction,
  deriveSigningAccountFromSeed,
  estimateVsize,
  finalizePsbt,
  mnemonicToSeed,
  multiAScript,
  OP_CODES,
  p2mr,
  p2tr,
  parseMultiA,
  prepareP2mrScriptPathInput,
  prepareTaprootScriptPathInput,
} from '../src/index.js';
import type { SpendEstimate } from '../src/index.js';
import { addChange, broadcastAndConfirm, describeLive, fund, network, prevoutsOf, testMempoolAccept } from './chain.js';

const account = deriveSigningAccountFromSeed(
  mnemonicToSeed('army van defense carry jealous true garbage claim echo media make crunch'),
  network,
);
const internalPubkey = account.derivePublicKey(0, true);
const VALUE = 20_000_000n;

interface Case {
  /** Child indices of the leaf's keys, in script order. */
  keys: number[];
  threshold: number;
  /** Children that sign, in the order they sign. */
  signers: number[];
  viaP2mr: boolean;
}

/** Spends a tree of a checksig leaf and the multi_a leaf through the multi_a leaf and returns the witness stack before the script. */
async function spendMultiA({ keys, threshold, signers, viaP2mr }: Case): Promise<Uint8Array[]> {
  const leafScript = multiAScript(keys.map((i) => account.derivePublicKey(i)), threshold);
  expect(parseMultiA(leafScript)).toEqual({ keys: keys.map((i) => account.derivePublicKey(i)), threshold });
  const tree = assembleScriptTree([checksigScript(account.derivePublicKey(999)), leafScript]);
  const leaf = tree.leaves[1]!;
  const script = viaP2mr ? p2mr({ merkleRoot: tree.root }).output : p2tr({ internalPubkey, merkleRoot: tree.root }).output;
  const funding = await fund([{ script, value: VALUE }]);

  const tx = createTransaction(2);
  tx.addInput(funding.getHash(), 0);
  const spends: SpendEstimate[] = [{ type: 'scriptPath', tree, leafIndex: 1, p2mr: viaP2mr }];
  const estimate = addChange(tx, VALUE, spends);
  const psbt = createPsbt(tx);
  if (viaP2mr) prepareP2mrScriptPathInput(psbt, 0, { tree, leafIndex: 1, value: VALUE, previousTransaction: funding });
  else prepareTaprootScriptPathInput(psbt, 0, { internalPubkey, tree, leafIndex: 1, value: VALUE });
  for (const index of signers) account.signScriptPathInput(psbt, 0, { index, leafHash: leaf.leafHash });
  const signed = finalizePsbt(psbt);
  checkStandard(signed, { prevouts: prevoutsOf(signed, [funding]) });

  expect(await testMempoolAccept(signed)).toMatchObject({ allowed: true, vsize: estimate });
  const info = await broadcastAndConfirm(signed);
  expect(info.vsize).toBe(estimateVsize(signed, spends));
  const witness = signed.ins[0]!.witness;
  expect(witness[witness.length - 2]).toEqual(leafScript);
  return witness.slice(0, -2);
}

const sizes = (stack: Uint8Array[]): number[] => stack.map((item) => item.length);

describeLive('multiAScript leaves', () => {
  it('spends a 2-of-3 leaf through P2TR, signed by its first and third keys', async () => {
    // One item per key, last key first, empty for the key that did not sign.
    expect(sizes(await spendMultiA({ keys: [1, 2, 3], threshold: 2, signers: [3, 1], viaP2mr: false }))).toEqual([64, 0, 64]);
  });

  it('spends a 2-of-3 leaf through P2TR when all three sign, leaving the third signature out', async () => {
    expect(sizes(await spendMultiA({ keys: [4, 5, 6], threshold: 2, signers: [4, 5, 6], viaP2mr: false }))).toEqual([0, 64, 64]);
  });

  it('spends a 3-of-5 leaf through P2MR, signed by its second, fourth and fifth keys', async () => {
    const stack = await spendMultiA({ keys: [7, 8, 9, 10, 11], threshold: 3, signers: [8, 10, 11], viaP2mr: true });
    expect(sizes(stack)).toEqual([64, 64, 0, 64, 0]);
  });

  it('spends a 1-of-1 leaf through P2MR', async () => {
    expect(sizes(await spendMultiA({ keys: [12], threshold: 1, signers: [12], viaP2mr: true }))).toEqual([64]);
  });

  it('spends 17-of-18 leaves, whose threshold is a pushed number, through P2TR and P2MR', async () => {
    const keys = Array.from({ length: 18 }, (_, i) => 20 + i);
    const script = multiAScript(keys.map((i) => account.derivePublicKey(i)), 17);
    // <17> as a one-byte push, then OP_NUMEQUAL: there is no small-int opcode above 16.
    expect([...script.slice(-3)]).toEqual([1, 17, OP_CODES.OP_NUMEQUAL]);
    for (const viaP2mr of [false, true]) {
      const stack = await spendMultiA({ keys, threshold: 17, signers: keys.slice(1), viaP2mr });
      expect(sizes(stack)).toEqual([...Array<number>(17).fill(64), 0]);
    }
  });
});
