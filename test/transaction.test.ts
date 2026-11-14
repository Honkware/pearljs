import { describe, expect, it } from 'vitest';
import type { Transaction } from '../src/index.js';
import vectors from '../vectors/pearl-go.json' with { type: 'json' };
import {
  MAX_GRAIN,
  Psbt,
  addPearlOutput,
  createPsbt,
  createTransaction,
  networks,
  parsePsbt,
  parseTransaction,
  p2tr,
  serializeTransaction,
  transactionId,
  witnessTransactionId,
} from '../src/index.js';

const program = Uint8Array.from(
  Buffer.from('da4710964f7852695de2da025290e24af6d8c281de5a0b902b7135fd9fd74d21', 'hex'),
);
const output = p2tr({ internalPubkey: program }).output;

function unsignedTransaction(): Transaction {
  const tx = createTransaction();
  tx.locktime = 500;
  tx.addInput(new Uint8Array(32).fill(0x07), 2, 0xfffffffd);
  tx.addOutput(output, 123456789n);
  return tx;
}

describe('transaction helpers', () => {
  it('creates Pearl version 1 transactions by default', () => {
    expect(createTransaction().version).toBe(1);
  });

  it('round-trips raw transactions and strips witnesses independently', () => {
    const tx = unsignedTransaction();
    tx.setWitness(0, [new Uint8Array(64).fill(0x42)]);
    const parsed = parseTransaction(tx.toHex());
    expect(parsed.toHex()).toBe(tx.toHex());
    expect(serializeTransaction(parsed, false)).toBe(unsignedTransaction().toHex());
    expect(transactionId(parsed)).toBe(transactionId(unsignedTransaction()));
    expect(witnessTransactionId(parsed)).not.toBe(transactionId(parsed));
  });

  it.each(['', '0', 'xyz', '00 01'])('rejects malformed transaction hex %j', (hex) => {
    expect(() => parseTransaction(hex)).toThrow();
  });

  it('rejects out-of-range versions', () => {
    expect(() => createTransaction(0x80000000)).toThrow(RangeError);
    expect(() => createTransaction(1.5)).toThrow(RangeError);
  });
});

describe('PSBT helpers', () => {
  it('creates a PSBT with the same unsigned transaction fields', () => {
    const tx = unsignedTransaction();
    const psbt = createPsbt(tx);
    expect(psbt).toBeInstanceOf(Psbt);
    expect(psbt.version).toBe(tx.version);
    expect(psbt.locktime).toBe(tx.locktime);
    expect(psbt.inputCount).toBe(1);
    expect(psbt.txInputs[0]?.hash).toEqual(tx.ins[0]?.hash);
    expect(psbt.txInputs[0]?.index).toBe(2);
    expect(psbt.txInputs[0]?.sequence).toBe(0xfffffffd);
    expect(psbt.txOutputs[0]?.value).toBe(123456789n);
    expect(psbt.txOutputs[0]?.script).toEqual(output);
  });

  it('round-trips canonical PSBT base64', () => {
    const encoded = createPsbt(unsignedTransaction()).toBase64();
    expect(parsePsbt(encoded).toBase64()).toBe(encoded);
  });

  it('rejects non-zero padding bits even when decoding would ignore them', () => {
    const canonical = vectors.psbt.base64;
    expect(canonical.endsWith('AA==')).toBe(true);
    const altered = `${canonical.slice(0, -3)}B==`;
    expect(() => parsePsbt(altered)).toThrow('canonical padded base64');
  });

  it.each(['', 'abc', 'a===', 'AAAA\n'])('rejects noncanonical PSBT base64 %j', (value) => {
    expect(() => parsePsbt(value)).toThrow();
  });

  it('rejects signed transactions as unsigned PSBT inputs', () => {
    const tx = unsignedTransaction();
    tx.setWitness(0, [new Uint8Array(64)]);
    expect(() => createPsbt(tx)).toThrow('cannot contain signatures');
  });

  it('adds outputs through Pearl address validation', () => {
    const psbt = createPsbt(unsignedTransaction());
    const vectorAddress = 'prl1pqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqen4g90';
    addPearlOutput(psbt, vectorAddress, 1n, networks.mainnet);
    expect(psbt.txOutputs.at(-1)?.value).toBe(1n);
    expect(psbt.txOutputs.at(-1)?.script).toEqual(
      Uint8Array.from([0x51, 32, ...new Uint8Array(32)]),
    );
  });

  it('rejects invalid output values', () => {
    const psbt = createPsbt(unsignedTransaction());
    const address = 'prl1pqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqen4g90';
    expect(() => addPearlOutput(psbt, address, -1n, networks.mainnet)).toThrow();
    expect(() => addPearlOutput(psbt, address, MAX_GRAIN + 1n, networks.mainnet)).toThrow();
    expect(() => addPearlOutput(psbt, address, 1 as unknown as bigint, networks.mainnet)).toThrow(
      TypeError,
    );
  });
});
