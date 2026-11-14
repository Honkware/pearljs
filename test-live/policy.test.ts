// checkStandard against pearld's mempool: for each transaction checkStandard
// refuses, testmempoolaccept rejects it with the same reason, and the
// standard ones are accepted at the vsize estimateVsize predicted. Covers
// the consensus sanity checks, version, finality, signature scripts, size,
// OP_RETURN outputs, dust and the relay fee. The node runs with
// --rejectnonstd, as mainnet does by default.

import { beforeAll, expect, it } from 'vitest';
import {
  checkStandard,
  createPsbt,
  createTransaction,
  DEFAULT_RELAY_FEE_RATE,
  deriveSigningAccountFromSeed,
  embed,
  estimateVsize,
  finalizePsbt,
  MAX_EMBED_DATA_SIZE,
  MAX_GRAIN,
  MAX_STANDARD_TX_VSIZE,
  minRelayFee,
  mnemonicToSeed,
  OP_CODES,
  serializeTransaction,
  toOutputScript,
  transactionId,
} from '../src/index.js';
import type { Prevout, Transaction } from '../src/index.js';
import {
  addChange,
  broadcast,
  broadcastAndConfirm,
  changeScript,
  confirm,
  describeLive,
  fund,
  network,
  nextBlock,
  pearld,
  prevoutsOf,
  testMempoolAccept,
} from './chain.js';

const account = deriveSigningAccountFromSeed(mnemonicToSeed('zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong'), network);
const VALUE = 100_000_000n;
const recipient = toOutputScript(account.deriveAddress(61), network);
let funding: Transaction;

/** A key-path spend of the funded output, paying exactly outputs. edit changes the transaction before it is signed. */
function spend(outputs: readonly Prevout[], edit: (tx: Transaction) => void = () => {}): Transaction {
  const tx = createTransaction(2);
  tx.addInput(funding.getHash(), 0);
  for (const output of outputs) tx.addOutput(output.script, output.value);
  edit(tx);
  const psbt = createPsbt(tx);
  account.prepareInput(psbt, 0, { index: 60, value: VALUE });
  account.signInput(psbt, 0, { index: 60 });
  return finalizePsbt(psbt);
}

/** A spend paying outputs with the rest, less a normal fee, as change. */
function spendWithChange(outputs: readonly Prevout[], edit?: (tx: Transaction) => void): Transaction {
  const tx = createTransaction(2);
  tx.addInput(funding.getHash(), 0);
  for (const output of outputs) tx.addOutput(output.script, output.value);
  addChange(tx, VALUE, [{ type: 'keyPath' }]);
  return spend(
    tx.outs.map((out) => ({ script: out.script, value: out.value })),
    edit,
  );
}

/** An OP_RETURN script pushing size bytes, as embed builds it but without embed's 80-byte limit. */
function dataScript(size: number): Uint8Array {
  const length = Buffer.alloc(4);
  length.writeUInt32LE(size);
  const push = size <= 0xff ? [OP_CODES.OP_PUSHDATA1, size] : [OP_CODES.OP_PUSHDATA4, ...length];
  return Uint8Array.from([OP_CODES.OP_RETURN, ...push, ...new Uint8Array(size).fill(0x70)]);
}

/** checkStandard's error, which pearld wraps when the rule is part of CheckTransactionStandard. */
async function expectSameRejection(tx: Transaction, wrapped: boolean, prevouts = prevoutsOf(tx, [funding])): Promise<void> {
  let predicted = '';
  try {
    checkStandard(tx, { prevouts, ...(await nextBlock()) });
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

  it('agrees with pearld on transaction versions 0 and 3, and both accept version 1', async () => {
    for (const version of [0, 3]) {
      const tx = spendWithChange([], (unsigned) => (unsigned.version = version));
      await expectSameRejection(tx, true);
    }
    const tx = spendWithChange([], (unsigned) => (unsigned.version = 1));
    checkStandard(tx, { prevouts: prevoutsOf(tx, [funding]) });
    expect((await testMempoolAccept(tx)).allowed).toBe(true);
  });

  it('agrees with pearld on when a height lock and a time lock are final', async () => {
    const { height, medianTimePast } = await nextBlock();
    const locked = (locktime: number, sequence = 0xfffffffe): Transaction =>
      spendWithChange([], (unsigned) => {
        unsigned.locktime = locktime;
        unsigned.ins[0]!.sequence = sequence;
      });
    // A lock is final once it is below the next block's height or the median time past.
    for (const locktime of [height, medianTimePast]) {
      await expectSameRejection(locked(locktime), true);
      for (const tx of [locked(locktime - 1), locked(locktime, 0xffffffff)]) {
        checkStandard(tx, { prevouts: prevoutsOf(tx, [funding]), height, medianTimePast });
        expect((await testMempoolAccept(tx)).allowed).toBe(true);
      }
    }
  });

  it('agrees with pearld on a signature script that is not push only or over 1650 bytes', async () => {
    // Taproot signatures do not cover the signature script, and pearld checks
    // standardness before it runs scripts.
    for (const script of [Uint8Array.of(OP_CODES.OP_DUP), new Uint8Array(1651).fill(OP_CODES.OP_1)]) {
      const tx = spendWithChange([]);
      tx.ins[0]!.script = script;
      await expectSameRejection(tx, true);
    }
  });

  it('agrees with pearld on the 100000 vbyte limit, which is also what bounds an OP_RETURN output', async () => {
    const sized = (dataSize: number): Transaction =>
      spend([
        { script: dataScript(dataSize), value: 0n },
        { script: changeScript, value: VALUE - 250_000n },
      ]);
    // Find the data size that lands exactly on the limit.
    const dataSize = 99_000 + (MAX_STANDARD_TX_VSIZE - sized(99_000).virtualSize());
    const largest = sized(dataSize);
    expect(largest.virtualSize()).toBe(MAX_STANDARD_TX_VSIZE);
    checkStandard(largest, { prevouts: prevoutsOf(largest, [funding]) });
    expect(await testMempoolAccept(largest)).toMatchObject({ allowed: true, vsize: MAX_STANDARD_TX_VSIZE });

    const tooLarge = sized(dataSize + 1);
    expect(tooLarge.virtualSize()).toBe(MAX_STANDARD_TX_VSIZE + 1);
    await expectSameRejection(tooLarge, true);
  });

  it('builds an 80-byte OP_RETURN with embed, the most it allows, that pearld mines', async () => {
    const data = Uint8Array.from({ length: MAX_EMBED_DATA_SIZE }, (_, i) => i);
    expect(() => embed({ data: new Uint8Array(MAX_EMBED_DATA_SIZE + 1) })).toThrow('exceeds 80');
    // pearld itself has no 80-byte rule: one byte more is still relayed.
    const over = spendWithChange([{ script: dataScript(MAX_EMBED_DATA_SIZE + 1), value: 0n }]);
    checkStandard(over, { prevouts: prevoutsOf(over, [funding]) });
    expect((await testMempoolAccept(over)).allowed).toBe(true);

    const carrier = await fund([{ script: toOutputScript(account.deriveAddress(62), network), value: VALUE }]);
    const tx = createTransaction(2);
    tx.addInput(carrier.getHash(), 0);
    tx.addOutput(embed({ data }).output, 0n);
    addChange(tx, VALUE, [{ type: 'keyPath' }]);
    const psbt = createPsbt(tx);
    account.prepareInput(psbt, 0, { index: 62, value: VALUE });
    account.signInput(psbt, 0, { index: 62 });
    const signed = finalizePsbt(psbt);
    checkStandard(signed, { prevouts: prevoutsOf(signed, [carrier]) });
    const info = await broadcastAndConfirm(signed);
    expect(info.vout[0]).toMatchObject({
      value: 0n,
      scriptPubKey: { type: 'nulldata', hex: `6a4c50${Buffer.from(data).toString('hex')}` },
    });
  });

  it('agrees with pearld on an output above the maximum amount and on outputs that sum above it', async () => {
    // These fail before any signature is checked, so the outputs are changed after signing.
    const tooMuch = spendWithChange([{ script: recipient, value: 1_000_000n }]);
    tooMuch.outs[0]!.value = MAX_GRAIN + 1n;
    await expectSameRejection(tooMuch, false);

    const together = spendWithChange([{ script: recipient, value: 1_000_000n }]);
    together.outs[0]!.value = MAX_GRAIN;
    together.outs[1]!.value = 1n;
    await expectSameRejection(together, false);
  });

  it('agrees with pearld on duplicate inputs and on a null previous output', async () => {
    const duplicate = spendWithChange([]);
    duplicate.addInput(funding.getHash(), 0);
    duplicate.setWitness(1, duplicate.ins[0]!.witness);
    const prevout = prevoutsOf(duplicate, [funding])[0]!;
    await expectSameRejection(duplicate, false, [prevout, prevout]);

    const nullInput = spendWithChange([]);
    nullInput.addInput(new Uint8Array(32), 0xffffffff);
    nullInput.setWitness(1, nullInput.ins[0]!.witness);
    await expectSameRejection(nullInput, false, [prevout, prevout]);
  });

  it('agrees with pearld on a lone coinbase-shaped input', async () => {
    for (const script of [new Uint8Array(0), Uint8Array.of(OP_CODES.OP_1, OP_CODES.OP_1)]) {
      const coinbase = spendWithChange([]);
      coinbase.ins[0]!.hash = new Uint8Array(32);
      coinbase.ins[0]!.index = 0xffffffff;
      coinbase.ins[0]!.script = script;
      await expectSameRejection(coinbase, false, [{ script: recipient, value: VALUE }]);
    }
  });

  it('agrees with pearld that spending more than the inputs is reported before a dust output', async () => {
    const tx = spendWithChange([{ script: recipient, value: 1n }]);
    tx.outs[1]!.value = VALUE;
    await expectSameRejection(tx, false);
  });

  it('relays and mines a transaction that pays exactly the minimum relay fee', async () => {
    const carrier = await fund([{ script: toOutputScript(account.deriveAddress(63), network), value: VALUE }]);
    const tx = createTransaction(2);
    tx.addInput(carrier.getHash(), 0);
    tx.addOutput(changeScript, 0n);
    const vsize = estimateVsize(tx, [{ type: 'keyPath' }]);
    const fee = minRelayFee(vsize);
    expect(fee).toBe((BigInt(vsize) * DEFAULT_RELAY_FEE_RATE) / 1000n);
    tx.outs[0]!.value = VALUE - fee;
    const psbt = createPsbt(tx);
    account.prepareInput(psbt, 0, { index: 63, value: VALUE });
    account.signInput(psbt, 0, { index: 63 });
    const signed = finalizePsbt(psbt);
    checkStandard(signed, { prevouts: prevoutsOf(signed, [carrier]) });

    const [accepted] = await pearld.testMempoolAccept([serializeTransaction(signed)]);
    expect(accepted).toMatchObject({ allowed: true, vsize, fees: { base: fee } });
    await broadcast(signed);
    expect((await pearld.getRawMempoolVerbose())[transactionId(signed)]).toMatchObject({ fee, vsize });
    await confirm(signed);
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
