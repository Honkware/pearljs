// Recognises k-of-n OP_CHECKSIGADD leaves (BIP 342 multi_a) the way Pearl's
// psbt package does (parseTaprootMultiA in btcutil/psbt/taproot_multi_a.go):
//
//   <key 1> OP_CHECKSIG <key 2> OP_CHECKSIGADD ... <key n> OP_CHECKSIGADD <k> OP_NUMEQUAL
//
// Keys are any 32-byte push and k is a small-int opcode or a minimally
// encoded number of up to 4 bytes with 1 <= k <= n. A script that uses
// OP_CHECKSIGADD in any other shape is refused rather than guessed at.

import { OP_CODES } from './script.js';

const OP_NUMEQUAL = 0x9c;

interface Token {
  opcode: number;
  data: Uint8Array | null;
}

/** Splits a script into opcodes and pushed data, like txscript.ScriptTokenizer. */
function tokenize(script: Uint8Array): Token[] {
  const tokens: Token[] = [];
  let offset = 0;
  const take = (length: number): Uint8Array => {
    if (offset + length > script.length) throw new Error('script push runs past the end of the script');
    const out = script.slice(offset, offset + length);
    offset += length;
    return out;
  };
  const littleEndian = (bytes: Uint8Array): number => bytes.reduceRight((value, byte) => value * 256 + byte, 0);
  while (offset < script.length) {
    const opcode = script[offset]!;
    offset += 1;
    if (opcode >= 0x01 && opcode <= 0x4b) {
      tokens.push({ opcode, data: take(opcode) });
    } else if (opcode === OP_CODES.OP_PUSHDATA1) {
      tokens.push({ opcode, data: take(littleEndian(take(1))) });
    } else if (opcode === OP_CODES.OP_PUSHDATA2) {
      tokens.push({ opcode, data: take(littleEndian(take(2))) });
    } else if (opcode === OP_CODES.OP_PUSHDATA4) {
      tokens.push({ opcode, data: take(littleEndian(take(4))) });
    } else {
      tokens.push({ opcode, data: null });
    }
  }
  return tokens;
}

function isSmallInt(opcode: number): boolean {
  return opcode === OP_CODES.OP_0 || (opcode >= OP_CODES.OP_1 && opcode <= OP_CODES.OP_16);
}

/** MakeScriptNum(data, requireMinimal = true, 4), or null when it would fail. */
function scriptNumber(data: Uint8Array): number | null {
  if (data.length > 4) return null;
  if (data.length === 0) return 0;
  const last = data[data.length - 1]!;
  if ((last & 0x7f) === 0 && (data.length === 1 || (data[data.length - 2]! & 0x80) === 0)) return null;
  let value = 0;
  for (let i = data.length - 1; i >= 0; i -= 1) value = value * 256 + (i === data.length - 1 ? last & 0x7f : data[i]!);
  return last & 0x80 ? -value : value;
}

export interface MultiALeaf {
  keys: Uint8Array[];
  threshold: number;
}

/** The keys and threshold of a multi_a leaf, or null for any other leaf. */
export function parseMultiA(script: Uint8Array): MultiALeaf | null {
  // Pearl refuses any leaf its tokenizer cannot parse, multi_a or not.
  const tokens = tokenize(script);
  const hasCheckSigAdd = tokens.some((token) => token.opcode === OP_CODES.OP_CHECKSIGADD);
  const unsupported = (): null => {
    if (hasCheckSigAdd) throw new Error('unsupported OP_CHECKSIGADD script');
    return null;
  };
  if (tokens.length < 4 || tokens[0]!.data?.length !== 32 || tokens[1]!.opcode !== OP_CODES.OP_CHECKSIG) {
    return unsupported();
  }
  const keys = [tokens[0]!.data!];
  let idx = 2;
  while (idx + 1 < tokens.length && tokens[idx]!.data?.length === 32 && tokens[idx + 1]!.opcode === OP_CODES.OP_CHECKSIGADD) {
    keys.push(tokens[idx]!.data!);
    idx += 2;
  }
  if (idx + 2 !== tokens.length || tokens[idx + 1]!.opcode !== OP_NUMEQUAL) {
    return unsupported();
  }
  const thresholdToken = tokens[idx]!;
  const threshold = isSmallInt(thresholdToken.opcode)
    ? thresholdToken.opcode === OP_CODES.OP_0
      ? 0
      : thresholdToken.opcode - OP_CODES.OP_1 + 1
    : thresholdToken.data === null
      ? null
      : scriptNumber(thresholdToken.data);
  if (threshold === null || threshold < 1 || threshold > keys.length) {
    throw new Error('unsupported OP_CHECKSIGADD script');
  }
  return { keys, threshold };
}

/**
 * Witness items for a multi_a leaf, like taprootScriptSpendWitnessStack: one
 * item per key in reverse script order, empty for keys without a signature.
 * NUMEQUAL needs exactly k successful checks, so signatures beyond k are
 * dropped in script order.
 */
export function multiAStack(leaf: MultiALeaf, signatures: ReadonlyMap<string, Uint8Array>): Uint8Array[] {
  const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const keyHexes = leaf.keys.map(hex);
  for (const key of signatures.keys()) {
    if (!keyHexes.includes(key)) throw new Error('a script-path signature does not match a multi_a key');
  }
  const available = keyHexes.filter((key) => signatures.has(key)).length;
  if (available < leaf.threshold) {
    throw new Error(`multi_a leaf has ${available} of the ${leaf.threshold} signatures it needs`);
  }
  let remaining = leaf.threshold;
  const selected = keyHexes.map((key) => {
    const signature = signatures.get(key);
    if (remaining === 0 || signature === undefined) return new Uint8Array(0);
    remaining -= 1;
    return signature;
  });
  return selected.reverse();
}
