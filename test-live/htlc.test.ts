// Hash timelock contracts on a regtest pearld: in a P2TR script tree with a
// CLTV refund and in a P2MR tree with a CSV refund, one contract is claimed
// with the preimage and another refunded once its lock has passed, refused
// before. The preimage is read back out of the claim pearld mined.

import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  assembleScriptTree,
  createPsbt,
  createTransaction,
  deriveSigningAccountFromSeed,
  encodeSequence,
  extractHtlcPreimage,
  finalizePsbt,
  finalizeScriptPathInput,
  htlcLeaves,
  htlcStack,
  htlcStackSizes,
  mnemonicToSeed,
  p2mr,
  p2tr,
  parseTransaction,
  prepareP2mrScriptPathInput,
  prepareTaprootScriptPathInput,
  sha256,
} from '../src/index.js';
import type { HtlcTimelock, ScriptTree, Transaction } from '../src/index.js';
import { addChange, broadcastAndConfirm, describeLive, fund, mine, network, nextBlock, pearld, testMempoolAccept } from './chain.js';

const account = deriveSigningAccountFromSeed(
  mnemonicToSeed('ribbon bus rescue zebra fury clinic hollow upgrade stage cost wedding obscure'),
  network,
);
const internalPubkey = account.derivePublicKey(0, true);
const CLAIM = 3;
const REFUND = 4;
const VALUE = 20_000_000n;

interface Contract {
  tree: ScriptTree;
  viaP2mr: boolean;
  script: Uint8Array;
}

function contract(hash: Uint8Array, viaP2mr: boolean, timelock: HtlcTimelock): Contract {
  const { claim, refund } = htlcLeaves({ hash, claimKey: account.derivePublicKey(CLAIM), refundKey: account.derivePublicKey(REFUND), timelock });
  const tree = assembleScriptTree([claim, refund]);
  const script = viaP2mr ? p2mr({ merkleRoot: tree.root }).output : p2tr({ internalPubkey, merkleRoot: tree.root }).output;
  return { tree, viaP2mr, script };
}

function spend(c: Contract, funding: Transaction, vout: number, leafIndex: number, fields: { locktime?: number; sequence?: number; preimage?: Uint8Array }): Transaction {
  const tx = createTransaction(2);
  tx.locktime = fields.locktime ?? 0;
  tx.addInput(funding.getHash(), vout, fields.sequence ?? 0xffffffff);
  const leaf = c.tree.leaves[leafIndex]!;
  const estimate = addChange(tx, VALUE, [{ type: 'scriptPath', tree: c.tree, leafIndex, p2mr: c.viaP2mr, stack: htlcStackSizes(leaf.script) }]);
  const psbt = createPsbt(tx);
  if (c.viaP2mr) prepareP2mrScriptPathInput(psbt, 0, { tree: c.tree, leafIndex, value: VALUE, previousTransaction: funding });
  else prepareTaprootScriptPathInput(psbt, 0, { internalPubkey, tree: c.tree, leafIndex, value: VALUE });
  account.signScriptPathInput(psbt, 0, { index: leafIndex === 0 ? CLAIM : REFUND, leafHash: leaf.leafHash });
  finalizeScriptPathInput(psbt, 0, { stack: htlcStack(leaf.script, fields.preimage === undefined ? {} : { preimage: fields.preimage }) });
  const signed = finalizePsbt(psbt);
  expect(signed.virtualSize()).toBe(estimate);
  return signed;
}

describeLive('hash timelock contracts', () => {
  for (const viaP2mr of [false, true]) {
    it(`claims one ${viaP2mr ? 'P2MR' : 'P2TR'} HTLC with the preimage and refunds another after its ${viaP2mr ? 'CSV' : 'CLTV'} lock`, async () => {
      const preimage = Uint8Array.from(randomBytes(32));
      const hash = sha256(preimage);
      const { height } = await nextBlock();
      // The funding block is `height` and the claim's the next. A refund in
      // the block after that is too soon either way: the CLTV lock is that
      // block's height, which a transaction's locktime must be under, and the
      // CSV lock is three blocks.
      const timelock: HtlcTimelock = viaP2mr ? { sequence: encodeSequence({ blocks: 3 }) } : { locktime: height + 2 };
      const c = contract(hash, viaP2mr, timelock);
      const funding = await fund([
        { script: c.script, value: VALUE },
        { script: c.script, value: VALUE },
      ]);

      const claim = spend(c, funding, 0, 0, { preimage });
      await broadcastAndConfirm(claim);
      const mined = parseTransaction(await pearld.getRawTransactionHex(claim.getId()));
      expect(extractHtlcPreimage(mined, hash)).toEqual({ preimage, inputIndex: 0 });

      const refund = viaP2mr
        ? spend(c, funding, 1, 1, { sequence: (timelock as { sequence: number }).sequence })
        : spend(c, funding, 1, 1, { locktime: height + 2, sequence: 0xfffffffe });
      const refused = await testMempoolAccept(refund);
      expect(refused.allowed).toBe(false);
      expect(refused['reject-reason']).toMatch(viaP2mr ? /sequence locks on inputs not met/ : /not finalized/);

      await mine(1);
      await broadcastAndConfirm(refund);
      expect(extractHtlcPreimage(refund, hash)).toBeNull();
    });
  }
});
