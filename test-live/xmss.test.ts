// A P2MR spend through an XMSS leaf, signed by pearljs's XMSS signer and
// verified by pearld's OP_CHECKXMSSSIG on regtest.

import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  assembleScriptTree,
  checkStandard,
  checksigScript,
  createMemoryXmssIndexStore,
  createTransaction,
  createXmssSigner,
  deriveSigningAccountFromSeed,
  estimateVsize,
  mnemonicToSeed,
  p2mr,
  signXmssP2mrInput,
  xmssLeafScript,
  XMSS_PRIVATE_SEED_LENGTH,
  XMSS_PUBLIC_SEED_LENGTH,
} from '../src/index.js';
import type { SpendEstimate } from '../src/index.js';
import { addChange, broadcastAndConfirm, describeLive, fund, network, prevoutsOf, testMempoolAccept } from './chain.js';

const account = deriveSigningAccountFromSeed(mnemonicToSeed('zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong'), network);
const VALUE = 20_000_000n;

describeLive('XMSS', () => {
  it('spends two P2MR outputs through an XMSS leaf next to a checksig leaf', async () => {
    const signer = createXmssSigner(
      randomBytes(XMSS_PRIVATE_SEED_LENGTH),
      randomBytes(XMSS_PUBLIC_SEED_LENGTH),
      createMemoryXmssIndexStore(),
    );
    const tree = assembleScriptTree([checksigScript(account.derivePublicKey(50)), xmssLeafScript(signer.publicKey)]);
    const script = p2mr({ merkleRoot: tree.root }).output;
    const funding = await fund([
      { script, value: VALUE },
      { script, value: VALUE },
    ]);

    // Two spends, so the signer's second one-time index is used too.
    for (const vout of [0, 1]) {
      const tx = createTransaction(2);
      tx.addInput(funding.getHash(), vout);
      const spends: SpendEstimate[] = [{ type: 'scriptPath', tree, leafIndex: 1, p2mr: true }];
      const estimate = addChange(tx, VALUE, spends);
      const prevouts = prevoutsOf(tx, [funding]);
      await signXmssP2mrInput(tx, 0, signer, { prevouts, tree, leafIndex: 1, previousTransactions: [funding] });
      checkStandard(tx, { prevouts });

      expect(await testMempoolAccept(tx)).toMatchObject({ allowed: true, vsize: estimate });
      const info = await broadcastAndConfirm(tx);
      expect(info.vsize).toBe(estimateVsize(tx, spends));
    }
  });
});
