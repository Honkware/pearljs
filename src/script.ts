// Focused script primitives for Pearl: opcode constants, output script
// classification, generic witness program extraction, script number
// encoding, canonical data pushes and Taproot leaf/branch tagged hashes.
// These mirror the Pearl Go txscript behavior; this module is not a
// script execution engine.

import { sha256 } from '@noble/hashes/sha2';

// Opcodes used by Pearl script classification and push construction.
export const OP_CODES = {
  OP_0: 0x00,
  OP_PUSHDATA1: 0x4c,
  OP_PUSHDATA2: 0x4d,
  OP_PUSHDATA4: 0x4e,
  OP_1NEGATE: 0x4f,
  OP_1: 0x51,
  OP_2: 0x52,
  OP_16: 0x60,
  OP_RETURN: 0x6a,
  OP_CAT: 0x7e,
  OP_CHECKSIG: 0xac,
  OP_CHECKLOCKTIMEVERIFY: 0xb1,
  OP_CHECKSEQUENCEVERIFY: 0xb2,
  OP_CHECKMULTISIG: 0xae,
  OP_CHECKMULTISIGVERIFY: 0xaf,
  OP_CHECKSIGADD: 0xba,
  OP_CHECKXMSSSIG: 0xde,
} as const;

// Locktime and sequence constants from the Pearl wire format.
export const LOCKTIME_THRESHOLD = 500000000;
export const SEQUENCE_LOCKTIME_DISABLED = 0x80000000;
export const SEQUENCE_LOCKTIME_IS_SECONDS = 0x00400000;
export const SEQUENCE_LOCKTIME_MASK = 0x0000ffff;
export const SEQUENCE_LOCKTIME_GRANULARITY = 9;

// txscript.MaxScriptElementSize.
export const MAX_SCRIPT_ELEMENT_SIZE = 520;

// txscript.BaseLeafVersion.
export const BASE_LEAF_VERSION = 0xc0;

const MAX_DIRECT_PUSH = 75;
const WITNESS_PROGRAM_MIN_LENGTH = 2;
const WITNESS_PROGRAM_MAX_LENGTH = 40;
const TAPROOT_HASH_LENGTH = 32;

export type ScriptClass = 'p2tr' | 'p2mr' | 'nulldata' | 'nonstandard';

/**
 * Classifies an output script the way Pearl GetScriptClass does. Any script
 * beginning with OP_RETURN is nulldata regardless of what follows it. P2TR
 * is exactly OP_1 <32 bytes> and P2MR is exactly OP_2 <32 bytes>; every
 * other script, including legacy Bitcoin templates, is nonstandard.
 */
export function classifyOutputScript(script: Uint8Array): ScriptClass {
  if (script.length > 0 && script[0] === OP_CODES.OP_RETURN) {
    return 'nulldata';
  }
  if (script.length === 2 + TAPROOT_HASH_LENGTH && script[1] === TAPROOT_HASH_LENGTH) {
    if (script[0] === OP_CODES.OP_1) {
      return 'p2tr';
    }
    if (script[0] === OP_CODES.OP_2) {
      return 'p2mr';
    }
  }
  return 'nonstandard';
}

export interface WitnessProgram {
  version: number;
  program: Uint8Array;
}

/**
 * Extracts a generic witness program (versions 0 through 16) from a script,
 * following the Pearl witness program rules: the version must be a single
 * small-integer opcode and the program must be one canonical direct push of
 * 2 to 40 bytes that consumes the rest of the script exactly. Anything
 * else, including PUSHDATA opcodes or trailing bytes, returns null.
 */
export function extractWitnessProgram(script: Uint8Array): WitnessProgram | null {
  const first = script[0];
  const second = script[1];
  if (first === undefined || second === undefined) {
    return null;
  }
  let version: number;
  if (first === OP_CODES.OP_0) {
    version = 0;
  } else if (first >= OP_CODES.OP_1 && first <= OP_CODES.OP_16) {
    version = first - OP_CODES.OP_1 + 1;
  } else {
    return null;
  }
  if (second < WITNESS_PROGRAM_MIN_LENGTH || second > WITNESS_PROGRAM_MAX_LENGTH) {
    return null;
  }
  if (script.length !== 2 + second) {
    return null;
  }
  return { version, program: script.slice(2) };
}

/**
 * Encodes an integer as a Bitcoin script number: little-endian signed
 * magnitude with minimal length. Zero encodes to the empty array and the
 * sign bit lives in the most significant bit of the final byte, with a
 * padding byte appended when the value would otherwise set it.
 */
export function encodeScriptNumber(value: bigint): Uint8Array {
  if (value === 0n) {
    return new Uint8Array(0);
  }
  const negative = value < 0n;
  let magnitude = negative ? -value : value;
  const bytes: number[] = [];
  while (magnitude > 0n) {
    bytes.push(Number(magnitude & 0xffn));
    magnitude >>= 8n;
  }
  const lastIndex = bytes.length - 1;
  if ((bytes[lastIndex]! & 0x80) !== 0) {
    bytes.push(negative ? 0x80 : 0x00);
  } else if (negative) {
    bytes[lastIndex] = bytes[lastIndex]! | 0x80;
  }
  return Uint8Array.from(bytes);
}

/**
 * Pushes data onto a script with the canonical encoding of the Pearl Go
 * ScriptBuilder.AddData: empty data and [0x00] become OP_0, the values 1
 * through 16 become OP_1 through OP_16, [0x81] becomes OP_1NEGATE, up to 75
 * bytes are pushed directly, and larger data uses PUSHDATA1 or PUSHDATA2.
 * Data larger than MAX_SCRIPT_ELEMENT_SIZE is rejected, so PUSHDATA4 is
 * never needed here.
 */
export function scriptPush(data: Uint8Array): Uint8Array {
  if (data.length > MAX_SCRIPT_ELEMENT_SIZE) {
    throw new Error(
      `push of ${data.length} bytes exceeds MAX_SCRIPT_ELEMENT_SIZE ${MAX_SCRIPT_ELEMENT_SIZE}`,
    );
  }
  if (data.length === 0) {
    return Uint8Array.from([OP_CODES.OP_0]);
  }
  if (data.length === 1) {
    const byte = data[0]!;
    if (byte === 0) {
      return Uint8Array.from([OP_CODES.OP_0]);
    }
    if (byte >= 1 && byte <= 16) {
      return Uint8Array.from([OP_CODES.OP_1 + byte - 1]);
    }
    if (byte === 0x81) {
      return Uint8Array.from([OP_CODES.OP_1NEGATE]);
    }
  }
  if (data.length <= MAX_DIRECT_PUSH) {
    return Uint8Array.from([data.length, ...data]);
  }
  if (data.length <= 0xff) {
    return Uint8Array.from([OP_CODES.OP_PUSHDATA1, data.length, ...data]);
  }
  return Uint8Array.from([
    OP_CODES.OP_PUSHDATA2,
    data.length & 0xff,
    (data.length >> 8) & 0xff,
    ...data,
  ]);
}

function compactSize(value: number): Uint8Array {
  if (value < 0xfd) {
    return Uint8Array.from([value]);
  }
  if (value <= 0xffff) {
    return Uint8Array.from([0xfd, value & 0xff, (value >> 8) & 0xff]);
  }
  if (value <= 0xffffffff) {
    return Uint8Array.from([
      0xfe,
      value & 0xff,
      (value >> 8) & 0xff,
      (value >> 16) & 0xff,
      (value >> 24) & 0xff,
    ]);
  }
  const wide = BigInt(value);
  const out = new Uint8Array(9);
  out[0] = 0xff;
  for (let i = 0; i < 8; i += 1) {
    out[1 + i] = Number((wide >> BigInt(8 * i)) & 0xffn);
  }
  return out;
}

/** BIP340 tagged hash: SHA256(SHA256(tag) || SHA256(tag) || message). */
export function taggedHash(tag: string, message: Uint8Array): Uint8Array {
  const tagHash = sha256(new TextEncoder().encode(tag));
  const data = new Uint8Array(2 * tagHash.length + message.length);
  data.set(tagHash, 0);
  data.set(tagHash, tagHash.length);
  data.set(message, 2 * tagHash.length);
  return sha256(data);
}

/**
 * BIP341 TapLeaf tagged hash of a script at the given leaf version,
 * committing to leafVersion, the compactSize script length and the script.
 */
export function tapLeafHash(
  script: Uint8Array,
  leafVersion: number = BASE_LEAF_VERSION,
): Uint8Array {
  if (!Number.isInteger(leafVersion) || leafVersion < 0 || leafVersion > 0xff) {
    throw new Error(`leaf version must be a single byte, got ${leafVersion}`);
  }
  const size = compactSize(script.length);
  const message = new Uint8Array(1 + size.length + script.length);
  message[0] = leafVersion;
  message.set(size, 1);
  message.set(script, 1 + size.length);
  return taggedHash('TapLeaf', message);
}

/**
 * Single-key tapscript leaf: <x-only pubkey> OP_CHECKSIG. This is the leaf
 * shape Pearl's wallet stores for P2MR addresses.
 */
export function checksigScript(xOnlyPubkey: Uint8Array): Uint8Array {
  if (xOnlyPubkey.length !== TAPROOT_HASH_LENGTH) {
    throw new Error(
      `x-only pubkey must be ${TAPROOT_HASH_LENGTH} bytes, got ${xOnlyPubkey.length}`,
    );
  }
  return Uint8Array.from([...scriptPush(xOnlyPubkey), OP_CODES.OP_CHECKSIG]);
}

/** XMSS tapscript leaf: <64-byte XMSS public key> OP_CHECKXMSSSIG (txscript.XMSSLeafScript). */
export function xmssLeafScript(xmssPublicKey: Uint8Array): Uint8Array {
  if (xmssPublicKey.length !== 64) {
    throw new Error(`XMSS public key must be 64 bytes, got ${xmssPublicKey.length}`);
  }
  return Uint8Array.from([...scriptPush(xmssPublicKey), OP_CODES.OP_CHECKXMSSSIG]);
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const diff = a[i]! - b[i]!;
    if (diff !== 0) {
      return diff;
    }
  }
  return a.length - b.length;
}

/**
 * BIP341 TapBranch tagged hash of two child hashes. The children are sorted
 * lexicographically before hashing so the branch hash is order independent.
 */
export function tapBranchHash(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length !== TAPROOT_HASH_LENGTH || b.length !== TAPROOT_HASH_LENGTH) {
    throw new Error(
      `tap branch hashes must be ${TAPROOT_HASH_LENGTH} bytes, ` +
        `got ${a.length} and ${b.length}`,
    );
  }
  const [first, second] = compareBytes(a, b) <= 0 ? [a, b] : [b, a];
  const message = new Uint8Array(2 * TAPROOT_HASH_LENGTH);
  message.set(first, 0);
  message.set(second, TAPROOT_HASH_LENGTH);
  return taggedHash('TapBranch', message);
}
