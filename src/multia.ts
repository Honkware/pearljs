// Recognises k-of-n OP_CHECKSIGADD leaves (BIP 342 multi_a) the way Pearl's
// psbt package does (parseTaprootMultiA in btcutil/psbt/taproot_multi_a.go):
//
//   <key 1> OP_CHECKSIG <key 2> OP_CHECKSIGADD ... <key n> OP_CHECKSIGADD <k> OP_NUMEQUAL
//
// Keys are any 32-byte push and k is a small-int opcode or a minimally
// encoded number of up to 4 bytes with 1 <= k <= n. A script that uses
// OP_CHECKSIGADD in any other shape is refused rather than guessed at.

/**
 * multi_a leaves, Pearl's only multisig: build, parse, and order the witness.
 *
 * @module
 */

import { OP_CODES } from './opcodes.js';
import { encodeScriptNumber, scriptPush } from './script.js';
import { decodeScriptNumber, decompileScript } from './scripttools.js';
import type { ScriptChunk } from './scripttools.js';
import { toHex } from './internal/bytes.js';
import { PearlError, SigningError } from './errors.js';

const isData = (chunk: ScriptChunk | undefined): chunk is Uint8Array => chunk instanceof Uint8Array;

/** A parsed multi_a leaf: its x-only keys in script order and how many must sign. */
export interface MultiALeaf {
  keys: Uint8Array[];
  threshold: number;
}

// Bitcoin Core's MAX_PUBKEYS_PER_MULTI_A, which keeps a full spend under
// tapscript's stack limit of 1000 items.
const MAX_MULTI_A_KEYS = 999;

/**
 * A k-of-n multi_a leaf over 32-byte x-only keys, in the order given. The
 * threshold is a small-int opcode up to 16 and a minimal push above, the
 * forms Pearl's psbt package recognises. Duplicate keys are refused.
 *
 * Throws for no keys or more than 999, a key that is not 32 bytes, and a
 * threshold outside 1 to the number of keys.
 */
export function multiAScript(keys: readonly Uint8Array[], threshold: number): Uint8Array {
  if (keys.length === 0 || keys.length > MAX_MULTI_A_KEYS) {
    throw new RangeError(`multi_a takes 1 to ${MAX_MULTI_A_KEYS} keys, got ${keys.length}`);
  }
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > keys.length) {
    throw new RangeError(`multi_a threshold must be 1 to ${keys.length}, got ${threshold}`);
  }
  const seen = new Set<string>();
  const parts: number[] = [];
  keys.forEach((key, i) => {
    if (key.length !== 32) throw new PearlError('SCRIPT_INVALID', `multi_a key ${i} must be 32 bytes, got ${key.length}`);
    const id = key.join(',');
    if (seen.has(id)) throw new PearlError('SCRIPT_INVALID', `multi_a key ${i} is a duplicate`);
    seen.add(id);
    parts.push(...scriptPush(key), i === 0 ? OP_CODES.OP_CHECKSIG : OP_CODES.OP_CHECKSIGADD);
  });
  parts.push(...scriptPush(encodeScriptNumber(BigInt(threshold))), OP_CODES.OP_NUMEQUAL);
  return Uint8Array.from(parts);
}

/** The keys and threshold of a multi_a leaf, or null for any other leaf. */
export function parseMultiA(script: Uint8Array): MultiALeaf | null {
  // Pearl refuses any leaf its tokenizer cannot parse, multi_a or not.
  const chunks = decompileScript(script);
  const unsupported = (): null => {
    if (chunks.includes(OP_CODES.OP_CHECKSIGADD)) throw new PearlError('SCRIPT_INVALID', 'unsupported OP_CHECKSIGADD script');
    return null;
  };
  const first = chunks[0];
  if (chunks.length < 4 || !isData(first) || first.length !== 32 || chunks[1] !== OP_CODES.OP_CHECKSIG) {
    return unsupported();
  }
  const keys = [first];
  let idx = 2;
  for (let key = chunks[idx]; isData(key) && key.length === 32 && chunks[idx + 1] === OP_CODES.OP_CHECKSIGADD; key = chunks[idx]) {
    keys.push(key);
    idx += 2;
  }
  if (idx + 2 !== chunks.length || chunks[idx + 1] !== OP_CODES.OP_NUMEQUAL) {
    return unsupported();
  }
  const thresholdChunk = chunks[idx]!;
  let threshold: number | null;
  if (isData(thresholdChunk)) {
    try {
      threshold = decodeScriptNumber(thresholdChunk);
    } catch {
      threshold = null;
    }
  } else if (thresholdChunk === OP_CODES.OP_0) {
    threshold = 0;
  } else if (thresholdChunk >= OP_CODES.OP_1 && thresholdChunk <= OP_CODES.OP_16) {
    threshold = thresholdChunk - OP_CODES.OP_1 + 1;
  } else {
    threshold = null;
  }
  if (threshold === null || threshold < 1 || threshold > keys.length) {
    throw new PearlError('SCRIPT_INVALID', 'unsupported OP_CHECKSIGADD script');
  }
  return { keys, threshold };
}

/**
 * Witness items for a multi_a leaf, like taprootScriptSpendWitnessStack: one
 * item per key in reverse script order, empty for keys without a signature.
 * NUMEQUAL needs exactly k successful checks, so signatures beyond k are
 * dropped in script order.
 *
 * signatures maps each key, as lowercase hex, to its signature. Throws when
 * fewer than the threshold are present or one is for a key the leaf does not
 * have.
 */
export function multiAStack(leaf: MultiALeaf, signatures: ReadonlyMap<string, Uint8Array>): Uint8Array[] {
  const keyHexes = leaf.keys.map(toHex);
  for (const key of signatures.keys()) {
    if (!keyHexes.includes(key)) throw new SigningError('INPUT_MISMATCH', 'a script-path signature does not match a multi_a key');
  }
  const available = keyHexes.filter((key) => signatures.has(key)).length;
  if (available < leaf.threshold) {
    throw new SigningError('SIGNATURES_MISSING', `multi_a leaf has ${available} of the ${leaf.threshold} signatures it needs`);
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
