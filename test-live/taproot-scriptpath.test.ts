// P2TR script-path spends through PSBT, a checksig leaf and a 2-of-3
// multi_a leaf, accepted and mined by a regtest pearld.

import { expect, it } from 'vitest';
import {
  assembleScriptTree,
  checkStandard,
  checksigScript,
  compileScript,
  createPsbt,
  createTransaction,
  deriveSigningAccountFromSeed,
  estimateVsize,
  finalizePsbt,
  mnemonicToSeed,
  OP_CODES,
  p2tr,
  prepareTaprootScriptPathInput,
} from '../src/index.js';
import type { ScriptTree, SpendEstimate } from '../src/index.js';
import { addChange, broadcastAndConfirm, describeLive, fund, network, prevoutsOf, testMempoolAccept } from './chain.js';

const account = deriveSigningAccountFromSeed(mnemonicToSeed('zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong'), network);
const internalPubkey = account.derivePublicKey(0, true);
const VALUE = 20_000_000n;

async function spendLeaf(tree: ScriptTree, leafIndex: number, signers: number[]): Promise<void> {
  const script = p2tr({ internalPubkey, merkleRoot: tree.root }).output;
  const funding = await fund([{ script, value: VALUE }]);

  const tx = createTransaction(2);
  tx.addInput(funding.getHash(), 0);
  const spends: SpendEstimate[] = [{ type: 'scriptPath', tree, leafIndex, p2mr: false }];
  const estimate = addChange(tx, VALUE, spends);

  const psbt = createPsbt(tx);
  prepareTaprootScriptPathInput(psbt, 0, { internalPubkey, tree, leafIndex, value: VALUE });
  for (const index of signers) {
    account.signScriptPathInput(psbt, 0, { index, leafHash: tree.leaves[leafIndex]!.leafHash });
  }
  const signed = finalizePsbt(psbt);
  checkStandard(signed, { prevouts: prevoutsOf(signed, [funding]) });

  expect(await testMempoolAccept(signed)).toMatchObject({ allowed: true, vsize: estimate });
  const info = await broadcastAndConfirm(signed);
  expect(info.vsize).toBe(estimateVsize(signed, spends));
}

describeLive('P2TR script path', () => {
  it('spends the third checksig leaf of a three-leaf tree', async () => {
    const tree = assembleScriptTree([20, 21, 22].map((i) => checksigScript(account.derivePublicKey(i))));
    await spendLeaf(tree, 2, [22]);
  });

  it('spends a 2-of-3 multi_a leaf signed by its first and last keys through PSBT', async () => {
    const [a, b, c] = [30, 31, 32].map((i) => account.derivePublicKey(i));
    const multiA = compileScript([
      a!,
      OP_CODES.OP_CHECKSIG,
      b!,
      OP_CODES.OP_CHECKSIGADD,
      c!,
      OP_CODES.OP_CHECKSIGADD,
      OP_CODES.OP_2,
      OP_CODES.OP_NUMEQUAL,
    ]);
    const tree = assembleScriptTree([checksigScript(account.derivePublicKey(33)), multiA]);
    await spendLeaf(tree, 1, [30, 32]);
  });
});
