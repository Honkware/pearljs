// The signers' own safeguards around real spends on a regtest pearld: a
// file-backed XMSS index store that carries on at the next index after a
// restart, and the maxFeeRate guard refusing an overpaying P2MR spend before
// anything is signed, reserved or broadcast.

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  assembleScriptTree,
  checksigScript,
  createTransaction,
  createXmssSigner,
  DEFAULT_MAX_FEE_RATE,
  deriveSigningAccountFromSeed,
  mnemonicToSeed,
  p2mr,
  serializeTransaction,
  signXmssP2mrInput,
  toOutputScript,
  xmssLeafScript,
  XMSS_PRIVATE_SEED_LENGTH,
  XMSS_PUBLIC_SEED_LENGTH,
} from '../../src/index.js';
import type { SpendEstimate, Transaction } from '../../src/index.js';
import { createFileXmssIndexStore } from '../../src/xmss-file-store.js';
import { addChange, broadcast, broadcastAllAndConfirm, describeLive, fund, live, miner, network, pearld, prevoutsOf, testMempoolAccept } from './chain.js';

// Account 5 of the mnemonic the other files use account 0 of.
const account = deriveSigningAccountFromSeed(mnemonicToSeed('zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong'), network, 5);
const VALUE = 20_000_000n;
const signatureIndex = (tx: Transaction): number => Buffer.from(tx.ins[0]!.witness[0]!).readUInt32BE(0);

describeLive('signer safeguards', () => {
  it('carries an XMSS key on at the next index when a new signer opens the same state file', async () => {
    const path = join(live!.dir, 'xmss-index.json');
    const seeds = [randomBytes(XMSS_PRIVATE_SEED_LENGTH), randomBytes(XMSS_PUBLIC_SEED_LENGTH)] as const;
    const nextOnDisk = (): number => (JSON.parse(readFileSync(path, 'utf8')) as { next: number }).next;

    let store = createFileXmssIndexStore(path, { create: true });
    let signer = createXmssSigner(seeds[0], seeds[1], store);
    const tree = assembleScriptTree([xmssLeafScript(signer.publicKey)]);
    const script = p2mr({ merkleRoot: tree.root }).output;
    const funding = await fund([0, 1, 2, 3].map(() => ({ script, value: VALUE })));
    const spends: SpendEstimate[] = [{ type: 'scriptPath', tree, leafIndex: 0, p2mr: true }];
    const spend = async (vout: number): Promise<Transaction> => {
      const tx = createTransaction(2);
      tx.addInput(funding.getHash(), vout);
      addChange(tx, VALUE, spends);
      await signXmssP2mrInput(tx, 0, signer, { prevouts: prevoutsOf(tx, [funding]), tree, leafIndex: 0, previousTransactions: [funding] });
      return tx;
    };

    const signed = [await spend(0), await spend(1)];
    expect(nextOnDisk()).toBe(2);
    // While the first store holds the file, nothing else can open it.
    expect(() => createFileXmssIndexStore(path)).toThrow('is locked by');

    // The process ends: the signer and its store are gone, the file stays.
    signer.destroy();
    store.close();
    store = createFileXmssIndexStore(path);
    signer = createXmssSigner(seeds[0], seeds[1], store);
    signed.push(await spend(2), await spend(3));
    store.close();

    expect(signed.map(signatureIndex)).toEqual([0, 1, 2, 3]);
    expect(nextOnDisk()).toBe(4);
    for (const tx of signed) expect(await testMempoolAccept(tx)).toMatchObject({ allowed: true });
    await broadcastAllAndConfirm(signed);
  });

  it('refuses to sign a P2MR spend that forgot its change, before an XMSS index is used', async () => {
    const store = { next: 0, reserve: () => store.next++, peek: () => store.next };
    const signer = createXmssSigner(randomBytes(XMSS_PRIVATE_SEED_LENGTH), randomBytes(XMSS_PUBLIC_SEED_LENGTH), store);
    const checksigTree = assembleScriptTree([checksigScript(account.derivePublicKey(0))]);
    const xmssTree = assembleScriptTree([xmssLeafScript(signer.publicKey)]);
    const funding = await fund([
      { script: p2mr({ merkleRoot: checksigTree.root }).output, value: VALUE },
      { script: p2mr({ merkleRoot: xmssTree.root }).output, value: VALUE },
      { script: p2mr({ merkleRoot: checksigTree.root }).output, value: VALUE },
    ]);
    const mempool = await pearld.getRawMempool();
    /** Pays a twentieth of the coin and leaves the rest to the fee. */
    const forgetful = (vout: number): Transaction => {
      const tx = createTransaction(2);
      tx.addInput(funding.getHash(), vout);
      tx.addOutput(toOutputScript(miner.deriveAddress(330), network), VALUE / 20n);
      return tx;
    };
    const refusal = /^transaction pays a fee of 19000000 grain, above the \d+ grain that maxFeeRate \(5000000 grain per 1000 vbytes\) allows/;
    expect(DEFAULT_MAX_FEE_RATE).toBe(5_000_000n);

    const schnorr = forgetful(0);
    const schnorrOptions = { index: 0, prevouts: prevoutsOf(schnorr, [funding]), tree: checksigTree, leafIndex: 0, previousTransactions: [funding] };
    expect(() => account.signP2mrInput(schnorr, 0, schnorrOptions)).toThrow(refusal);
    expect(schnorr.ins[0]!.witness).toEqual([]);

    const xmss = forgetful(1);
    const xmssOptions = { prevouts: prevoutsOf(xmss, [funding]), tree: xmssTree, leafIndex: 0, previousTransactions: [funding] };
    await expect(signXmssP2mrInput(xmss, 0, signer, xmssOptions)).rejects.toThrow(refusal);
    expect(xmss.ins[0]!.witness).toEqual([]);
    expect(store.next).toBe(0);

    // Outputs above the inputs are refused the same way.
    const overdrawn = forgetful(0);
    overdrawn.outs[0]!.value = VALUE + 1n;
    expect(() => account.signP2mrInput(overdrawn, 0, schnorrOptions)).toThrow(
      `transaction outputs (${VALUE + 1n} grain) exceed its inputs (${VALUE} grain)`,
    );
    expect(await pearld.getRawMempool()).toEqual(mempool);

    // Signed on purpose, nothing downstream stops it: testmempoolaccept flags the fee only
    // under its default limit of 0.1 PRL per 1000 vbytes, and sendrawtransaction has no limit.
    const rate = (19_000_000n * 1000n) / 100n;
    account.signP2mrInput(schnorr, 0, { ...schnorrOptions, maxFeeRate: rate });
    expect(await testMempoolAccept(schnorr)).toMatchObject({ allowed: false, 'reject-reason': 'max-fee-exceeded' });
    const [unlimited] = await pearld.testMempoolAccept([serializeTransaction(schnorr)], rate);
    expect(unlimited).toMatchObject({ allowed: true, fees: { base: 19_000_000n } });
    await broadcast(schnorr);
    expect((await pearld.getRawMempoolVerbose())[schnorr.getId()]).toMatchObject({ fee: 19_000_000n });

    // With their change the same kinds of coin sign under the default and are mined.
    const fine = [2, 1].map((vout) => {
      const tx = createTransaction(2);
      tx.addInput(funding.getHash(), vout);
      addChange(tx, VALUE, [{ type: 'scriptPath', tree: vout === 2 ? checksigTree : xmssTree, leafIndex: 0, p2mr: true }]);
      return tx;
    });
    account.signP2mrInput(fine[0]!, 0, { ...schnorrOptions, prevouts: prevoutsOf(fine[0]!, [funding]) });
    await signXmssP2mrInput(fine[1]!, 0, signer, { ...xmssOptions, prevouts: prevoutsOf(fine[1]!, [funding]) });
    expect(store.next).toBe(1);
    await broadcastAllAndConfirm(fine);
    expect(await pearld.getRawMempool()).toEqual([]);
  });
});
