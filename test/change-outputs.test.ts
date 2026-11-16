// Change an offline signer can recognise. The online machine records on its
// change output where the key sits under the account, with the bytes Oyster
// writes (wallet/wallet/psbt.go createOutputInfo, rebuilt in the Go vectors);
// the offline machine derives the key again and compares scripts, so a
// record on someone else's output proves nothing.

import { describe, expect, it } from 'vitest';
import {
  PearlError,
  buildPayment,
  checkPsbtPayment,
  createPsbt,
  createTransaction,
  deriveSigningAccountFromSeed,
  finalizePsbt,
  importWatchOnlyAccount,
  networks,
  parsePsbt,
  parseTransaction,
  psbtOutputs,
  toOutputScript,
  verifyFinalizedPsbt,
} from '../src/index.js';
import type { AccountUtxo, Payment, Psbt } from '../src/index.js';
import vectors from '../vectors/pearl-go.json' with { type: 'json' };
import { hexToBytes } from './vector-helpers.js';

const network = networks.mainnet;
const seed = hexToBytes(vectors.bip86.seed);
const cold = deriveSigningAccountFromSeed(seed, network);
const exported = cold.watchOnlyAccount();
const hot = importWatchOnlyAccount(exported.extendedPublicKey(), network, {
  masterFingerprint: exported.masterFingerprint!,
  path: exported.path!,
});
const other = deriveSigningAccountFromSeed(seed, network, 1).watchOnlyAccount();
const customer = other.deriveAddress(0);
const AMOUNT = 150_000_000n;

function code(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(PearlError);
    return (err as PearlError).code;
  }
  throw new Error('nothing was thrown');
}

const utxos: AccountUtxo[] = [0, 1].map((index) => ({
  txid: `${index + 1}`.repeat(64),
  vout: 0,
  value: 100_000_000n,
  script: toOutputScript(hot.deriveAddress(index), network),
  index,
  confirmations: 6,
}));

/** A withdrawal as the online machine builds it: inputs prepared, change recorded. */
function withdrawal(changeFrom = { account: hot, index: 7 }): Payment<AccountUtxo> {
  const payment = buildPayment({ network, utxos, recipients: [{ address: customer, amount: AMOUNT }], feeRate: 2000n, changeFrom });
  payment.inputs.forEach((utxo, i) => hot.prepareInput(payment.psbt, i, utxo));
  return payment;
}

/** The same PSBT with its change output paying someone else, the records left as they were. */
function withChangeSwapped(payment: Payment<AccountUtxo>): Psbt {
  const tx = payment.transaction.clone();
  tx.outs[payment.changeIndex]!.script = toOutputScript(other.deriveAddress(5, true), network);
  const forged = createPsbt(tx);
  payment.psbt.data.inputs.forEach((input, i) => {
    forged.data.inputs[i] = { ...input };
  });
  forged.data.outputs[payment.changeIndex] = { ...payment.psbt.data.outputs[payment.changeIndex]! };
  return parsePsbt(forged.toBase64());
}

describe('recording that an output is the account\'s own', () => {
  for (const vector of vectors.changeOutputs) {
    it(`writes the bytes Oyster writes for ${vector.name}, and reads them back`, () => {
      const psbt = createPsbt(parseTransaction(vector.unsignedTxHex));
      hot.prepareOutput(psbt, vector.outputIndex, { index: vector.index, change: vector.change });
      expect(psbt.toBase64()).toBe(vector.psbt);
      expect(psbt.data.outputs[vector.outputIndex]!.tapBip32Derivation![0]!.path).toBe(vector.path);

      const outputs = psbtOutputs(parsePsbt(vector.psbt), network, cold.watchOnlyAccount());
      expect(outputs.map((output) => output.mine)).toEqual([false, true]);
      expect(outputs[1]!.child).toEqual({ index: vector.index, change: vector.change });
      expect(outputs[0]!.child).toBeUndefined();
    });
  }

  it('refuses to record a child the output does not pay', () => {
    const vector = vectors.changeOutputs[0]!;
    const psbt = createPsbt(parseTransaction(vector.unsignedTxHex));
    expect(code(() => hot.prepareOutput(psbt, 1, { index: vector.index }))).toBe('OUTPUT_MISMATCH');
    expect(code(() => cold.prepareOutput(psbt, 0, { index: vector.index, change: true }))).toBe('OUTPUT_MISMATCH');
    expect(() => hot.prepareOutput(psbt, 2, { index: 0 })).toThrow(RangeError);
    expect(psbt.data.outputs.every((output) => output.tapBip32Derivation === undefined)).toBe(true);
  });

  it('records the change of buildPayment when the change comes from an account', () => {
    const payment = withdrawal();
    expect(payment.changeIndex).toBe(1);
    const outputs = psbtOutputs(payment.psbt, network, hot);
    expect(outputs[1]).toMatchObject({ mine: true, child: { index: 7, change: true }, address: hot.deriveAddress(7, true) });
    expect(outputs[0]!.mine).toBe(false);

    const plain = buildPayment({ network, utxos, recipients: [{ address: customer, amount: AMOUNT }], feeRate: 2000n, changeAddress: hot.deriveAddress(7, true) });
    expect(psbtOutputs(plain.psbt, network, hot)[1]!.mine).toBe(false);
    expect(psbtOutputs(plain.psbt, network)[1]).not.toHaveProperty('mine');
    expect(() =>
      buildPayment({ network, utxos, recipients: [{ address: customer, amount: AMOUNT }], feeRate: 2000n, changeFrom: { account: hot, index: 7 }, changeAddress: customer }),
    ).toThrow('changeAddress or changeFrom, not both');
  });

  it('recognises a record written under the account key by an account imported without its origin', () => {
    const bare = importWatchOnlyAccount(exported.extendedPublicKey(), network);
    const payment = withdrawal({ account: bare, index: 7 });
    expect(payment.psbt.data.outputs[1]!.tapBip32Derivation![0]!.path).toBe('m/1/7');
    expect(psbtOutputs(payment.psbt, network, cold.watchOnlyAccount())[1]!.mine).toBe(true);
    expect(psbtOutputs(payment.psbt, network, other)[1]!.mine).toBe(false);
  });
});

describe('proving an output from its record', () => {
  it('does not believe a record on an output that pays someone else', () => {
    const forged = withChangeSwapped(withdrawal());
    expect(forged.data.outputs[1]!.tapBip32Derivation![0]!.path).toBe(`${hot.path}/1/7`);
    expect(psbtOutputs(forged, network, hot)[1]!.mine).toBe(false);
  });

  it('does not believe a record whose path, key or fingerprint was edited', () => {
    const edit = (change: (record: { path: string; pubkey: Uint8Array; masterFingerprint: Uint8Array }) => void): boolean => {
      const { psbt } = withdrawal();
      const fields = psbt.data.outputs[1]!;
      for (const record of [...fields.tapBip32Derivation!, ...fields.bip32Derivation!]) change(record);
      return psbtOutputs(psbt, network, hot)[1]!.mine!;
    };
    expect(edit(() => undefined)).toBe(true);
    expect(edit((record) => (record.path = `${hot.path}/1/8`))).toBe(false);
    expect(edit((record) => (record.path = `${hot.path}/0/7`))).toBe(false);
    expect(edit((record) => (record.path = `${hot.path}/1/7/0`))).toBe(false);
    expect(edit((record) => (record.path = `${other.path}/1/7`))).toBe(false);
    expect(edit((record) => (record.masterFingerprint = Uint8Array.of(1, 2, 3, 4)))).toBe(false);
    expect(edit((record) => (record.pubkey = record.pubkey.length === 33 ? Uint8Array.from([2, ...hot.derivePublicKey(8, true)]) : hot.derivePublicKey(8, true)))).toBe(false);
  });

  it('accepts either record alone', () => {
    const taprootOnly = withdrawal().psbt;
    delete taprootOnly.data.outputs[1]!.bip32Derivation;
    expect(psbtOutputs(taprootOnly, network, hot)[1]!.mine).toBe(true);
    const legacyOnly = withdrawal().psbt;
    delete legacyOnly.data.outputs[1]!.tapBip32Derivation;
    expect(psbtOutputs(legacyOnly, network, hot)[1]!.mine).toBe(true);
  });
});

describe('checkPsbtPayment', () => {
  const recipients = [{ address: customer, amount: AMOUNT }];

  it('reports what leaves and what returns, and the cold machine signs after it', () => {
    const payment = withdrawal();
    const received = parsePsbt(payment.psbt.toBase64());
    const summary = checkPsbtPayment(received, cold.watchOnlyAccount(), { network, recipients, maxFee: 1000n });
    expect(summary.sent).toBe(AMOUNT);
    expect(summary.change).toBe(payment.change);
    expect(summary.fee).toBe(payment.fee);
    expect(summary.sent + summary.change + summary.fee).toBe(200_000_000n);
    expect(summary.outputs.map((output) => output.mine)).toEqual([false, true]);
    for (let i = 0; i < received.inputCount; i += 1) cold.signInput(received, i);
    finalizePsbt(received);
    expect(verifyFinalizedPsbt(received)).toEqual({ ok: true });
  });

  it('refuses change that was swapped for another address', () => {
    const forged = withChangeSwapped(withdrawal());
    expect(code(() => checkPsbtPayment(forged, cold.watchOnlyAccount(), { network, recipients }))).toBe('PSBT_OUTPUT_UNEXPECTED');
  });

  it('refuses change that carries no record, and an output nobody asked for', () => {
    const plain = buildPayment({ network, utxos, recipients, feeRate: 2000n, changeAddress: hot.deriveAddress(7, true) });
    plain.inputs.forEach((utxo, i) => hot.prepareInput(plain.psbt, i, utxo));
    expect(code(() => checkPsbtPayment(plain.psbt, hot, { network, recipients }))).toBe('PSBT_OUTPUT_UNEXPECTED');

    const two = buildPayment({
      network, utxos, feeRate: 2000n, changeFrom: { account: hot, index: 7 },
      recipients: [...recipients, { address: other.deriveAddress(3), amount: 1_000_000n }],
    });
    two.inputs.forEach((utxo, i) => hot.prepareInput(two.psbt, i, utxo));
    expect(code(() => checkPsbtPayment(two.psbt, hot, { network, recipients }))).toBe('PSBT_OUTPUT_UNEXPECTED');
  });

  it('refuses a recipient paid another amount, and matches each recipient to its own output', () => {
    const { psbt } = withdrawal();
    expect(code(() => checkPsbtPayment(psbt, hot, { network, recipients: [{ address: customer, amount: AMOUNT + 1n }] }))).toBe(
      'PSBT_RECIPIENT_MISSING',
    );
    expect(code(() => checkPsbtPayment(psbt, hot, { network, recipients: [...recipients, ...recipients] }))).toBe('PSBT_RECIPIENT_MISSING');
    // An output named as a recipient is a payment, not change, even when the account holds it.
    const own = [{ address: hot.deriveAddress(7, true), amount: psbt.txOutputs[1]!.value }];
    expect(checkPsbtPayment(psbt, hot, { network, recipients: [...recipients, ...own] }).change).toBe(0n);
  });

  it('refuses a fee above the limit, outputs above the inputs, and inputs it cannot read', () => {
    const payment = withdrawal();
    expect(code(() => checkPsbtPayment(payment.psbt, hot, { network, recipients, maxFee: payment.fee - 1n }))).toBe('FEE_TOO_HIGH');
    expect(checkPsbtPayment(payment.psbt, hot, { network, recipients, maxFee: payment.fee }).fee).toBe(payment.fee);
    expect(() => checkPsbtPayment(payment.psbt, hot, { network, recipients, maxFee: 5 as unknown as bigint })).toThrow(TypeError);

    const short = withdrawal().psbt;
    short.data.inputs[0]!.witnessUtxo = { ...short.data.inputs[0]!.witnessUtxo!, value: 1n };
    expect(code(() => checkPsbtPayment(short, hot, { network, recipients }))).toBe('OUTPUTS_EXCEED_INPUTS');

    const bare = withdrawal().psbt;
    delete bare.data.inputs[1]!.witnessUtxo;
    expect(code(() => checkPsbtPayment(bare, hot, { network, recipients }))).toBe('INPUT_UNPREPARED');

    const funding = createTransaction(2);
    funding.addInput(new Uint8Array(32).fill(9), 0);
    funding.addOutput(utxos[0]!.script, 900_000_000n);
    const inflated = withdrawal().psbt;
    inflated.data.inputs[0]!.nonWitnessUtxo = funding.toBuffer();
    expect(code(() => checkPsbtPayment(inflated, hot, { network, recipients }))).toBe('PREVOUT_MISMATCH');
  });
});
