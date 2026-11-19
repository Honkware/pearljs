// The interpreter hashes the prevouts, amounts, scripts, sequences and
// outputs once per transaction, as pearld's TxSigHashes does, and reuses
// them for every input. The messages must be the ones keyPathSighash and
// tapscriptSighash compute from scratch, which the Go vectors pin.

import * as ecc from 'tiny-secp256k1';
import { describe, expect, it } from 'vitest';
import {
  createTransaction,
  keyPathSighash,
  p2mr,
  p2tr,
  taggedHash,
  tapscriptSighash,
  verifyTransaction,
} from '../src/index.js';
import type { TxOutput } from '../src/index.js';
import { pearlTaprootSighash, TaprootMidstate } from '../src/internal/sighash.js';

const SIGHASH_TYPES = [0x00, 0x01, 0x02, 0x03, 0x81, 0x82, 0x83];

function keyPathKey(): { tweaked: Uint8Array; script: Uint8Array } {
  let key: Uint8Array = new Uint8Array(32);
  key[31] = 7;
  if (ecc.pointFromScalar(key, true)![0] === 3) key = ecc.privateNegate(key);
  const internalPubkey = ecc.xOnlyPointFromScalar(key);
  return { tweaked: ecc.privateAdd(key, taggedHash('TapTweak', internalPubkey))!, script: p2tr({ internalPubkey }).output };
}

function spend(inputs: number, scriptOf: (index: number) => Uint8Array) {
  const tx = createTransaction(2);
  const prevouts: TxOutput[] = [];
  for (let index = 0; index < inputs; index += 1) {
    tx.addInput(Uint8Array.from({ length: 32 }, (_, at) => (index * 31 + at) & 0xff), index % 4, 0xfffffffd - index);
    prevouts.push({ script: scriptOf(index), value: 10_000n + BigInt(index) });
  }
  for (let index = 0; index < 3; index += 1) tx.addOutput(scriptOf(index), 5_000n + BigInt(index));
  return { tx, prevouts };
}

describe('the shared sighash midstate', () => {
  const leafHash = new Uint8Array(32).fill(0xab);
  const annex = Uint8Array.of(0x50, 0x01, 0x02);
  const p2trScript = keyPathKey().script;
  const p2mrScript = p2mr({ merkleRoot: new Uint8Array(32).fill(0x11) }).output;

  it.each([
    ['P2TR and P2MR inputs', (index: number) => (index % 2 === 0 ? p2trScript : p2mrScript), {}],
    ['P2MR inputs only', () => p2mrScript, {}],
  ] as const)('gives every input the message computed from scratch, for %s', (_name, scriptOf, rule) => {
    const { tx, prevouts } = spend(5, scriptOf);
    const midstate = new TaprootMidstate(tx, prevouts);
    for (const sighashType of SIGHASH_TYPES) {
      for (let index = 0; index < 3; index += 1) {
        for (const extra of [{}, { annex }]) {
          expect(pearlTaprootSighash(tx, index, prevouts, null, sighashType, { ...rule, ...extra }, midstate)).toEqual(
            keyPathSighash(tx, index, { ...rule, ...extra, prevouts, sighashType }),
          );
          const context = { ...rule, ...extra, codeSeparatorPosition: 4 };
          expect(pearlTaprootSighash(tx, index, prevouts, leafHash, sighashType, context, midstate)).toEqual(
            tapscriptSighash(tx, index, { ...context, prevouts, leafHash, sighashType }),
          );
        }
      }
    }
  });

  it('verifies a key-path consolidation of 1680 inputs in under 2 seconds', () => {
    // The size of the largest consolidation in mainnet block 78353, which took about 4.3 s when every input rehashed the midstate.
    const { tweaked, script } = keyPathKey();
    const { tx, prevouts } = spend(1680, () => script);
    const midstate = new TaprootMidstate(tx, prevouts);
    for (let index = 0; index < tx.ins.length; index += 1) {
      tx.setWitness(index, [ecc.signSchnorr(pearlTaprootSighash(tx, index, prevouts, null, 0, {}, midstate), tweaked)]);
    }
    const started = performance.now();
    expect(verifyTransaction(tx, prevouts)).toEqual({ ok: true });
    expect(performance.now() - started).toBeLessThan(2000);
  }, 30_000);
});
