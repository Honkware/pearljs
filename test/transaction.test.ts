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

  it('rejects bytes after the last PSBT map, as Pearl does', () => {
    const bytes = Buffer.from(vectors.psbt.base64, 'base64');
    for (const extra of [[0x00], [0x2a, 0x98, 0xd0], [0x01, 0xfc, 0x00, 0x00]]) {
      const encoded = Buffer.concat([bytes, Buffer.from(extra)]).toString('base64');
      expect(() => parsePsbt(encoded)).toThrow(`invalid PSBT: ${extra.length} bytes follow the last map`);
    }
    for (const signed of vectors.signing) {
      expect(parsePsbt(signed.finalPsbt).toBase64()).toBe(signed.finalPsbt);
    }
  });

  it('rejects a PSBT length written as a non-canonical varint, as Pearl does', () => {
    const bytes = [...Buffer.from(vectors.psbt.base64, 'base64')];
    // The global map starts with key length 1; write it as fd 01 00.
    expect(bytes[5]).toBe(1);
    const widened = Buffer.from([...bytes.slice(0, 5), 0xfd, 1, 0, ...bytes.slice(6)]).toString('base64');
    expect(() => parsePsbt(widened)).toThrow('invalid PSBT');
  });

  it('reports every malformed PSBT as an Error with a message, never a RangeError', () => {
    // bip174 reads a count from this tap BIP32 derivation and builds an array of that length.
    const prepared = Buffer.from(vectors.signing[0]!.preparedPsbt, 'base64');
    let rangeErrors = 0;
    let malformed = 0;
    for (let at = 0; at < prepared.length; at += 1) {
      for (const byte of [0xfd, 0xfe, 0xff]) {
        const mutated = Buffer.from(prepared);
        mutated[at] = byte;
        try {
          parsePsbt(mutated.toString('base64'));
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
          if (error instanceof RangeError) rangeErrors += 1;
          expect((error as Error).message).not.toContain('Invalid array length');
          if ((error as Error).message === 'invalid PSBT: a field is malformed') malformed += 1;
        }
      }
    }
    expect(rangeErrors).toBe(0);
    expect(malformed).toBeGreaterThan(0);
  });

  it('rejects an input sighash type that is not 4 bytes, as Pearl does', () => {
    const tx = unsignedTransaction();
    const psbt = createPsbt(tx);
    psbt.updateInput(0, { sighashType: 1 });
    const bytes = [...psbt.toBuffer()];
    // The field is 01 03 04 01000000: key length, key type, value length, value.
    const at = bytes.findIndex((_, i) => [1, 3, 4, 1, 0, 0, 0].every((byte, j) => bytes[i + j] === byte));
    expect(at).toBeGreaterThan(0);
    const longer = Buffer.from([...bytes.slice(0, at + 2), 5, 1, 0, 0, 0, 0x82, ...bytes.slice(at + 7)]);
    expect(() => parsePsbt(longer.toString('base64'))).toThrow('input 0 has a sighash type of 5 bytes, not 4');
    expect(parsePsbt(Buffer.from(bytes).toString('base64')).data.inputs[0]!.sighashType).toBe(1);
  });

  it('rejects input that is not a string with a clear error', () => {
    for (const bad of [undefined, null, 7, new Uint8Array(4), {}]) {
      expect(() => parsePsbt(bad as unknown as string)).toThrow('PSBT must be a base64 string');
      expect(() => parseTransaction(bad as unknown as string)).toThrow('transaction must be a hexadecimal string');
    }
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
