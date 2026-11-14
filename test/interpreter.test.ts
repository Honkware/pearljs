// The interpreter's API, and the signed transactions already in the Go
// vectors: every one Pearl's engine accepted must verify here, and the ones it
// refused must fail with the engine's message. The case-by-case comparison
// with the engine is in interpreter-vectors.test.ts.

import { describe, expect, it } from 'vitest';
import {
  OP_CODES,
  SCRIPT_ERROR_CODES,
  assembleScriptTree,
  compileScript,
  createTransaction,
  debugInput,
  encodeScriptNumber,
  executeScript,
  p2mr,
  p2mrControlBlock,
  parsePsbt,
  parseTransaction,
  sha256,
  signTapscript,
  tapscriptSighash,
  verifyFinalizedPsbt,
  verifyInput,
  verifyTransaction,
} from '../src/index.js';
import type { Prevout, ScriptResult, ScriptStep } from '../src/index.js';
import * as ecc from 'tiny-secp256k1';
import vectors from '../vectors/pearl-go.json' with { type: 'json' };
import { bytesToHex, hexToBytes } from './vector-helpers.js';

function prevoutsOf(list: { script: string; value: number }[]): Prevout[] {
  return list.map((item) => ({ script: hexToBytes(item.script), value: BigInt(item.value) }));
}

/** Every signed transaction in pearl-go.json that Pearl's engine accepted, with what it spends. */
const accepted: { name: string; hex: string; prevouts: Prevout[] }[] = [
  ...vectors.signing.map((item) => ({
    name: `key path ${item.name}`,
    hex: item.finalTxHex,
    prevouts: [{ script: hexToBytes(`5120${item.tweakedPubKey}`), value: BigInt(item.value) }],
  })),
  ...vectors.scriptPathSpends.map((item) => ({
    name: `script path ${item.name}`,
    hex: item.finalTxHex,
    prevouts: prevoutsOf(item.prevouts),
  })),
  ...[...vectors.multiASpends, vectors.leaves.multiA].map((item) => ({
    name: `multi_a ${item.name}`,
    hex: item.finalTxHex,
    prevouts: prevoutsOf(item.prevouts),
  })),
  ...vectors.xmss.spends.map((item) => ({
    name: `XMSS ${item.name}`,
    hex: item.finalTxHex,
    prevouts: prevoutsOf(item.prevouts),
  })),
  ...vectors.p2mrPsbts.map((item) => ({
    name: `P2MR PSBT ${item.name}`,
    hex: item.finalTxHex,
    prevouts: prevoutsOf(item.prevouts),
  })),
  ...vectors.leaves.timelocks
    .filter((item) => item.error === '')
    .map((item) => ({ name: `timelock ${item.name}`, hex: item.spendTxHex, prevouts: prevoutsOf([item.prevout]) })),
];

function drain(steps: Generator<ScriptStep, ScriptResult, void>): { steps: ScriptStep[]; result: ScriptResult } {
  const seen: ScriptStep[] = [];
  let next = steps.next();
  while (next.done !== true) {
    seen.push(next.value);
    next = steps.next();
  }
  return { steps: seen, result: next.value };
}

const num = (value: number): Uint8Array => encodeScriptNumber(BigInt(value));

describe('signed transactions from the Go vectors', () => {
  it('covers key paths, script paths, multi_a, XMSS, P2MR PSBTs and timelocks', () => {
    expect(accepted.length).toBe(38);
  });

  for (const item of accepted) {
    it(`verifies ${item.name}`, () => {
      const tx = parseTransaction(item.hex);
      expect(verifyTransaction(tx, item.prevouts)).toEqual({ ok: true });
      tx.ins.forEach((_, index) => expect(verifyInput(tx, index, item.prevouts)).toEqual({ ok: true }));
    });

    it(`refuses ${item.name} once a witness item is changed`, () => {
      const tx = parseTransaction(item.hex);
      for (let index = 0; index < tx.ins.length; index += 1) {
        const witness = tx.ins[index]!.witness;
        for (let position = 0; position < witness.length; position += 1) {
          if (witness[position]!.length === 0) continue;
          const changed = parseTransaction(item.hex);
          const bytes = Uint8Array.from(witness[position]!);
          bytes[bytes.length - 1]! ^= 0x01;
          changed.ins[index]!.witness[position] = bytes;
          const result = verifyTransaction(changed, item.prevouts);
          expect(result.ok, `${item.name} input ${index} item ${position}`).toBe(false);
        }
      }
    });
  }

  for (const item of vectors.leaves.timelocks.filter((entry) => entry.error !== '')) {
    it(`refuses the ${item.name} spend with the engine's message`, () => {
      const result = verifyInput(parseTransaction(item.spendTxHex), 0, prevoutsOf([item.prevout]));
      expect(result).toMatchObject({ ok: false, code: 'ErrUnsatisfiedLockTime', message: item.error });
    });
  }

  it('refuses a key path spend whose amount is not the one signed', () => {
    const item = vectors.signing[0]!;
    const tx = parseTransaction(item.finalTxHex);
    const prevouts = [{ script: hexToBytes(`5120${item.tweakedPubKey}`), value: BigInt(item.value) + 1n }];
    expect(verifyInput(tx, 0, prevouts)).toEqual({ ok: false, code: 'ErrTaprootSigInvalid', message: '' });
  });

  it('computes the signature message tapscriptSighash computes', () => {
    for (const item of vectors.scriptPathSpends) {
      const tx = parseTransaction(item.finalTxHex);
      const prevouts = prevoutsOf(item.prevouts);
      const hash = tapscriptSighash(tx, item.inputIndex, prevouts, hexToBytes(item.leafHash), item.hashType);
      expect(bytesToHex(hash)).toBe(item.sighash);
      const signature = hexToBytes(item.signature).subarray(0, 64);
      const key = hexToBytes(item.leafScript).subarray(1, 33);
      expect(ecc.verifySchnorr(hash, key, signature)).toBe(true);
      expect(verifyInput(tx, item.inputIndex, prevouts)).toEqual({ ok: true });
    }
  });
});

describe('verifyInput and verifyTransaction', () => {
  const spend = vectors.scriptPathSpends[0]!;
  const tx = parseTransaction(spend.finalTxHex);
  const prevouts = prevoutsOf(spend.prevouts);

  it('reports an input index outside the transaction as the engine does', () => {
    expect(verifyInput(tx, 1, prevouts)).toEqual({
      ok: false,
      code: 'ErrInvalidIndex',
      message: 'transaction input index 1 is negative or >= 1',
    });
    expect(verifyInput(tx, -1, prevouts)).toMatchObject({ ok: false, code: 'ErrInvalidIndex' });
  });

  it('throws for prevouts that do not match the inputs', () => {
    expect(() => verifyInput(tx, 0, [])).toThrow('expected 1 prevouts, got 0');
    expect(() => verifyTransaction(tx, [{ script: prevouts[0]!.script, value: 1 as unknown as bigint }])).toThrow(
      TypeError,
    );
  });

  it('names the failing input of a transaction', () => {
    const item = vectors.p2mrPsbts.find((entry) => entry.prevouts.length > 1)!;
    const signed = parseTransaction(item.finalTxHex);
    const last = signed.ins.length - 1;
    signed.ins[last]!.witness = [];
    const result = verifyTransaction(signed, prevoutsOf(item.prevouts));
    expect(result).toEqual({
      ok: false,
      inputIndex: last,
      code: 'ErrWitnessProgramEmpty',
      message: 'witness program passed empty witness',
    });
  });

  it('passes a coinbase, which has no scripts to run', () => {
    const coinbase = createTransaction(2);
    coinbase.addInput(new Uint8Array(32), 0xffffffff);
    expect(verifyTransaction(coinbase, [{ script: new Uint8Array(0), value: 0n }])).toEqual({ ok: true });
  });

  it('says where a leaf failed', () => {
    const leaf = compileScript([OP_CODES.OP_1, OP_CODES.OP_2, OP_CODES.OP_EQUALVERIFY, OP_CODES.OP_1]);
    const tree = assembleScriptTree([leaf]);
    const spending = createTransaction(2);
    spending.addInput(new Uint8Array(32).fill(7), 0);
    spending.ins[0]!.witness = [leaf, p2mrControlBlock(tree, 0)];
    const result = verifyInput(spending, 0, [{ script: p2mr({ merkleRoot: tree.root }).output, value: 1n }]);
    expect(result).toEqual({
      ok: false,
      code: 'ErrEqualVerify',
      message: 'OP_EQUALVERIFY failed',
      at: { scriptIndex: 2, opcodeIndex: 2, offset: 2, opcode: OP_CODES.OP_EQUALVERIFY, name: 'OP_EQUALVERIFY' },
    });
  });

  it('checks the transaction of a finalized PSBT', () => {
    const item = vectors.scriptPathSpends.find((entry) => entry.kind === 'p2tr')!;
    expect(verifyFinalizedPsbt(parsePsbt(item.finalPsbt!))).toEqual({ ok: true });
    expect(() => verifyFinalizedPsbt(parsePsbt(item.preparedPsbt!))).toThrow();
  });
});

describe('debugInput', () => {
  it('steps through the output script and the leaf of a script path spend', () => {
    const item = vectors.multiASpends[0]!;
    const tx = parseTransaction(item.finalTxHex);
    const { steps, result } = drain(debugInput(tx, 0, prevoutsOf(item.prevouts)));
    expect(result).toEqual({ ok: true });
    expect(steps.slice(0, 2).map((step) => [step.scriptIndex, step.name])).toEqual([
      [1, 'OP_1'],
      [1, 'OP_DATA_32'],
    ]);
    // The step that ends the output script shows the witness stack the leaf starts with.
    expect(steps[1]!.stack).toEqual(tx.ins[0]!.witness.slice(0, -2));
    const leaf = steps.slice(2);
    expect(leaf.every((step) => step.scriptIndex === 2)).toBe(true);
    expect(leaf.map((step) => step.name).filter((name) => name.startsWith('OP_CHECKSIG'))).toEqual([
      'OP_CHECKSIG',
      'OP_CHECKSIGADD',
      'OP_CHECKSIGADD',
    ]);
    expect(leaf.at(-1)).toMatchObject({ name: 'OP_NUMEQUAL', stack: [Uint8Array.of(1)], altStack: [] });
    // Two signatures were checked, at 50 each, against 50 plus the witness size.
    const witnessSize = 1 + tx.ins[0]!.witness.reduce((sum, entry) => sum + 1 + entry.length, 0);
    expect(leaf.at(-1)!.sigOpsBudget).toBe(50 + witnessSize - 100);
  });

  it('shows a key path as the output script leaving a single true', () => {
    const item = vectors.signing[0]!;
    const prevouts = [{ script: hexToBytes(`5120${item.tweakedPubKey}`), value: BigInt(item.value) }];
    const { steps, result } = drain(debugInput(parseTransaction(item.finalTxHex), 0, prevouts));
    expect(result).toEqual({ ok: true });
    expect(steps).toHaveLength(2);
    expect(steps[1]).toMatchObject({ stack: [Uint8Array.of(1)], sigOpsBudget: null });
  });
});

describe('executeScript', () => {
  it('yields the opcode, stack and alt stack after each step', () => {
    const leaf = compileScript([OP_CODES.OP_2, OP_CODES.OP_TOALTSTACK, OP_CODES.OP_3, OP_CODES.OP_FROMALTSTACK, OP_CODES.OP_ADD, num(5), OP_CODES.OP_EQUAL]);
    const { steps, result } = drain(executeScript(leaf));
    expect(result).toEqual({ ok: true });
    expect(steps.map((step) => [step.name, step.stack.map(bytesToHex), step.altStack.map(bytesToHex)])).toEqual([
      ['OP_2', ['02'], []],
      ['OP_TOALTSTACK', [], ['02']],
      ['OP_3', ['03'], ['02']],
      ['OP_FROMALTSTACK', ['03', '02'], []],
      ['OP_ADD', ['05'], []],
      ['OP_5', ['05', '05'], []],
      ['OP_EQUAL', ['01'], []],
    ]);
    expect(steps.map((step) => step.opcodeIndex)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('marks the opcodes of a branch that does not execute', () => {
    const leaf = compileScript([OP_CODES.OP_IF, OP_CODES.OP_RESERVED, OP_CODES.OP_ELSE, OP_CODES.OP_1, OP_CODES.OP_ENDIF]);
    const { steps, result } = drain(executeScript(leaf, { stack: [new Uint8Array(0)] }));
    expect(result).toEqual({ ok: true });
    expect(steps.map((step) => step.executed)).toEqual([true, false, true, true, true]);
  });

  it('runs a hash lock with OP_CAT from the stack it is given', () => {
    const [left, right] = [Uint8Array.of(1, 2), Uint8Array.of(3)];
    const leaf = compileScript([OP_CODES.OP_CAT, OP_CODES.OP_SHA256, sha256(Uint8Array.of(1, 2, 3)), OP_CODES.OP_EQUAL]);
    expect(drain(executeScript(leaf, { stack: [left, right] })).result).toEqual({ ok: true });
    expect(drain(executeScript(leaf, { stack: [right, left] })).result).toEqual({
      ok: false,
      code: 'ErrEvalFalse',
      message: 'false stack entry at end of script execution',
    });
  });

  it('fails a reserved opcode that BIP 342 would let succeed', () => {
    const { result } = drain(executeScript(compileScript([OP_CODES.OP_1, OP_CODES.OP_RESERVED])));
    expect(result).toMatchObject({
      ok: false,
      code: 'ErrReservedOpcode',
      message: 'attempt to execute reserved opcode OP_RESERVED',
    });
  });

  it('reads lock times and signatures from the transaction it is given', () => {
    const key = new Uint8Array(32).fill(9);
    const publicKey = ecc.xOnlyPointFromScalar(key);
    const leaf = compileScript([num(500), OP_CODES.OP_CHECKLOCKTIMEVERIFY, OP_CODES.OP_DROP, publicKey, OP_CODES.OP_CHECKSIG]);
    const tree = assembleScriptTree([leaf]);
    const prevouts = [{ script: p2mr({ merkleRoot: tree.root }).output, value: 1000n }];
    const tx = createTransaction(2);
    tx.addInput(new Uint8Array(32).fill(1), 0, 0xfffffffe);
    tx.locktime = 500;
    const signer = { publicKey, signSchnorr: (hash: Uint8Array) => ecc.signSchnorr(hash, key) };
    const signature = signTapscript(tx, 0, prevouts, leaf, signer);
    expect(drain(executeScript(leaf, { stack: [signature], tx, prevouts })).result).toEqual({ ok: true });
    tx.locktime = 499;
    expect(drain(executeScript(leaf, { stack: [signature], tx, prevouts })).result).toMatchObject({
      code: 'ErrUnsatisfiedLockTime',
      at: { name: 'OP_CHECKLOCKTIMEVERIFY' },
    });
    // Without a transaction the lock time is 0.
    expect(drain(executeScript(leaf, { stack: [signature] })).result).toMatchObject({ code: 'ErrUnsatisfiedLockTime' });
  });

  it('refuses an annex that does not start with 0x50 and prevouts without a transaction', () => {
    expect(() => executeScript(Uint8Array.of(OP_CODES.OP_1), { annex: Uint8Array.of(0x51) })).toThrow('0x50');
    expect(() => executeScript(Uint8Array.of(OP_CODES.OP_1), { prevouts: [] })).toThrow('without the transaction');
  });
});

/** mulberry32: a seeded generator, so a failure names a case that can be run again. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('random input', () => {
  const codes = new Set<string>(SCRIPT_ERROR_CODES);
  const random = seeded(0x5eed);
  const int = (below: number): number => Math.floor(random() * below);
  const bytes = (length: number): Uint8Array => Uint8Array.from({ length }, () => int(256));
  const item = (): Uint8Array => (int(3) === 0 ? bytes(int(80)) : num(int(40) - 8));

  it('never throws and never takes more steps than the script has bytes, for 20000 random leaves', () => {
    const seen = new Set<string>();
    for (let round = 0; round < 20000; round += 1) {
      // Half are raw bytes, half lean on opcodes that do something.
      const script =
        int(2) === 0 ? bytes(int(60)) : Uint8Array.from({ length: int(40) }, () => (int(4) === 0 ? int(256) : 0x4f + int(0x6c)));
      const stack = Array.from({ length: int(6) }, item);
      const options = int(8) === 0 ? { stack, annex: Uint8Array.of(0x50, int(256)) } : { stack };
      const { steps, result } = drain(executeScript(script, options));
      expect(steps.length, `leaf ${bytesToHex(script)}`).toBeLessThanOrEqual(script.length);
      if (!result.ok) {
        expect(codes.has(result.code), `leaf ${bytesToHex(script)} gave ${result.code}`).toBe(true);
        seen.add(result.code);
      } else {
        seen.add('accepted');
      }
    }
    expect(seen.size).toBeGreaterThan(15);
    expect(seen.has('accepted')).toBe(true);
  });

  it('never throws for 5000 random output scripts, signature scripts and witnesses', () => {
    for (let round = 0; round < 5000; round += 1) {
      const tx = createTransaction(int(3));
      const count = 1 + int(3);
      const prevouts: Prevout[] = [];
      for (let index = 0; index < count; index += 1) {
        tx.addInput(bytes(32), int(4), int(2) === 0 ? 0xffffffff : int(0x10000));
        tx.ins[index]!.witness = Array.from({ length: int(5) }, () => (int(4) === 0 ? Uint8Array.of(0x50) : bytes(int(70))));
        if (int(6) === 0) tx.ins[index]!.script = bytes(int(6));
        const kind = int(4);
        const script =
          kind === 0 ? bytes(int(45)) : Uint8Array.of(kind === 1 ? OP_CODES.OP_1 : kind === 2 ? OP_CODES.OP_2 : int(256), 32, ...bytes(32));
        prevouts.push({ script, value: BigInt(int(1_000_000)) });
      }
      for (let output = int(3); output > 0; output -= 1) tx.addOutput(bytes(int(40)), BigInt(int(1000)));
      const result = verifyTransaction(tx, prevouts);
      if (!result.ok) expect(codes.has(result.code)).toBe(true);
    }
  });
});
