// The async signers, as a hardware wallet would be driven, producing spends a
// regtest pearld mines: a P2TR script path and a P2MR script path through
// PSBT, a P2MR checksig leaf signed on the transaction, and a hand-built
// 2-of-2 leaf signed with signTapscriptUncheckedAsync.

import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import * as ecc from 'tiny-secp256k1';
import {
  assembleScriptTree,
  checkStandard,
  checksigScript,
  compileScript,
  createPsbt,
  createTransaction,
  finalizePsbt,
  OP_CODES,
  p2mr,
  p2mrControlBlock,
  p2tr,
  prepareP2mrScriptPathInput,
  prepareTaprootScriptPathInput,
  scriptPathWitness,
  signP2mrInputAsync,
  signP2mrScriptPathInputAsync,
  signTaprootScriptPathInputAsync,
  signTapscriptUncheckedAsync,
} from '../src/index.js';
import type { SpendEstimate, TapscriptSignerAsync, Transaction } from '../src/index.js';
import { addChange, broadcastAllAndConfirm, describeLive, fund, prevoutsOf, testMempoolAccept } from './chain.js';

const VALUE = 20_000_000n;

/** A signer that answers on a later tick and counts how often it was asked. */
function device(): TapscriptSignerAsync & { calls: number } {
  let key: Uint8Array;
  do key = Uint8Array.from(randomBytes(32));
  while (!ecc.isPrivate(key));
  return {
    calls: 0,
    publicKey: ecc.xOnlyPointFromScalar(key),
    async signSchnorr(hash: Uint8Array) {
      this.calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return ecc.signSchnorr(hash, key);
    },
  };
}

describeLive('async signers', () => {
  it('sign P2TR and P2MR script paths that pearld mines', async () => {
    const [a, b, c, d, e] = [device(), device(), device(), device(), device()];
    const trTree = assembleScriptTree([checksigScript(a.publicKey), checksigScript(b.publicKey)]);
    const mrTree = assembleScriptTree([checksigScript(b.publicKey), checksigScript(c.publicKey)]);
    const both = compileScript([
      d.publicKey,
      OP_CODES.OP_CHECKSIGVERIFY,
      e.publicKey,
      OP_CODES.OP_CHECKSIG,
    ]);
    const bothTree = assembleScriptTree([both]);
    const funding = await fund([
      { script: p2tr({ internalPubkey: a.publicKey, merkleRoot: trTree.root }).output, value: VALUE },
      { script: p2mr({ merkleRoot: mrTree.root }).output, value: VALUE },
      { script: p2mr({ merkleRoot: mrTree.root }).output, value: VALUE },
      { script: p2mr({ merkleRoot: bothTree.root }).output, value: VALUE },
    ]);
    const start = (vout: number, spend: SpendEstimate): { tx: Transaction; estimate: number } => {
      const tx = createTransaction(2);
      tx.addInput(funding.getHash(), vout);
      return { tx, estimate: addChange(tx, VALUE, [spend]) };
    };
    const done: { tx: Transaction; estimate: number }[] = [];

    // P2TR script path through PSBT.
    const first = start(0, { type: 'scriptPath', tree: trTree, leafIndex: 1, p2mr: false });
    let psbt = createPsbt(first.tx);
    prepareTaprootScriptPathInput(psbt, 0, { internalPubkey: a.publicKey, tree: trTree, leafIndex: 1, value: VALUE });
    await signTaprootScriptPathInputAsync(psbt, 0, b, { leafHash: trTree.leaves[1]!.leafHash });
    done.push({ tx: finalizePsbt(psbt), estimate: first.estimate });

    // P2MR script path through PSBT.
    const second = start(1, { type: 'scriptPath', tree: mrTree, leafIndex: 0, p2mr: true });
    psbt = createPsbt(second.tx);
    prepareP2mrScriptPathInput(psbt, 0, { tree: mrTree, leafIndex: 0, value: VALUE, previousTransaction: funding });
    await signP2mrScriptPathInputAsync(psbt, 0, b, { leafHash: mrTree.leaves[0]!.leafHash });
    done.push({ tx: finalizePsbt(psbt), estimate: second.estimate });

    // P2MR checksig leaf on the transaction.
    const third = start(2, { type: 'scriptPath', tree: mrTree, leafIndex: 1, p2mr: true });
    await signP2mrInputAsync(third.tx, 0, c, {
      prevouts: prevoutsOf(third.tx, [funding]),
      tree: mrTree,
      leafIndex: 1,
      previousTransactions: [funding],
    });
    done.push(third);

    // A leaf signP2mrInput does not know: both keys must sign, d's signature on top.
    const fourth = start(3, { type: 'scriptPath', tree: bothTree, leafIndex: 0, p2mr: true, stack: [64, 64] });
    const prevouts = prevoutsOf(fourth.tx, [funding]);
    const signatures = [
      await signTapscriptUncheckedAsync(fourth.tx, 0, e, { prevouts, script: both }),
      await signTapscriptUncheckedAsync(fourth.tx, 0, d, { prevouts, script: both }),
    ];
    fourth.tx.setWitness(0, scriptPathWitness(signatures, both, p2mrControlBlock(bothTree, 0)));
    done.push(fourth);

    expect([a, b, c, d, e].map((signer) => signer.calls)).toEqual([0, 2, 1, 1, 1]);
    for (const { tx, estimate } of done) {
      checkStandard(tx, { prevouts: prevoutsOf(tx, [funding]) });
      expect(await testMempoolAccept(tx)).toMatchObject({ allowed: true, vsize: estimate });
    }
    await broadcastAllAndConfirm(done.map(({ tx }) => tx));
  });
});
