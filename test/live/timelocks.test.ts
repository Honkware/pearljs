// Timelock leaves built by cltvScript and csvScript, held by a regtest
// pearld's finality and BIP68 sequence-lock rules until the block where the
// lock matures and mined in that block: an absolute lock by height and by
// median time past, and a relative lock in blocks and in 512-second units.
//
// Runs straight after fresh-chain.test.ts. With PEARL_LIVE_CHAIN the setup
// blocks carry old timestamps, so the 512-second lock matures as soon as the
// median time past reaches the new blocks; on a freshly mined chain the test
// waits the lock out, which takes up to nine minutes.

import { expect, it } from 'vitest';
import {
  assembleScriptTree,
  checkStandard,
  checksigScript,
  cltvScript,
  createPsbt,
  createTransaction,
  csvScript,
  decodeSequence,
  deriveSigningAccountFromSeed,
  encodeSequence,
  estimateVsize,
  finalizePsbt,
  LOCKTIME_THRESHOLD,
  mnemonicToSeed,
  p2mr,
  p2tr,
  prepareP2mrScriptPathInput,
  prepareTaprootScriptPathInput,
  scriptPathWitness,
  SEQUENCE_LOCKTIME_IS_SECONDS,
  Transaction,
} from '../../src/index.js';
import type { ScriptRejectedError, ScriptTree, SigningError, SpendEstimate } from '../../src/index.js';
import { addChange, broadcast, confirm, describeLive, fund, mine, network, nextBlock, pearld, prevoutsOf, testMempoolAccept } from './chain.js';

const account = deriveSigningAccountFromSeed(
  mnemonicToSeed('ozone drill grab fiber curtain grace pudding thank cruise elder eight picnic'),
  network,
);
const internalPubkey = account.derivePublicKey(0, true);
const VALUE = 20_000_000n;
const NOT_FINAL = 'transaction is not finalized';
const notFinal = (tx: Transaction): string => `transaction ${tx.getId()} is not standard: ${NOT_FINAL}`;
const SEQUENCE_LOCKED = "transaction's sequence locks on inputs not met";

interface Locked {
  funding: Transaction;
  tree: ScriptTree;
  /** Child index of the key the leaf checks. */
  index: number;
  viaP2mr: boolean;
}

/** Funds a one-leaf output whose leaf is the given lock in front of a checksig. */
async function lock(index: number, viaP2mr: boolean, leaf: (tail: Uint8Array) => Uint8Array): Promise<Locked> {
  const tree = assembleScriptTree([leaf(checksigScript(account.derivePublicKey(index)))]);
  const script = viaP2mr ? p2mr({ merkleRoot: tree.root }).output : p2tr({ internalPubkey, merkleRoot: tree.root }).output;
  return { funding: await fund([{ script, value: VALUE }]), tree, index, viaP2mr };
}

/** Spends the locked output through its leaf with the given locktime and input sequence. */
function spend(locked: Locked, fields: { locktime?: number; sequence: number; version?: number }): Transaction {
  const { funding, tree, index, viaP2mr } = locked;
  const tx = createTransaction(fields.version ?? 2);
  tx.locktime = fields.locktime ?? 0;
  tx.addInput(funding.getHash(), 0, fields.sequence);
  const spends: SpendEstimate[] = [{ type: 'scriptPath', tree, leafIndex: 0, p2mr: viaP2mr, stack: [64] }];
  const estimate = addChange(tx, VALUE, spends);
  const psbt = createPsbt(tx);
  if (viaP2mr) prepareP2mrScriptPathInput(psbt, 0, { tree, leafIndex: 0, value: VALUE, previousTransaction: funding });
  else prepareTaprootScriptPathInput(psbt, 0, { internalPubkey, tree, leafIndex: 0, value: VALUE });
  account.signScriptPathInput(psbt, 0, { index, leafHash: tree.leaves[0]!.leafHash });
  let signed: Transaction;
  try {
    signed = finalizePsbt(psbt);
  } catch (err) {
    // finalizePsbt runs the leaf before writing a witness and refuses one that
    // fails. The witness is put together by hand, so pearld can refuse it too
    // and refusal() can hold the two verdicts against each other.
    expect(err).toMatchObject({ code: 'WITNESS_ITEMS_NEEDED', cause: { code: 'SCRIPT_REJECTED' } });
    const input = psbt.data.inputs[0]!;
    const leaf = input.tapLeafScript![0]!;
    signed = Transaction.fromBuffer(psbt.data.globalMap.unsignedTx.toBuffer());
    signed.setWitness(0, scriptPathWitness([input.tapScriptSig![0]!.signature], leaf.script, leaf.controlBlock));
    refusedHere.set(signed, (err as SigningError).cause as ScriptRejectedError);
  }
  expect(signed.virtualSize()).toBe(estimate);
  expect(estimateVsize(signed, spends)).toBe(estimate);
  return signed;
}

/** What finalizePsbt refused, for spends whose witness was put together by hand. */
const refusedHere = new WeakMap<Transaction, ScriptRejectedError>();

async function refusal(tx: Transaction): Promise<string> {
  const result = await testMempoolAccept(tx);
  expect(result.allowed).toBe(false);
  const here = refusedHere.get(tx);
  // pearld's script engine and finalizePsbt refuse it for the same reason.
  if (here !== undefined) expect(result['reject-reason']).toContain(here.scriptMessage);
  return result['reject-reason']!;
}

/** Median time past of the block at height, as blockchain.CalcPastMedianTime. */
async function medianTimePast(height: number): Promise<number> {
  const times: number[] = [];
  for (let h = height; h >= 0 && h > height - 11; h--) {
    times.push((await pearld.getBlockHeader(await pearld.getBlockHash(h))).time);
  }
  return times.sort((a, b) => a - b)[Math.floor(times.length / 2)]!;
}

describeLive('timelock leaves', () => {
  it('holds a 512-second CSV leaf until the median time past is 512 seconds beyond the coin, then mines it', { timeout: 900_000 }, async () => {
    const sequence = encodeSequence({ seconds: 512 });
    expect(sequence).toBe((SEQUENCE_LOCKTIME_IS_SECONDS | 1) >>> 0);
    expect(decodeSequence(sequence)).toEqual({ seconds: 512 });
    // 1023 seconds is still one unit.
    expect(encodeSequence({ seconds: 1023 })).toBe(sequence);
    const locked = await lock(1, false, (tail) => csvScript(sequence, tail));
    const height = await pearld.getBlockCount();
    // calcSequenceLock: the median time past of the block before the coin's, plus the lock, less one.
    const lockedThrough = (await medianTimePast(height - 1)) + 512 - 1;
    const tx = spend(locked, { sequence });

    // A lock in blocks does not satisfy a leaf that asks for seconds, whatever the chain's time.
    expect(await refusal(spend(locked, { sequence: encodeSequence({ blocks: 1 }) }))).toContain(
      `mismatched locktime types -- tx locktime 1, stack locktime ${sequence}`,
    );

    let held = 0;
    for (;;) {
      const { medianTimePast: now } = await nextBlock();
      if (now > lockedThrough) break;
      expect(await refusal(tx)).toBe(SEQUENCE_LOCKED);
      held += 1;
      const wait = lockedThrough + 1 - Math.floor(Date.now() / 1000);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait * 1000));
      await mine(1);
    }
    expect(held).toBeGreaterThan(0);
    checkStandard(tx, { prevouts: prevoutsOf(tx, [locked.funding]) });
    expect(await testMempoolAccept(tx)).toMatchObject({ allowed: true });
    await broadcast(tx);
    await confirm(tx);
  });

  it('holds a height CLTV leaf through the block at its height, then mines it in the next', async () => {
    const tip = await pearld.getBlockCount();
    const height = tip + 3;
    const locked = await lock(2, false, (tail) => cltvScript(height, tail));
    const tx = spend(locked, { locktime: height, sequence: 0xfffffffe });
    const prevouts = prevoutsOf(tx, [locked.funding]);

    // Final already, but under the height the leaf asks for.
    const early = spend(locked, { locktime: tip + 1, sequence: 0xfffffffe });
    expect(await refusal(early)).toContain(
      `locktime requirement not satisfied -- locktime is greater than the transaction locktime: ${height} > ${tip + 1}`,
    );
    // At the right locktime but with a final sequence, which switches locktime off.
    expect(await refusal(spend(locked, { locktime: height, sequence: 0xffffffff }))).toContain('transaction input is finalized');

    for (let next = tip + 2; next <= height; next++) {
      const at = await nextBlock();
      expect(at.height).toBe(next);
      expect(() => checkStandard(tx, { prevouts, ...at })).toThrow(NOT_FINAL);
      expect(await refusal(tx)).toBe(notFinal(tx));
      await mine(1);
    }
    const at = await nextBlock();
    expect(at.height).toBe(height + 1);
    checkStandard(tx, { prevouts, ...at });
    expect(await testMempoolAccept(tx)).toMatchObject({ allowed: true });
    await broadcast(tx);
    const info = await confirm(tx);
    expect(info.locktime).toBe(height);
    expect((await pearld.getBlockHeader(info.blockhash!)).height).toBe(height + 1);
  });

  it('holds a time CLTV leaf on a P2MR output until the median time past is beyond it', async () => {
    const locktime = Math.floor(Date.now() / 1000);
    expect(locktime).toBeGreaterThan(LOCKTIME_THRESHOLD);
    const locked = await lock(3, true, (tail) => cltvScript(locktime, tail));
    const tx = spend(locked, { locktime, sequence: 0xfffffffe });
    const prevouts = prevoutsOf(tx, [locked.funding]);

    // A height can never stand in for a time.
    expect(await refusal(spend(locked, { locktime: 1, sequence: 0xfffffffe }))).toContain(
      `mismatched locktime types -- tx locktime 1, stack locktime ${locktime}`,
    );

    let held = 0;
    for (;;) {
      const at = await nextBlock();
      if (at.medianTimePast > locktime) break;
      expect(() => checkStandard(tx, { prevouts, ...at })).toThrow(NOT_FINAL);
      expect(await refusal(tx)).toBe(notFinal(tx));
      held += 1;
      await mine(1);
    }
    expect(held).toBeGreaterThan(0);
    checkStandard(tx, { prevouts, ...(await nextBlock()) });
    expect(await testMempoolAccept(tx)).toMatchObject({ allowed: true });
    await broadcast(tx);
    expect((await confirm(tx)).locktime).toBe(locktime);
  });

  it('holds a three-block CSV leaf on a P2MR output for two blocks after the coin, then mines it in the third', async () => {
    const sequence = encodeSequence({ blocks: 3 });
    expect(sequence).toBe(3);
    const locked = await lock(4, true, (tail) => csvScript(sequence, tail));
    const coinHeight = await pearld.getBlockCount();
    const tx = spend(locked, { sequence });

    // A longer wait than the leaf asks for is fine for the script but not yet for BIP68.
    const longer = spend(locked, { sequence: encodeSequence({ blocks: 4 }) });
    expect(await refusal(tx)).toBe(SEQUENCE_LOCKED);
    await mine(1);
    expect(await refusal(tx)).toBe(SEQUENCE_LOCKED);
    // Two blocks satisfy BIP68 here, and the leaf refuses them.
    expect(await refusal(spend(locked, { sequence: encodeSequence({ blocks: 2 }) }))).toContain(
      'locktime requirement not satisfied -- locktime is greater than the transaction locktime: 3 > 2',
    );
    // Version 1 transactions have no relative locks, so the leaf cannot be met.
    expect(await refusal(spend(locked, { sequence, version: 1 }))).toContain('invalid transaction version: 1');
    await mine(1);
    expect(await pearld.getBlockCount()).toBe(coinHeight + 2);
    expect(await refusal(longer)).toBe(SEQUENCE_LOCKED);
    expect(await testMempoolAccept(tx)).toMatchObject({ allowed: true });
    await broadcast(tx);
    const info = await confirm(tx);
    expect((await pearld.getBlockHeader(info.blockhash!)).height).toBe(coinHeight + 3);
  });
});
