// checkStandard against pearld's mempool: for each transaction checkStandard
// refuses, testmempoolaccept rejects it with the same reason, and the
// standard one is accepted at the vsize estimateVsize predicted. The node
// runs with --rejectnonstd, as mainnet does by default.

import { beforeAll, expect, it } from 'vitest';
import {
  checkStandard,
  createPsbt,
  createTransaction,
  deriveSigningAccountFromSeed,
  embed,
  estimateVsize,
  finalizePsbt,
  minRelayFee,
  mnemonicToSeed,
  toOutputScript,
  transactionId,
} from '../src/index.js';
import type { Prevout, Transaction } from '../src/index.js';
import {
  addChange,
  broadcastAndConfirm,
  changeScript,
  describeLive,
  fund,
  network,
  prevoutsOf,
  testMempoolAccept,
} from './chain.js';

const account = deriveSigningAccountFromSeed(mnemonicToSeed('zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong'), network);
const VALUE = 100_000_000n;
const recipient = toOutputScript(account.deriveAddress(61), network);
let funding: Transaction;

/** A key-path spend of the funded output, paying exactly outputs. */
function spend(outputs: readonly Prevout[]): Transaction {
  const tx = createTransaction(2);
  tx.addInput(funding.getHash(), 0);
  for (const output of outputs) tx.addOutput(output.script, output.value);
  const psbt = createPsbt(tx);
  account.prepareInput(psbt, 0, { index: 60, value: VALUE });
  account.signInput(psbt, 0, { index: 60 });
  return finalizePsbt(psbt);
}

/** A spend paying outputs with the rest, less a normal fee, as change. */
function spendWithChange(outputs: readonly Prevout[]): Transaction {
  const tx = createTransaction(2);
  tx.addInput(funding.getHash(), 0);
  for (const output of outputs) tx.addOutput(output.script, output.value);
  addChange(tx, VALUE, [{ type: 'keyPath' }]);
  return spend(tx.outs.map((out) => ({ script: out.script, value: out.value })));
}

/** checkStandard's error, which pearld wraps when the rule is part of CheckTransactionStandard. */
async function expectSameRejection(tx: Transaction, wrapped: boolean): Promise<void> {
  let predicted = '';
  try {
    checkStandard(tx, { prevouts: prevoutsOf(tx, [funding]) });
  } catch (error) {
    predicted = (error as Error).message;
  }
  expect(predicted).not.toBe('');
  const result = await testMempoolAccept(tx);
  expect(result.allowed).toBe(false);
  expect(result['reject-reason']).toBe(
    wrapped ? `transaction ${transactionId(tx)} is not standard: ${predicted}` : predicted,
  );
}

describeLive('relay policy', () => {
  beforeAll(async () => {
    funding = await fund([{ script: toOutputScript(account.deriveAddress(60), network), value: VALUE }]);
  });

  it('agrees with pearld that a 332-grain P2TR output is dust', async () => {
    await expectSameRejection(spendWithChange([{ script: recipient, value: 332n }]), true);
  });

  it('agrees with pearld that a SegWit v0 output is unsupported', async () => {
    const p2wpkh = Uint8Array.from([0x00, 0x14, ...new Uint8Array(20).fill(7)]);
    await expectSameRejection(spendWithChange([{ script: p2wpkh, value: 10_000_000n }]), false);
  });

  it('agrees with pearld that two OP_RETURN outputs are non-standard', async () => {
    const data = embed({ data: Uint8Array.from([1, 2, 3]) }).output;
    await expectSameRejection(
      spendWithChange([
        { script: data, value: 0n },
        { script: data, value: 0n },
      ]),
      true,
    );
  });

  it('agrees with pearld on a fee one grain under the relay fee', async () => {
    const tx = createTransaction(2);
    tx.addInput(funding.getHash(), 0);
    tx.addOutput(changeScript, 0n);
    const fee = minRelayFee(estimateVsize(tx, [{ type: 'keyPath' }])) - 1n;
    await expectSameRejection(spend([{ script: changeScript, value: VALUE - fee }]), false);
  });

  it('agrees with pearld that a transaction under 65 bytes without witnesses is too small', async () => {
    // One input and one bare OP_RETURN output: 61 stripped bytes.
    const tx = spend([{ script: Uint8Array.from([0x6a]), value: VALUE - 1_000n }]);
    expect(tx.byteLength(false)).toBe(61);
    await expectSameRejection(tx, false);
  });

  it('accepts a standard transaction with a 333-grain output at the vsize estimateVsize predicts', async () => {
    const data = embed({ data: Uint8Array.from([1, 2, 3]) }).output;
    const tx = spendWithChange([
      { script: recipient, value: 333n },
      { script: data, value: 0n },
    ]);
    checkStandard(tx, { prevouts: prevoutsOf(tx, [funding]) });
    const result = await testMempoolAccept(tx);
    expect(result).toMatchObject({ allowed: true, vsize: estimateVsize(tx, [{ type: 'keyPath' }]) });
    const info = await broadcastAndConfirm(tx);
    expect(info.vsize).toBe(tx.virtualSize());
  });
});
