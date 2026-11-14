// Building and reading scripts the way Pearl's txscript does: compile and
// decompile, the one-line disassembly of DisasmString (what decodescript
// shows), script numbers, and opcode properties.
//
// Pearl differs from Bitcoin's tapscript in two ways that matter when
// writing leaves: OP_CAT is enabled, and the BIP 342 OP_SUCCESS rule is gone,
// so a reserved or unknown opcode makes a leaf fail instead of succeed.

import { OP_CODES, OPCODE_NAMES } from './opcodes.js';
import { scriptPush } from './script.js';

/** A decompiled script: opcodes as numbers, pushed data as byte arrays. */
export type ScriptChunk = number | Uint8Array;

const OP_DATA_75 = 0x4b;

function isPushOpcode(opcode: number): boolean {
  return opcode >= 0x01 && opcode <= OP_CODES.OP_PUSHDATA4;
}

interface Token {
  opcode: number;
  data: Uint8Array | null;
}

interface TokenizeResult {
  tokens: Token[];
  error: string | null;
}

/** txscript.ScriptTokenizer: stops at the first push that runs past the end. */
function tokenize(script: Uint8Array): TokenizeResult {
  const tokens: Token[] = [];
  let offset = 0;
  while (offset < script.length) {
    const opcode = script[offset]!;
    let lengthBytes = 0;
    let dataLength = 0;
    if (opcode >= 0x01 && opcode <= OP_DATA_75) {
      dataLength = opcode;
    } else if (opcode === OP_CODES.OP_PUSHDATA1) {
      lengthBytes = 1;
    } else if (opcode === OP_CODES.OP_PUSHDATA2) {
      lengthBytes = 2;
    } else if (opcode === OP_CODES.OP_PUSHDATA4) {
      lengthBytes = 4;
    }
    const remaining = script.length - offset - 1;
    if (lengthBytes > 0) {
      if (remaining < lengthBytes) {
        return {
          tokens,
          error: `opcode ${OPCODE_NAMES[opcode]} requires ${lengthBytes} bytes, but script only has ${remaining} remaining`,
        };
      }
      for (let i = lengthBytes - 1; i >= 0; i -= 1) dataLength = dataLength * 256 + script[offset + 1 + i]!;
      if (remaining - lengthBytes < dataLength) {
        return {
          tokens,
          error: `opcode ${OPCODE_NAMES[opcode]} pushes ${dataLength} bytes, but script only has ${remaining - lengthBytes} remaining`,
        };
      }
    } else if (dataLength > 0 && remaining < dataLength) {
      return {
        tokens,
        error: `opcode ${OPCODE_NAMES[opcode]} requires ${dataLength + 1} bytes, but script only has ${remaining + 1} remaining`,
      };
    }
    const start = offset + 1 + lengthBytes;
    tokens.push({ opcode, data: isPushOpcode(opcode) ? script.slice(start, start + dataLength) : null });
    offset = start + dataLength;
  }
  return { tokens, error: null };
}

/** Splits a script into opcodes and pushed data; throws on a truncated push. */
export function decompileScript(script: Uint8Array): ScriptChunk[] {
  const { tokens, error } = tokenize(script);
  if (error !== null) throw new Error(error);
  return tokens.map((token) => token.data ?? token.opcode);
}

/**
 * Builds a script from opcodes and data. Data is pushed the way
 * ScriptBuilder.AddData pushes it, so small values become OP_0 to OP_16.
 */
export function compileScript(chunks: readonly ScriptChunk[]): Uint8Array {
  const out: number[] = [];
  for (const chunk of chunks) {
    if (chunk instanceof Uint8Array) {
      out.push(...scriptPush(chunk));
    } else if (Number.isInteger(chunk) && chunk >= 0 && chunk <= 0xff && !isPushOpcode(chunk)) {
      out.push(chunk);
    } else {
      throw new Error(`${String(chunk)} is not an opcode; pass pushed data as a Uint8Array`);
    }
  }
  return Uint8Array.from(out);
}

const SMALL_INT_NAMES: Record<number, string> = { [OP_CODES.OP_0]: '0', [OP_CODES.OP_1NEGATE]: '-1' };
for (let n = 1; n <= 16; n += 1) SMALL_INT_NAMES[OP_CODES.OP_1 + n - 1] = String(n);

const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * One-line disassembly, identical to DisasmString: pushed data as hex,
 * OP_0 to OP_16 and OP_1NEGATE as numbers, other opcodes by name. A
 * truncated push ends the output with "[error]", as decodescript shows it.
 */
export function scriptToAsm(script: Uint8Array): string {
  const { tokens, error } = tokenize(script);
  const words = tokens.map((token) =>
    token.data !== null ? toHex(token.data) : (SMALL_INT_NAMES[token.opcode] ?? OPCODE_NAMES[token.opcode]!),
  );
  if (error !== null) words.push('[error]');
  return words.join(' ');
}

/**
 * Parses the one-line format back into a script. Numbers from -1 to 16
 * become their opcodes, OP_ names (and the aliases OP_TRUE, OP_FALSE,
 * OP_NOP2, OP_NOP3) their bytes, and hex is pushed with the shortest push
 * opcode for its length. The format cannot tell a one-byte push of 0x00 to
 * 0x10 from a number, so those always come back as OP_0 to OP_16.
 */
export function scriptFromAsm(asm: string): Uint8Array {
  const out: number[] = [];
  for (const word of asm.trim().split(/\s+/).filter((item) => item !== '')) {
    if (/^(-1|[0-9]|1[0-6])$/.test(word)) {
      const value = Number(word);
      out.push(value === -1 ? OP_CODES.OP_1NEGATE : value === 0 ? OP_CODES.OP_0 : OP_CODES.OP_1 + value - 1);
    } else if (word.startsWith('OP_')) {
      const opcode = (OP_CODES as Record<string, number>)[word];
      if (opcode === undefined || isPushOpcode(opcode)) throw new Error(`unknown or push opcode ${word}`);
      out.push(opcode);
    } else if (/^([0-9a-fA-F]{2})+$/.test(word)) {
      const data = Uint8Array.from(word.match(/../g)!, (byte) => parseInt(byte, 16));
      out.push(...pushWithLength(data));
    } else {
      throw new Error(`cannot parse script word "${word}"`);
    }
  }
  return Uint8Array.from(out);
}

function pushWithLength(data: Uint8Array): number[] {
  const n = data.length;
  if (n <= OP_DATA_75) return [n, ...data];
  if (n <= 0xff) return [OP_CODES.OP_PUSHDATA1, n, ...data];
  if (n <= 0xffff) return [OP_CODES.OP_PUSHDATA2, n & 0xff, n >> 8, ...data];
  return [OP_CODES.OP_PUSHDATA4, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24, ...data];
}

/** txscript.IsPushOnlyScript: every opcode is a push or OP_0 to OP_16, and the script parses. */
export function isPushOnlyScript(script: Uint8Array): boolean {
  const { tokens, error } = tokenize(script);
  return error === null && tokens.every((token) => token.opcode <= OP_CODES.OP_16);
}

/**
 * Decodes a script number like MakeScriptNum: little-endian sign-magnitude,
 * at most maxLength bytes (4, or 5 for lock times), minimally encoded unless
 * requireMinimal is false.
 */
export function decodeScriptNumber(
  data: Uint8Array,
  options: { requireMinimal?: boolean; maxLength?: number } = {},
): number {
  const maxLength = options.maxLength ?? 4;
  if (data.length > maxLength) {
    throw new Error(
      `numeric value encoded as ${toHex(data)} is ${data.length} bytes which exceeds the max allowed of ${maxLength}`,
    );
  }
  if (data.length === 0) return 0;
  const last = data[data.length - 1]!;
  if (
    (options.requireMinimal ?? true) &&
    (last & 0x7f) === 0 &&
    (data.length === 1 || (data[data.length - 2]! & 0x80) === 0)
  ) {
    throw new Error(`numeric value encoded as ${toHex(data)} is not minimally encoded`);
  }
  let value = 0;
  for (let i = data.length - 1; i >= 0; i -= 1) {
    value = value * 256 + (i === data.length - 1 ? last & 0x7f : data[i]!);
  }
  return last & 0x80 ? -value : value;
}

// The 14 opcodes txscript's isOpcodeDisabled lists, plus OP_CHECKMULTISIG and
// OP_CHECKMULTISIGVERIFY, which tapscript disables in favour of OP_CHECKSIGADD.
const DISABLED_IN_TAPSCRIPT = new Set<number>([
  OP_CODES.OP_SUBSTR,
  OP_CODES.OP_LEFT,
  OP_CODES.OP_RIGHT,
  OP_CODES.OP_INVERT,
  OP_CODES.OP_AND,
  OP_CODES.OP_OR,
  OP_CODES.OP_XOR,
  OP_CODES.OP_2MUL,
  OP_CODES.OP_2DIV,
  OP_CODES.OP_MUL,
  OP_CODES.OP_DIV,
  OP_CODES.OP_MOD,
  OP_CODES.OP_LSHIFT,
  OP_CODES.OP_RSHIFT,
  OP_CODES.OP_CHECKMULTISIG,
  OP_CODES.OP_CHECKMULTISIGVERIFY,
]);

/** Whether executing this opcode in a Pearl tapscript leaf fails as disabled. */
export function isDisabledOpcode(opcode: number): boolean {
  return DISABLED_IN_TAPSCRIPT.has(opcode);
}
