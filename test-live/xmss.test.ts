// P2MR spends through an XMSS leaf, signed by pearljs's XMSS signer and
// verified by pearld's OP_CHECKXMSSSIG on regtest: several one-time indices of
// one key up to the last usable one, and the refusal of index 31.

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
import type { SpendEstimate, Transaction, XmssIndexStore } from '../src/index.js';
import {
  addChange,
  broadcastAllAndConfirm,
  broadcastAndConfirm,
  describeLive,
  fund,
  network,
  pearld,
  prevoutsOf,
  testMempoolAccept,
} from './chain.js';

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

  it('spends five outputs with one key, through index 30, and refuses index 31 before anything is broadcast', async () => {
    // A store that has already handed out most of the key's indices.
    const indices = [0, 1, 2, 29, 30, 31];
    const used: number[] = [];
    const store: XmssIndexStore = {
      peek: () => 0,
      reserve() {
        used.push(indices[used.length]!);
        return used.at(-1)!;
      },
    };
    const signer = createXmssSigner(randomBytes(XMSS_PRIVATE_SEED_LENGTH), randomBytes(XMSS_PUBLIC_SEED_LENGTH), store);
    const tree = assembleScriptTree([xmssLeafScript(signer.publicKey)]);
    const script = p2mr({ merkleRoot: tree.root }).output;
    const funding = await fund(indices.map(() => ({ script, value: VALUE })));
    const spends: SpendEstimate[] = [{ type: 'scriptPath', tree, leafIndex: 0, p2mr: true }];
    const build = async (vout: number): Promise<Transaction> => {
      const tx = createTransaction(2);
      tx.addInput(funding.getHash(), vout);
      addChange(tx, VALUE, spends);
      await signXmssP2mrInput(tx, 0, signer, {
        prevouts: prevoutsOf(tx, [funding]),
        tree,
        leafIndex: 0,
        previousTransactions: [funding],
      });
      return tx;
    };

    const signed: Transaction[] = [];
    for (let vout = 0; vout < 5; vout++) signed.push(await build(vout));
    expect(used).toEqual([0, 1, 2, 29, 30]);
    // The index is the first four bytes of the signature.
    expect(signed.map((tx) => Buffer.from(tx.ins[0]!.witness[0]!).readUInt32BE(0))).toEqual(used);
    for (const tx of signed) expect(await testMempoolAccept(tx)).toMatchObject({ allowed: true });

    const mempool = await pearld.getRawMempool();
    await expect(build(5)).rejects.toThrow('this XMSS key has used all 31 of its signatures');
    expect(used.at(-1)).toBe(31);
    expect(await pearld.getRawMempool()).toEqual(mempool);
    expect(await pearld.getTxOut(funding.getId(), 5)).not.toBeNull();

    await broadcastAllAndConfirm(signed);
  });
});
