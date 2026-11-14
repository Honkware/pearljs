import {
  assembleScriptTree,
  checksigScript,
  p2mr,
  xmssLeafScript,
} from '../src/index.js';
import type { SpendEstimate, Utxo } from '../src/index.js';
import vectors from '../vectors/pearl-go.json' with { type: 'json' };
import { hexToBytes } from './vector-helpers.js';

export type SelectionVector = (typeof vectors.coinSelection.cases)[number];

export function selectionCase(name: string): SelectionVector {
  const vector = vectors.coinSelection.cases.find((item) => item.name === name);
  if (vector === undefined) throw new Error(`missing coin selection vector ${name}`);
  return vector;
}

export function coinsOf(vector: SelectionVector): Utxo[] {
  return vector.coins.map((coin) => ({
    txid: coin.txid,
    vout: coin.vout,
    value: BigInt(coin.value),
    script: hexToBytes(coin.script),
    confirmations: 6,
  }));
}

export const outpoint = (utxo: { txid: string; vout: number }): string => `${utxo.txid}:${utxo.vout}`;

/** A deterministic generator (mulberry32) so a failing property can be replayed. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const checksigTree = assembleScriptTree([1, 2, 3].map((byte) => checksigScript(new Uint8Array(32).fill(byte))));
const xmssTree = assembleScriptTree([xmssLeafScript(new Uint8Array(64).fill(7))]);

/**
 * The three kinds of input a Pearl wallet spends, each with the spend shape
 * it is priced by and, worked out by hand, the witness it ends up with.
 */
export const INPUT_KINDS = [
  { name: 'key path', script: hexToBytes(`5120${'07'.repeat(32)}`), spend: undefined, witness: [64] },
  {
    name: 'P2MR checksig leaf',
    script: p2mr({ merkleRoot: checksigTree.root }).output,
    spend: { type: 'scriptPath', tree: checksigTree, leafIndex: 2, p2mr: true },
    // Signature, the 34-byte leaf, and a control block of one byte plus a 32-byte proof.
    witness: [64, 34, 1 + checksigTree.leaves[2]!.proof.length],
  },
  {
    name: 'XMSS leaf',
    script: p2mr({ merkleRoot: xmssTree.root }).output,
    spend: { type: 'scriptPath', tree: xmssTree, leafIndex: 0, p2mr: true },
    witness: [468, 468, 468, 468, 468, 66, 1],
  },
] as const satisfies readonly { name: string; script: Uint8Array; spend: SpendEstimate | undefined; witness: readonly number[] }[];
