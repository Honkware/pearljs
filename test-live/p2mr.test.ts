// P2MR spends through Schnorr checksig leaves, signed on the transaction by
// pearljs and mined by a regtest pearld: a single-leaf tree, a multi-leaf
// tree, and a P2MR input next to a P2TR key-path input.

import { expect, it } from 'vitest';
import {
  assembleScriptTree,
  checkStandard,
  checksigScript,
  createPsbt,
  createTransaction,
  deriveSigningAccountFromSeed,
  estimateVsize,
  mnemonicToSeed,
  p2mr,
  toOutputScript,
} from '../src/index.js';
import type { SpendEstimate, Transaction } from '../src/index.js';
import { addChange, broadcastAndConfirm, describeLive, fund, network, prevoutsOf, testMempoolAccept } from './chain.js';

const account = deriveSigningAccountFromSeed(mnemonicToSeed('zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong'), network);
const VALUE = 20_000_000n;

async function accept(signed: Transaction, funding: Transaction, spends: SpendEstimate[], estimate: number): Promise<void> {
  checkStandard(signed, { prevouts: prevoutsOf(signed, [funding]) });
  expect(await testMempoolAccept(signed)).toMatchObject({ allowed: true, vsize: estimate });
  const info = await broadcastAndConfirm(signed);
  expect(info.vsize).toBe(estimateVsize(signed, spends));
}

async function spendP2mrLeaf(keys: number[], leafIndex: number): Promise<void> {
  const tree = assembleScriptTree(keys.map((i) => checksigScript(account.derivePublicKey(i))));
  const script = p2mr({ merkleRoot: tree.root }).output;
  const funding = await fund([{ script, value: VALUE }]);

  const tx = createTransaction(2);
  tx.addInput(funding.getHash(), 0);
  const spends: SpendEstimate[] = [{ type: 'scriptPath', tree, leafIndex, p2mr: true }];
  const estimate = addChange(tx, VALUE, spends);
  account.signP2mrInput(tx, 0, {
    index: keys[leafIndex]!,
    prevouts: prevoutsOf(tx, [funding]),
    tree,
    leafIndex,
    previousTransactions: [funding],
  });
  await accept(tx, funding, spends, estimate);
}

describeLive('P2MR Schnorr leaves', () => {
  it('spends a single-leaf P2MR output', async () => {
    await spendP2mrLeaf([40], 0);
  });

  it('spends the second leaf of a four-leaf P2MR tree', async () => {
    await spendP2mrLeaf([41, 42, 43, 44], 1);
  });

  it('spends a P2MR input and a P2TR key-path input together', async () => {
    const tree = assembleScriptTree([45, 46, 47].map((i) => checksigScript(account.derivePublicKey(i))));
    const funding = await fund([
      { script: p2mr({ merkleRoot: tree.root }).output, value: VALUE },
      { script: toOutputScript(account.deriveAddress(48), network), value: VALUE },
    ]);

    const tx = createTransaction(2);
    tx.addInput(funding.getHash(), 0);
    tx.addInput(funding.getHash(), 1);
    const spends: SpendEstimate[] = [{ type: 'scriptPath', tree, leafIndex: 2, p2mr: true }, { type: 'keyPath' }];
    const estimate = addChange(tx, 2n * VALUE, spends);
    const prevouts = prevoutsOf(tx, [funding]);

    // The key-path signature comes from a PSBT; pearljs keeps P2MR inputs out
    // of PSBTs, so that one carries only its witness UTXO.
    const psbt = createPsbt(tx);
    psbt.updateInput(0, { witnessUtxo: prevouts[0]! });
    account.prepareInput(psbt, 1, { index: 48, value: VALUE });
    account.signInput(psbt, 1, { index: 48 });
    tx.setWitness(1, [psbt.data.inputs[1]!.tapKeySig!]);

    account.signP2mrInput(tx, 0, { index: 47, prevouts, tree, leafIndex: 2, previousTransactions: [funding] });
    await accept(tx, funding, spends, estimate);
  });
});
