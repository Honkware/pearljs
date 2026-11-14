import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { sha256 } from '@noble/hashes/sha2';
import { debugInput, parseTransaction } from '../src/index.js';
import type { ScriptResult, Transaction, TxOutput } from '../src/index.js';
import { bytesToHex, hexToBytes } from './vector-helpers.js';

/** One case of vectors/interpreter/vectors.json.gz: a spend and the verdict of Pearl's engine on it. */
export interface EngineCase {
  name: string;
  tx: string;
  index?: number;
  prevouts: string[];
  code?: string;
  message?: string;
  trace: string;
}

export interface EngineVectors {
  seed: number;
  randomScripts: number;
  errorCodes: string[];
  cases: EngineCase[];
}

export function loadEngineVectors(path: string | URL): EngineVectors {
  const bytes = readFileSync(path);
  const text = String(path).endsWith('.gz') ? gunzipSync(bytes).toString('utf8') : bytes.toString('utf8');
  return JSON.parse(text) as EngineVectors;
}

export function caseInputs(item: EngineCase): { tx: Transaction; index: number; prevouts: TxOutput[] } {
  const prevouts = item.prevouts.map((text) => {
    const colon = text.indexOf(':');
    return { value: BigInt(text.slice(0, colon)), script: hexToBytes(text.slice(colon + 1)) };
  });
  return { tx: parseTransaction(item.tx), index: item.index ?? 0, prevouts };
}

function uint32le(value: number): Uint8Array {
  return Uint8Array.of(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, value >>> 24);
}

/**
 * Runs the stepping interpreter and digests the stack and alt stack after
 * every step the way generate.go digests the debug engine's callbacks.
 */
export function runWithTrace(
  tx: Transaction,
  index: number,
  prevouts: TxOutput[],
): { result: ScriptResult; trace: string; steps: number } {
  const hasher = sha256.create();
  const steps = debugInput(tx, index, prevouts);
  let count = 0;
  let next = steps.next();
  while (next.done !== true) {
    count += 1;
    for (const stack of [next.value.stack, next.value.altStack]) {
      hasher.update(uint32le(stack.length));
      for (const item of stack) hasher.update(uint32le(item.length)).update(item);
    }
    next = steps.next();
  }
  return { result: next.value, trace: bytesToHex(hasher.digest().subarray(0, 8)), steps: count };
}
