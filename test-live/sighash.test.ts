// Every non-default Taproot sighash type, on BIP86 key-path spends through
// PSBT and on P2MR checksig leaves, verified by a regtest pearld. For each
// type the outputs are also changed after signing, which only a
// SIGHASH_NONE signature survives.

import { beforeAll, expect, it } from 'vitest';
import {
  assembleScriptTree,
  checkStandard,
  checksigScript,
  createPsbt,
  createTransaction,
  deriveSigningAccountFromSeed,
  finalizePsbt,
  mnemonicToSeed,
  p2mr,
  toOutputScript,
  Transaction,
} from '../src/index.js';
import type { SpendEstimate } from '../src/index.js';
import {
  addChange,
  broadcastAllAndConfirm,
  changeScript,
  describeLive,
  fund,
  network,
  prevoutsOf,
  testMempoolAccept,
} from './chain.js';

const account = deriveSigningAccountFromSeed(mnemonicToSeed('zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong'), network);
const VALUE = 20_000_000n;
const ACP = Transaction.SIGHASH_ANYONECANPAY;
const TYPES: [string, number][] = [
  ['ALL', Transaction.SIGHASH_ALL],
  ['NONE', Transaction.SIGHASH_NONE],
  ['SINGLE', Transaction.SIGHASH_SINGLE],
  ['ALL|ANYONECANPAY', Transaction.SIGHASH_ALL | ACP],
  ['NONE|ANYONECANPAY', Transaction.SIGHASH_NONE | ACP],
  ['SINGLE|ANYONECANPAY', Transaction.SIGHASH_SINGLE | ACP],
];
const KEY_BASE = 100;
const LEAF_BASE = 110;
const tree = (i: number) => assembleScriptTree([checksigScript(account.derivePublicKey(LEAF_BASE + i))]);

describeLive('sighash types', () => {
  let funding: Transaction;
  const signed: Transaction[] = [];

  beforeAll(async () => {
    funding = await fund([
      ...TYPES.map((_, i) => ({ script: toOutputScript(account.deriveAddress(KEY_BASE + i), network), value: VALUE })),
      ...TYPES.map((_, i) => ({ script: p2mr({ merkleRoot: tree(i).root }).output, value: VALUE })),
    ]);
  });

  /** Checks pearld takes the spend, and takes it with other outputs only when the signature ignores them. */
  async function verify(tx: Transaction, sighashType: number, estimate: number): Promise<void> {
    const signature = tx.ins[0]!.witness[0]!;
    expect(signature).toHaveLength(65);
    expect(signature[64]).toBe(sighashType);
    checkStandard(tx, { prevouts: prevoutsOf(tx, [funding]) });
    expect(await testMempoolAccept(tx)).toMatchObject({ allowed: true, vsize: estimate });

    const changed = tx.clone();
    changed.outs[0]!.value -= 1n;
    const result = await testMempoolAccept(changed);
    if ((sighashType & 0x03) === Transaction.SIGHASH_NONE) {
      expect(result.allowed).toBe(true);
    } else {
      expect(result.allowed).toBe(false);
      expect(result['reject-reason']).toMatch(/^failed to validate input /);
    }
    signed.push(tx);
  }

  it.each(TYPES)('spends a BIP86 key path signed with SIGHASH_%s', async (_, sighashType) => {
    const i = TYPES.findIndex(([, type]) => type === sighashType);
    const tx = createTransaction(2);
    tx.addInput(funding.getHash(), i);
    const estimate = addChange(tx, VALUE, [{ type: 'keyPath', sighashType }]);
    const psbt = createPsbt(tx);
    account.prepareInput(psbt, 0, { index: KEY_BASE + i, value: VALUE, sighashType });
    account.signInput(psbt, 0, { index: KEY_BASE + i });
    await verify(finalizePsbt(psbt), sighashType, estimate);
  });

  it.each(TYPES)('spends a P2MR checksig leaf signed with SIGHASH_%s', async (_, sighashType) => {
    const i = TYPES.findIndex(([, type]) => type === sighashType);
    const tx = createTransaction(2);
    tx.addInput(funding.getHash(), TYPES.length + i);
    const spends: SpendEstimate[] = [{ type: 'scriptPath', tree: tree(i), leafIndex: 0, p2mr: true, sighashType }];
    const estimate = addChange(tx, VALUE, spends);
    account.signP2mrInput(tx, 0, {
      index: LEAF_BASE + i,
      prevouts: prevoutsOf(tx, [funding]),
      tree: tree(i),
      leafIndex: 0,
      sighashType,
      previousTransactions: [funding],
    });
    await verify(tx, sighashType, estimate);
  });

  it('mines all twelve spends', async () => {
    expect(signed).toHaveLength(2 * TYPES.length);
    const infos = await broadcastAllAndConfirm(signed);
    infos.forEach((info, i) => expect(info.vsize).toBe(signed[i]!.virtualSize()));
  });

  it('keeps a SINGLE|ANYONECANPAY P2MR signature valid when an input and an output are added', async () => {
    const sighashType = Transaction.SIGHASH_SINGLE | ACP;
    const leaves = assembleScriptTree([checksigScript(account.derivePublicKey(LEAF_BASE + 8))]);
    const more = await fund([
      { script: p2mr({ merkleRoot: leaves.root }).output, value: VALUE },
      { script: toOutputScript(account.deriveAddress(KEY_BASE + 8), network), value: VALUE },
    ]);
    const tx = createTransaction(2);
    tx.addInput(more.getHash(), 0);
    tx.addOutput(changeScript, VALUE);
    account.signP2mrInput(tx, 0, {
      index: LEAF_BASE + 8,
      prevouts: prevoutsOf(tx, [more]),
      tree: leaves,
      leafIndex: 0,
      sighashType,
      previousTransactions: [more],
    });
    const p2mrWitness = tx.ins[0]!.witness;

    // Someone else adds the input that pays the fee, and their change.
    tx.addInput(more.getHash(), 1);
    const spends: SpendEstimate[] = [
      { type: 'scriptPath', tree: leaves, leafIndex: 0, p2mr: true, sighashType },
      { type: 'keyPath' },
    ];
    const estimate = addChange(tx, 2n * VALUE, spends);
    const psbt = createPsbt(stripped(tx));
    psbt.updateInput(0, { witnessUtxo: prevoutsOf(tx, [more])[0]! });
    account.prepareInput(psbt, 1, { index: KEY_BASE + 8, value: VALUE });
    account.signInput(psbt, 1, { index: KEY_BASE + 8 });
    tx.setWitness(0, p2mrWitness);
    tx.setWitness(1, [psbt.data.inputs[1]!.tapKeySig!]);

    checkStandard(tx, { prevouts: prevoutsOf(tx, [more]) });
    expect(await testMempoolAccept(tx)).toMatchObject({ allowed: true, vsize: estimate });
    await broadcastAllAndConfirm([tx]);
  });
});

function stripped(tx: Transaction): Transaction {
  const copy = tx.clone();
  copy.stripWitnesses();
  return copy;
}
