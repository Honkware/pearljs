// P2MR script-path spends built through PSBT: prepared, signed and finalized
// by pearljs, then accepted and mined by a regtest pearld. A single checksig
// leaf, a leaf of a larger tree, and a 2-of-3 multi_a leaf.

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
  p2mr,
  p2mrControlBlock,
  parsePsbt,
  prepareP2mrScriptPathInput,
} from '../../src/index.js';
import type { ScriptTree, SpendEstimate } from '../../src/index.js';
import { addChange, broadcastAndConfirm, describeLive, fund, network, prevoutsOf, testMempoolAccept } from './chain.js';

const account = deriveSigningAccountFromSeed(mnemonicToSeed('zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong'), network);
const VALUE = 20_000_000n;

async function spendLeaf(tree: ScriptTree, leafIndex: number, signers: number[]): Promise<void> {
  const funding = await fund([{ script: p2mr({ merkleRoot: tree.root }).output, value: VALUE }]);
  const leaf = tree.leaves[leafIndex]!;

  const tx = createTransaction(2);
  tx.addInput(funding.getHash(), 0);
  const spends: SpendEstimate[] = [{ type: 'scriptPath', tree, leafIndex, p2mr: true }];
  const estimate = addChange(tx, VALUE, spends);

  let psbt = createPsbt(tx);
  prepareP2mrScriptPathInput(psbt, 0, { tree, leafIndex, value: VALUE, previousTransaction: funding });
  for (const index of signers) {
    // Each signer gets the PSBT as it travels: serialized and parsed again.
    psbt = parsePsbt(psbt.toBase64());
    account.signScriptPathInput(psbt, 0, { index, leafHash: leaf.leafHash });
  }
  const signed = finalizePsbt(psbt);
  expect(signed.ins[0]!.witness.slice(-2)).toEqual([leaf.script, p2mrControlBlock(tree, leafIndex)]);
  checkStandard(signed, { prevouts: prevoutsOf(signed, [funding]) });

  expect(await testMempoolAccept(signed)).toMatchObject({ allowed: true, vsize: estimate });
  const info = await broadcastAndConfirm(signed);
  expect(info.vsize).toBe(estimateVsize(signed, spends));
}

describeLive('P2MR script path through PSBT', () => {
  it('spends a single-leaf P2MR output', async () => {
    await spendLeaf(assembleScriptTree([checksigScript(account.derivePublicKey(70))]), 0, [70]);
  });

  it('spends the fourth leaf of a five-leaf P2MR tree', async () => {
    const tree = assembleScriptTree([71, 72, 73, 74, 75].map((i) => checksigScript(account.derivePublicKey(i))));
    await spendLeaf(tree, 3, [74]);
  });

  it('spends a 2-of-3 multi_a leaf signed by its second and third keys', async () => {
    const [a, b, c] = [76, 77, 78].map((i) => account.derivePublicKey(i));
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
    await spendLeaf(assembleScriptTree([multiA, checksigScript(account.derivePublicKey(79))]), 0, [77, 78]);
  });
});
