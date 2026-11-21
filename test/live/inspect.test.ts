// inspectTransaction on transactions a regtest pearld accepted and mined, one
// of each kind of spend: key path, P2TR checksig leaf, P2TR multi_a leaf,
// P2MR checksig leaf and P2MR XMSS leaf. Ids, sizes, fee and fee rate are
// compared with testmempoolaccept, and the inputs, outputs and addresses
// with getrawtransaction. wallet-parity.test.ts does the same for a
// transaction Oyster built.

import { randomBytes } from 'node:crypto';
import { beforeAll, expect, it } from 'vitest';
import {
  assembleScriptTree,
  checksigScript,
  createMemoryXmssIndexStore,
  createPsbt,
  createTransaction,
  createXmssSigner,
  deriveSigningAccountFromSeed,
  embed,
  finalizePsbt,
  inspectTransaction,
  MAX_RBF_SEQUENCE,
  mnemonicToSeed,
  multiAScript,
  p2mr,
  p2mrControlBlock,
  p2tr,
  prepareTaprootScriptPathInput,
  signXmssP2mrInput,
  taprootControlBlock,
  toOutputScript,
  xmssLeafScript,
  XMSS_PRIVATE_SEED_LENGTH,
  XMSS_PUBLIC_SEED_LENGTH,
} from '../../src/index.js';
import type { InspectedTransaction, TxOutput, ScriptTree, SpendEstimate, Transaction } from '../../src/index.js';
import { addChange, broadcastAllAndConfirm, describeLive, fund, miner, network, prevoutsOf, testMempoolAccept } from './chain.js';

const account = deriveSigningAccountFromSeed(
  mnemonicToSeed('jelly better achieve collect unaware mountain thought cargo oxygen act hood bridge'),
  network,
);
const internalPubkey = account.derivePublicKey(0, true);
const key = (index: number): Uint8Array => account.derivePublicKey(index);
const VALUE = 20_000_000n;
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

/**
 * Checks what inspectTransaction says against pearld before and after the
 * transaction is mined, and returns it for the checks particular to its kind.
 */
async function inspectLive(tx: Transaction, prevouts: TxOutput[]): Promise<InspectedTransaction> {
  const inspected = inspectTransaction(tx, prevouts, network);
  expect(await testMempoolAccept(tx)).toMatchObject({
    allowed: true,
    txid: inspected.txid,
    wtxid: inspected.wtxid,
    vsize: inspected.vsize,
    fees: { base: inspected.fee, 'effective-feerate': inspected.feeRate },
  });
  const [info] = await broadcastAllAndConfirm([tx]);
  expect(info).toMatchObject({
    txid: inspected.txid,
    hash: inspected.wtxid,
    size: inspected.size,
    vsize: inspected.vsize,
    version: inspected.version,
    locktime: inspected.locktime,
  });
  expect(inspected.weight).toBeGreaterThan(4 * (inspected.vsize - 1));
  expect(inspected.weight).toBeLessThanOrEqual(4 * inspected.vsize);
  expect(info!.vin).toEqual(
    inspected.inputs.map((input, i) => ({
      txid: input.txid,
      vout: input.vout,
      scriptSig: { asm: '', hex: '' },
      txinwitness: tx.ins[i]!.witness.map(hex),
      sequence: input.sequence,
    })),
  );
  expect(info!.vout.map((out) => [out.value, out.scriptPubKey.hex, out.scriptPubKey.address ?? null])).toEqual(
    inspected.outputs.map((out) => [out.value, hex(out.script), out.address]),
  );
  return inspected;
}

describeLive('inspectTransaction', () => {
  const checksigTree = assembleScriptTree([checksigScript(key(2)), checksigScript(key(3))]);
  const multiATree = assembleScriptTree([multiAScript([key(4), key(5), key(6)], 2)]);
  const p2mrTree = assembleScriptTree([checksigScript(key(7)), checksigScript(key(8)), checksigScript(key(9))]);
  const xmss = createXmssSigner(randomBytes(XMSS_PRIVATE_SEED_LENGTH), randomBytes(XMSS_PUBLIC_SEED_LENGTH), createMemoryXmssIndexStore());
  const xmssTree = assembleScriptTree([xmssLeafScript(xmss.publicKey), checksigScript(key(10))]);
  const scripts = [
    toOutputScript(account.deriveAddress(1), network),
    p2tr({ internalPubkey, merkleRoot: checksigTree.root }).output,
    p2tr({ internalPubkey, merkleRoot: multiATree.root }).output,
    p2mr({ merkleRoot: p2mrTree.root }).output,
    p2mr({ merkleRoot: xmssTree.root }).output,
  ];
  let funding: Transaction;
  beforeAll(async () => {
    funding = await fund(scripts.map((script) => ({ script, value: VALUE })));
  });

  /** An unsigned spend of one funding output, with change. */
  function start(vout: number, spend: SpendEstimate, sequence?: number): Transaction {
    const tx = createTransaction(2);
    tx.addInput(funding.getHash(), vout, sequence);
    addChange(tx, VALUE, [spend]);
    return tx;
  }
  const leafSpend = (tree: ScriptTree, leafIndex: number, viaP2mr: boolean): SpendEstimate => ({
    type: 'scriptPath',
    tree,
    leafIndex,
    p2mr: viaP2mr,
  });

  it('reads a key-path spend that signals replacement and carries an OP_RETURN', async () => {
    const tx = createTransaction(2);
    tx.addInput(funding.getHash(), 0, MAX_RBF_SEQUENCE);
    tx.addOutput(toOutputScript(miner.deriveAddress(310), network), 5_000_000n);
    tx.addOutput(embed({ data: Buffer.from('pearljs') }).output, 0n);
    addChange(tx, VALUE, [{ type: 'keyPath' }]);
    const psbt = createPsbt(tx);
    account.prepareInput(psbt, 0, { index: 1, value: VALUE });
    account.signInput(psbt, 0, { index: 1 });
    const inspected = await inspectLive(finalizePsbt(psbt), [{ script: scripts[0]!, value: VALUE }]);

    expect(inspected.rbf).toBe(true);
    expect(inspected.inputs[0]).toMatchObject({ address: account.deriveAddress(1), value: VALUE, spend: { type: 'keyPath', sighashType: 0 } });
    expect(inspected.outputs.map((out) => [out.type, out.address])).toEqual([
      ['p2tr', miner.deriveAddress(310)],
      ['nulldata', null],
      ['p2tr', miner.deriveAddress(1)],
    ]);
  });

  it('reads a P2TR checksig leaf spend', async () => {
    const tx = start(1, leafSpend(checksigTree, 1, false));
    const psbt = createPsbt(tx);
    prepareTaprootScriptPathInput(psbt, 0, { internalPubkey, tree: checksigTree, leafIndex: 1, value: VALUE });
    account.signScriptPathInput(psbt, 0, { index: 3, leafHash: checksigTree.leaves[1]!.leafHash });
    const inspected = await inspectLive(finalizePsbt(psbt), [{ script: scripts[1]!, value: VALUE }]);

    expect(inspected.rbf).toBe(false);
    const { spend } = inspected.inputs[0]!;
    expect(spend).toMatchObject({
      type: 'scriptPath',
      p2mr: false,
      leaf: 'checksig',
      keys: [key(3)],
      script: checksigScript(key(3)),
      leafVersion: 0xc0,
      leafHash: checksigTree.leaves[1]!.leafHash,
      controlBlock: taprootControlBlock(internalPubkey, checksigTree, 1),
      internalPubkey,
      commits: true,
    });
    expect(spend.type === 'scriptPath' && spend.stack.map((item) => item.length)).toEqual([64]);
  });

  it('reads a P2TR multi_a leaf spend with its keys and threshold', async () => {
    const tx = start(2, leafSpend(multiATree, 0, false));
    const psbt = createPsbt(tx);
    prepareTaprootScriptPathInput(psbt, 0, { internalPubkey, tree: multiATree, leafIndex: 0, value: VALUE });
    for (const index of [4, 6]) account.signScriptPathInput(psbt, 0, { index, leafHash: multiATree.leaves[0]!.leafHash });
    const inspected = await inspectLive(finalizePsbt(psbt), [{ script: scripts[2]!, value: VALUE }]);

    const { spend } = inspected.inputs[0]!;
    expect(spend).toMatchObject({ type: 'scriptPath', p2mr: false, leaf: 'multiA', keys: [key(4), key(5), key(6)], threshold: 2, commits: true });
    expect(spend.type === 'scriptPath' && spend.stack.map((item) => item.length)).toEqual([64, 0, 64]);
  });

  it('reads a P2MR checksig leaf spend', async () => {
    const tx = start(3, leafSpend(p2mrTree, 2, true));
    account.signP2mrInput(tx, 0, { index: 9, prevouts: prevoutsOf(tx, [funding]), tree: p2mrTree, leafIndex: 2, previousTransactions: [funding] });
    const inspected = await inspectLive(tx, [{ script: scripts[3]!, value: VALUE }]);

    const { spend } = inspected.inputs[0]!;
    expect(inspected.inputs[0]!.address).toMatch(/^rprl1z/);
    expect(spend).toMatchObject({
      type: 'scriptPath',
      p2mr: true,
      leaf: 'checksig',
      keys: [key(9)],
      controlBlock: p2mrControlBlock(p2mrTree, 2),
      commits: true,
    });
    expect(spend).not.toHaveProperty('internalPubkey');
  });

  it('reads a P2MR XMSS leaf spend', async () => {
    const tx = start(4, leafSpend(xmssTree, 0, true));
    await signXmssP2mrInput(tx, 0, xmss, { prevouts: prevoutsOf(tx, [funding]), tree: xmssTree, leafIndex: 0, previousTransactions: [funding] });
    const inspected = await inspectLive(tx, [{ script: scripts[4]!, value: VALUE }]);

    const { spend } = inspected.inputs[0]!;
    expect(spend).toMatchObject({ type: 'scriptPath', p2mr: true, leaf: 'xmss', keys: [xmss.publicKey], commits: true });
    expect(spend.type === 'scriptPath' && spend.stack.map((item) => item.length)).toEqual(Array(5).fill(468));
  });
});
