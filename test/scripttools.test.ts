// The script toolkit against Pearl's txscript: the opcode table, one-line
// disassembly for every byte and for real scripts, push-only checks, script
// numbers, and which opcodes Pearl's engine treats as disabled.

import { describe, expect, it } from 'vitest';
import {
  compileScript,
  decodeScriptNumber,
  decompileScript,
  isDisabledOpcode,
  isPushOnlyScript,
  OP_CODES,
  OPCODE_NAMES,
  scriptFromAsm,
  scriptToAsm,
} from '../src/index.js';
import vectors from '../vectors/pearl-go.json' with { type: 'json' };
import { bytesToHex, hexToBytes } from './vector-helpers.js';

const toolkit = vectors.scriptToolkit;

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
      expect(bytesToHex(scriptFromAsm(expected.disasm))).toBe(expected.script);
    }
    // A one-byte push of 0x10 prints as "10", which reads back as OP_10.
    expect(scriptFromAsm('10 81')).toEqual(Uint8Array.of(OP_CODES.OP_10, 0x01, 0x81));
    expect(scriptFromAsm('OP_TRUE OP_NOP2')).toEqual(Uint8Array.of(OP_CODES.OP_1, OP_CODES.OP_CHECKLOCKTIMEVERIFY));
    expect(() => scriptFromAsm('OP_NOTREAL')).toThrow('unknown');
    expect(() => scriptFromAsm('abc')).toThrow('cannot parse');
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
        expect(decode()).toBe(expected.value);
      } else {
        expect(decode).toThrow(expected.error);
      }
    }
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
