// The script toolkit against Pearl's txscript: the opcode table, one-line
// disassembly for every byte and for real scripts, push-only checks, script
// numbers, and which opcodes Pearl's engine treats as disabled.

import { describe, expect, it } from 'vitest';
import {
  compileScript,
  decodeScriptNumber,
  decompileScript,
  encodeScriptNumber,
  isDisabledOpcode,
  isPushOnlyScript,
  OP_CODES,
  OPCODE_NAMES,
  scriptFromAsm,
  scriptToAsm,
} from '../src/index.js';
import type { ScriptChunk } from '../src/index.js';
import vectors from '../vectors/pearl-go.json' with { type: 'json' };
import { bytesToHex, hexToBytes } from './vector-helpers.js';

const toolkit = vectors.scriptToolkit;

/** mulberry32, so the random scripts are the same on every run. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('script toolkit', () => {
  it('has exactly Pearl\'s opcode names and values', () => {
    expect({ ...OP_CODES }).toEqual(toolkit.opcodeByName);
  });

  it('names every byte as Pearl does', () => {
    for (const expected of toolkit.opcodes) {
      const name = OPCODE_NAMES[expected.value]!;
      expect(OP_CODES[name as keyof typeof OP_CODES]).toBe(expected.value);
    }
    expect(OPCODE_NAMES[0xde]).toBe('OP_CHECKXMSSSIG');
    expect(OPCODE_NAMES[0xb1]).toBe('OP_CHECKLOCKTIMEVERIFY');
  });

  it('disassembles every one-byte script like DisasmString', () => {
    for (const expected of toolkit.opcodes) {
      expect(scriptToAsm(Uint8Array.of(expected.value))).toBe(expected.disasm);
    }
  });

  for (const expected of toolkit.disasm) {
    it(`disassembles ${expected.name} like DisasmString`, () => {
      const script = hexToBytes(expected.script);
      expect(scriptToAsm(script)).toBe(expected.disasm);
      expect(isPushOnlyScript(script)).toBe(expected.pushOnly);
      if (expected.error) {
        expect(() => decompileScript(script)).toThrow('remaining');
      }
    });
  }

  // Scripts whose pushes are already canonical, so they survive both round trips.
  const canonical = ['p2tr', 'p2mr', 'nulldata', 'multi-a', 'xmss-leaf', 'hashlock', 'timelock', 'small-ints', 'cat-and-xmss', 'unknown-and-disabled', 'empty'];

  it('decompiles and recompiles canonical scripts unchanged', () => {
    for (const name of canonical) {
      const expected = toolkit.disasm.find((item) => item.name === name)!;
      expect(bytesToHex(compileScript(decompileScript(hexToBytes(expected.script))))).toBe(expected.script);
    }
  });

  it('parses the one-line format back into the same script', () => {
    for (const name of canonical) {
      const expected = toolkit.disasm.find((item) => item.name === name)!;
      const script = hexToBytes(expected.script);
      expect(bytesToHex(scriptFromAsm(scriptToAsm(script, { unambiguous: true })))).toBe(expected.script);
      if (/(^| )1[0-6]( |$)/.test(expected.disasm)) {
        expect(() => scriptFromAsm(expected.disasm)).toThrow('is ambiguous');
      } else {
        expect(bytesToHex(scriptFromAsm(expected.disasm))).toBe(expected.script);
      }
    }
    expect(scriptFromAsm('OP_TRUE OP_NOP2')).toEqual(Uint8Array.of(OP_CODES.OP_1, OP_CODES.OP_CHECKLOCKTIMEVERIFY));
    expect(() => scriptFromAsm('OP_NOTREAL')).toThrow('unknown');
    expect(() => scriptFromAsm('abc')).toThrow('cannot parse');
    expect(() => scriptFromAsm(undefined as unknown as string)).toThrow(TypeError);
    // One word of 300,000 hex characters used to overflow the call stack.
    expect(scriptFromAsm('ab'.repeat(150_000))).toHaveLength(150_005);
  });

  it('refuses words that DisasmString prints for two different scripts', () => {
    // OP_10 and a one-byte push of 0x10 both print as "10".
    const opcode = Uint8Array.of(OP_CODES.OP_10);
    const push = Uint8Array.of(0x01, 0x10);
    expect(scriptToAsm(opcode)).toBe('10');
    expect(scriptToAsm(push)).toBe('10');
    for (let n = 10; n <= 16; n += 1) {
      expect(() => scriptFromAsm(`OP_DUP ${n}`)).toThrow(`write OP_${n} for the number or 0x${n} for a one-byte push`);
    }
    expect(scriptToAsm(opcode, { unambiguous: true })).toBe('OP_10');
    expect(scriptToAsm(push, { unambiguous: true })).toBe('0x10');
    expect(scriptFromAsm('OP_10')).toEqual(opcode);
    expect(scriptFromAsm('0x10')).toEqual(push);
    // Outside 0x10 to 0x16 a two-digit word is only ever data.
    expect(scriptFromAsm('09 17 81')).toEqual(Uint8Array.of(1, 0x09, 1, 0x17, 1, 0x81));
    expect(scriptFromAsm('9')).toEqual(Uint8Array.of(OP_CODES.OP_9));
  });

  it('refuses an empty word instead of dropping a zero-length push', () => {
    // OP_PUSHDATA1 with length 0 pushes an empty item and prints as nothing.
    const script = Uint8Array.of(OP_CODES.OP_DUP, OP_CODES.OP_PUSHDATA1, 0, OP_CODES.OP_EQUAL);
    expect(scriptToAsm(script)).toBe('OP_DUP  OP_EQUAL');
    expect(() => scriptFromAsm('OP_DUP  OP_EQUAL')).toThrow('empty word');
    expect(() => scriptFromAsm(' OP_DUP')).toThrow('empty word');
    expect(() => scriptFromAsm('OP_DUP ')).toThrow('empty word');
    expect(() => scriptFromAsm('OP_DUP\nOP_EQUAL')).toThrow('unknown or push opcode');
    expect(scriptToAsm(script, { unambiguous: true })).toBe('OP_DUP 0x OP_EQUAL');
    // The empty string is read as the empty script, although a script that is
    // only a zero-length PUSHDATA prints that way too.
    expect(scriptToAsm(Uint8Array.of(OP_CODES.OP_PUSHDATA1, 0))).toBe('');
    expect(scriptToAsm(Uint8Array.of(OP_CODES.OP_PUSHDATA1, 0), { unambiguous: true })).toBe('0x');
    expect(scriptFromAsm('')).toEqual(new Uint8Array(0));
    // An empty push comes back as OP_0, which pushes the same empty item.
    expect(scriptFromAsm('OP_DUP 0x OP_EQUAL')).toEqual(Uint8Array.of(OP_CODES.OP_DUP, OP_CODES.OP_0, OP_CODES.OP_EQUAL));
  });

  it('round-trips random scripts to the same pushed values', () => {
    const random = prng(0x5eed);
    const int = (n: number): number => Math.floor(random() * n);
    const bytes = (n: number): number[] => Array.from({ length: n }, () => int(256));
    const pieces: (() => number[])[] = [
      () => [int(256)],
      () => { const n = int(76); return [n, ...bytes(n)]; },
      () => { const n = int(90); return [OP_CODES.OP_PUSHDATA1, n, ...bytes(n)]; },
      () => { const n = int(300); return [OP_CODES.OP_PUSHDATA2, n & 0xff, n >> 8, ...bytes(n)]; },
      () => { const n = int(20); return [OP_CODES.OP_PUSHDATA4, n, 0, 0, 0, ...bytes(n)]; },
      () => [1, int(0x18)],
      () => [OP_CODES.OP_1 + int(16)],
      () => [OP_CODES.OP_0],
      () => [OP_CODES.OP_1NEGATE],
    ];
    // What each chunk leaves on the stack, or the opcode itself when it is not a push.
    const value = (chunk: ScriptChunk): string => {
      if (chunk instanceof Uint8Array) return bytesToHex(chunk);
      if (chunk === OP_CODES.OP_0) return '';
      if (chunk === OP_CODES.OP_1NEGATE) return '81';
      if (chunk >= OP_CODES.OP_1 && chunk <= OP_CODES.OP_16) return bytesToHex(Uint8Array.of(chunk - OP_CODES.OP_1 + 1));
      return `op${chunk}`;
    };
    let ambiguous = 0;
    for (let i = 0; i < 3000; i += 1) {
      const script = Uint8Array.from(Array.from({ length: 1 + int(8) }, () => pieces[int(pieces.length)]!()).flat());
      let chunks: ScriptChunk[];
      try {
        chunks = decompileScript(script);
      } catch {
        continue; // a random opcode byte started a push that runs past the end
      }
      const values = chunks.map(value);
      const back = scriptFromAsm(scriptToAsm(script, { unambiguous: true }));
      expect(decompileScript(back).map(value)).toEqual(values);
      // The exact DisasmString text is either refused or reads back to the same values.
      // The empty string is the one exception; see the test above.
      if (scriptToAsm(script) === '') continue;
      try {
        expect(decompileScript(scriptFromAsm(scriptToAsm(script))).map(value)).toEqual(values);
      } catch (error) {
        expect((error as Error).message).toMatch(/is ambiguous|empty word/);
        ambiguous += 1;
      }
    }
    expect(ambiguous).toBeGreaterThan(100);
  });

  it('compiles data with the canonical push and rejects push opcodes as numbers', () => {
    expect(compileScript([Uint8Array.of(5), OP_CODES.OP_CHECKSIG])).toEqual(Uint8Array.of(OP_CODES.OP_5, OP_CODES.OP_CHECKSIG));
    expect(compileScript([new Uint8Array(76)])[0]).toBe(OP_CODES.OP_PUSHDATA1);
    expect(() => compileScript([0x20])).toThrow('not an opcode');
  });

  it('decodes script numbers like MakeScriptNum', () => {
    for (const expected of toolkit.numbers) {
      const decode = () =>
        decodeScriptNumber(hexToBytes(expected.data), { requireMinimal: expected.minimal, maxLength: expected.maxLength });
      if (expected.error === '') {
        expect(decode()).toBe(BigInt(expected.value));
      } else {
        expect(decode).toThrow(expected.error);
      }
    }
  });

  it('decodes long script numbers exactly', () => {
    const big = 2n ** 60n + 1n;
    expect(decodeScriptNumber(encodeScriptNumber(big), { maxLength: 8 })).toBe(big);
    expect(decodeScriptNumber(encodeScriptNumber(-big), { maxLength: 8 })).toBe(-big);
    // Negative zero is zero, as in Go.
    expect(decodeScriptNumber(Uint8Array.of(0x80), { requireMinimal: false })).toBe(0n);
    expect(() => decodeScriptNumber('00' as unknown as Uint8Array)).toThrow(TypeError);
  });

  it('marks as disabled exactly the opcodes Pearl\'s engine rejects as disabled', () => {
    for (const expected of toolkit.opcodes) {
      expect(isDisabledOpcode(expected.value)).toBe(/disabled/.test(expected.leafError));
    }
  });

  it('has no OP_SUCCESS opcodes: no single byte makes a leaf spend except pushes of true', () => {
    const spends = toolkit.opcodes.filter((item) => item.leafError === '').map((item) => item.value);
    const trueValues = [OP_CODES.OP_1NEGATE, ...Array.from({ length: 16 }, (_, i) => OP_CODES.OP_1 + i)];
    expect(spends).toEqual(trueValues);
  });
});
