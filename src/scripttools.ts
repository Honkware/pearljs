// Building and reading scripts the way Pearl's txscript does: compile and
// decompile, the one-line disassembly of DisasmString (what decodescript
// shows), script numbers, and opcode properties.
//
// Pearl differs from Bitcoin's tapscript in two ways that matter when
// writing leaves: OP_CAT is enabled, and the BIP 342 OP_SUCCESS rule is gone,
// so a reserved or unknown opcode makes a leaf fail instead of succeed.

/**
 * Compile and decompile scripts, Pearl's one-line disassembly, and script
 * number decoding.
 *
 * @module
 */

import { OP_CODES, OPCODE_NAMES } from './opcodes.js';
import { scriptPush } from './script.js';
import { toHex } from './internal/bytes.js';

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
    // Copied: slice on a Node Buffer returns a view of the caller's memory.
    tokens.push({
      opcode,
      data: isPushOpcode(opcode) ? Uint8Array.from(script.subarray(start, start + dataLength)) : null,
    });
    offset = start + dataLength;
  }
  return { tokens, error: null };
}

/**
 * Splits a script into opcodes and pushed data; throws on a truncated push.
 * The data chunks are copies.
 */
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


// "10" to "16" are both OP_10 to OP_16 and a one-byte push of 0x10 to 0x16.
const AMBIGUOUS_WORD = /^1[0-6]$/;

/** Options for scriptToAsm. */
export interface ScriptToAsmOptions {
  /**
   * Print the words DisasmString leaves ambiguous in a form scriptFromAsm
   * reads back to the same values: OP_10 to OP_16 by name, a one-byte push
   * of 0x10 to 0x16 as 0x10 to 0x16, and a zero-length PUSHDATA as 0x. The
   * output then differs from DisasmString in exactly those words.
   */
  unambiguous?: boolean;
}

/**
 * One-line disassembly, identical to DisasmString: pushed data as hex,
 * OP_0 to OP_16 and OP_1NEGATE as numbers, other opcodes by name. A
 * truncated push ends the output with "[error]", as decodescript shows it.
 *
 * The format is lossy. "10" to "16" stand for both a number opcode and a
 * one-byte push, and a zero-length PUSHDATA prints as an empty word. Pass
 * unambiguous to get text that scriptFromAsm can read back.
 */
export function scriptToAsm(script: Uint8Array, options: ScriptToAsmOptions = {}): string {
  const { tokens, error } = tokenize(script);
  const words = tokens.map((token) => {
    if (token.data !== null) {
      const hex = toHex(token.data);
      return options.unambiguous === true && (hex === '' || AMBIGUOUS_WORD.test(hex)) ? `0x${hex}` : hex;
    }
    const number = SMALL_INT_NAMES[token.opcode];
    if (number === undefined || (options.unambiguous === true && AMBIGUOUS_WORD.test(number))) {
      return OPCODE_NAMES[token.opcode]!;
    }
    return number;
  });
  if (error !== null) words.push('[error]');
  return words.join(' ');
}

/**
 * Parses the one-line format back into a script: words separated by single
 * spaces. Numbers from -1 to 9 become their opcodes, OP_ names (and the
 * aliases OP_TRUE, OP_FALSE, OP_NOP2, OP_NOP3) their bytes, and hex is pushed
 * with the shortest push opcode for its length; a 0x prefix marks a word as
 * data whatever it looks like, and 0x alone is an empty push.
 *
 * Text that could mean two scripts is refused instead of guessed at: the
 * words 10 to 16 (write OP_10 or 0x10), and an empty word, which is how
 * DisasmString prints a zero-length PUSHDATA. scriptToAsm with unambiguous
 * never produces either. The one exception is the empty string, read as the
 * empty script although a script that is only a zero-length PUSHDATA prints
 * that way too. The result pushes the same values as the script
 * that was printed, though not always with the same push opcodes: data comes
 * back with the shortest push for its length.
 */
export function scriptFromAsm(asm: string): Uint8Array {
  if (typeof asm !== 'string') {
    throw new TypeError('script asm must be a string');
  }
  const parts: number[][] = [];
  for (const word of asm === '' ? [] : asm.split(' ')) {
    if (word === '') {
      throw new Error(
        'script asm has an empty word, which may be a zero-length push or stray whitespace; write 0x for an empty push',
      );
    }
    if (AMBIGUOUS_WORD.test(word)) {
      throw new Error(
        `script word "${word}" is ambiguous: write OP_${word} for the number or 0x${word} for a one-byte push`,
      );
    }
    if (/^(-1|[0-9])$/.test(word)) {
      const value = Number(word);
      parts.push([value === -1 ? OP_CODES.OP_1NEGATE : value === 0 ? OP_CODES.OP_0 : OP_CODES.OP_1 + value - 1]);
    } else if (word.startsWith('OP_')) {
      const opcode = (OP_CODES as Record<string, number>)[word];
      if (opcode === undefined || isPushOpcode(opcode)) throw new Error(`unknown or push opcode ${word}`);
      parts.push([opcode]);
    } else if (/^(0x([0-9a-fA-F]{2})*|([0-9a-fA-F]{2})+)$/.test(word)) {
      const hex = word.startsWith('0x') ? word.slice(2) : word;
      const data = new Uint8Array(hex.length / 2);
      for (let i = 0; i < data.length; i += 1) data[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
      parts.push(pushWithLength(data));
    } else {
      throw new Error(`cannot parse script word "${word.length > 80 ? `${word.slice(0, 80)}...` : word}"`);
    }
  }
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
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

/** Options for decodeScriptNumber and decodeScriptNumberBigInt. */
export interface DecodeScriptNumberOptions {
  /** Refuse an encoding longer than the number needs. True unless given. */
  requireMinimal?: boolean;
  /** Most bytes the encoding may have. 4 unless given; lock times use 5. */
  maxLength?: number;
}

/**
 * Decodes a script number like MakeScriptNum: little-endian sign-magnitude,
 * at most maxLength bytes (4, or 5 for lock times), minimally encoded unless
 * requireMinimal is false. Returns a bigint, the type encodeScriptNumber
 * takes, so every length decodes exactly.
 */
export function decodeScriptNumberBigInt(data: Uint8Array, options: DecodeScriptNumberOptions = {}): bigint {
  if (!(data instanceof Uint8Array)) {
    throw new TypeError('script number must be a Uint8Array');
  }
  const maxLength = options.maxLength ?? 4;
  if (data.length > maxLength) {
    throw new Error(
      `numeric value encoded as ${toHex(data)} is ${data.length} bytes which exceeds the max allowed of ${maxLength}`,
    );
  }
  if (data.length === 0) return 0n;
  const last = data[data.length - 1]!;
  if (
    (options.requireMinimal ?? true) &&
    (last & 0x7f) === 0 &&
    (data.length === 1 || (data[data.length - 2]! & 0x80) === 0)
  ) {
    throw new Error(`numeric value encoded as ${toHex(data)} is not minimally encoded`);
  }
  let value = 0n;
  for (let i = data.length - 1; i >= 0; i -= 1) {
    value = value * 256n + BigInt(i === data.length - 1 ? last & 0x7f : data[i]!);
  }
  return last & 0x80 ? -value : value;
}

/**
 * decodeScriptNumberBigInt as a JS number, for the 4- and 5-byte numbers
 * scripts use. A value a number cannot hold exactly, which takes a maxLength
 * of 7 or more, throws instead of being rounded.
 */
export function decodeScriptNumber(data: Uint8Array, options: DecodeScriptNumberOptions = {}): number {
  const value = decodeScriptNumberBigInt(data, options);
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(
      `script number ${value} does not fit a JS number exactly; use decodeScriptNumberBigInt`,
    );
  }
  return Number(value);
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
