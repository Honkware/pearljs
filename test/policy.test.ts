// Relay policy against mempool.CheckTransactionStandard, IsDust and
// GetDustThreshold run in Go, the mempool.go checks around them, and vsize
// estimates against every transaction Pearl signed for the vectors.

import { describe, expect, it } from 'vitest';
import {
  assembleScriptTree,
  checkStandard,
  checksigScript,
  deriveSigningAccountFromSeed,
  dustThreshold,
  estimateVsize,
  feeForVsize,
  isDust,
  minRelayFee,
  networks,
  parseTransaction,
} from '../src/index.js';
import type { SpendEstimate, Transaction } from '../src/index.js';
import vectors from '../vectors/pearl-go.json' with { type: 'json' };
import { bytesToHex, hexToBytes } from './vector-helpers.js';

const account = deriveSigningAccountFromSeed(hexToBytes(vectors.bip86.seed), networks.mainnet);
const standard = (name: string) => vectors.policy.standard.find((item) => item.name === name)!;
const p2tr = hexToBytes(`5120${'07'.repeat(32)}`);

/** The witness sizes of every input but one, taken from the signed transaction. */
function otherInputs(signed: Transaction, skip: number, spend: SpendEstimate): SpendEstimate[] {
  return signed.ins.map((input, i) =>
    i === skip ? spend : { type: 'witness', items: input.witness.map((item) => item.length) },
  );
}

describe('dust', () => {
  for (const expected of vectors.policy.dust) {
    it(`matches Pearl for ${expected.name}`, () => {
      const script = hexToBytes(expected.script);
      expect(dustThreshold(script)).toBe(BigInt(expected.threshold));
      expect(isDust({ script, value: BigInt(expected.value) })).toBe(expected.dust);
    });
  }
});

describe('checkStandard', () => {
  for (const expected of vectors.policy.standard) {
    it(`matches CheckTransactionStandard for ${expected.name}`, () => {
      const tx = parseTransaction(expected.txHex);
      expect(tx.virtualSize()).toBe(expected.vsize);
      const run = () =>
        checkStandard(tx, {
          height: expected.height,
          medianTimePast: expected.medianTimePast,
          minRelayFee: BigInt(expected.minRelayFee),
        });
      if (expected.error === '') expect(run).not.toThrow();
      else expect(run).toThrow(expected.error);
    });
  }

  it('skips the finality check without a height', () => {
    expect(() => checkStandard(parseTransaction(standard('lock-height-not-reached').txHex))).not.toThrow();
  });

  it('refuses a transaction without witness data, which pearld requires', () => {
    const tx = parseTransaction(standard('standard').txHex);
    tx.setWitness(0, []);
    expect(() => checkStandard(tx)).toThrow('transaction has no witness data');
  });

  it('refuses a transaction under 65 bytes without witnesses', () => {
    const tx = parseTransaction(standard('standard').txHex);
    tx.outs.splice(1);
    tx.outs[0]!.script = Uint8Array.of(0x6a);
    tx.outs[0]!.value = 0n;
    expect(tx.byteLength(false)).toBe(61);
    expect(() => checkStandard(tx)).toThrow(`tx ${tx.getId()} is too small`);
  });

  it('refuses an unsupported output before checking the version, as pearld does', () => {
    const tx = parseTransaction(standard('p2wpkh-output').txHex);
    tx.version = 3;
    expect(() => checkStandard(tx)).toThrow('transaction output 2 has unsupported script type nonstandard');
  });

  it('refuses a non-standard input and a fee under the relay fee', () => {
    const tx = parseTransaction(standard('standard').txHex);
    const outputs = 15000n;
    const required = minRelayFee(tx.virtualSize());
    expect(required).toBe(154n);
    const prevouts = (script: Uint8Array, value: bigint) => [{ script, value }];
    expect(() => checkStandard(tx, { prevouts: prevouts(Uint8Array.of(0x51), outputs + required) })).toThrow(
      'transaction input #0 has a non-standard script form',
    );
    expect(() => checkStandard(tx, { prevouts: prevouts(p2tr, outputs + required) })).not.toThrow();
    expect(() => checkStandard(tx, { prevouts: prevouts(p2tr, outputs + required - 1n) })).toThrow(
      `transaction ${tx.getId()} has 153 fees which is under the required amount of 154`,
    );
    expect(() => checkStandard(tx, { prevouts: prevouts(p2tr, outputs - 1n) })).toThrow(
      'less than the amount spent of 15000',
    );
  });
});

describe('fees', () => {
  it('computes the relay fee the way calcMinRequiredTxRelayFee does', () => {
    expect(minRelayFee(154)).toBe(154n);
    expect(minRelayFee(154, 1500n)).toBe(231n);
    expect(minRelayFee(0)).toBe(1000n);
    expect(minRelayFee(154, 0n)).toBe(0n);
  });

  it('rounds a fee up so it never falls under the rate', () => {
    expect(feeForVsize(154, 1500n)).toBe(231n);
    expect(feeForVsize(155, 1500n)).toBe(233n);
    expect(feeForVsize(1000, 2000n)).toBe(2000n);
  });
});

describe('estimateVsize', () => {
  for (const expected of vectors.signing) {
    it(`is exact for the ${expected.name} key-path spend`, () => {
      const unsigned = parseTransaction(expected.unsignedTxHex);
      const spend: SpendEstimate = { type: 'keyPath', sighashType: expected.hashType };
      expect(estimateVsize(unsigned, [spend])).toBe(parseTransaction(expected.finalTxHex).virtualSize());
    });
  }

  for (const expected of vectors.scriptPathSpends) {
    it(`is exact for ${expected.name}`, () => {
      const tree = assembleScriptTree(
        Array.from({ length: expected.leafCount }, (_, i) => checksigScript(account.derivePublicKey(i))),
      );
      expect(bytesToHex(tree.leaves[expected.leafIndex]!.script)).toBe(expected.leafScript);
      const signed = parseTransaction(expected.finalTxHex);
      const spend: SpendEstimate = {
        type: 'scriptPath',
        tree,
        leafIndex: expected.leafIndex,
        p2mr: expected.kind === 'p2mr',
        sighashType: expected.hashType,
      };
      const spends = otherInputs(signed, expected.inputIndex, spend);
      expect(estimateVsize(parseTransaction(expected.unsignedTxHex), spends)).toBe(signed.virtualSize());
    });
  }

  for (const expected of vectors.xmss.spends) {
    it(`is exact for ${expected.name}`, () => {
      const tree = assembleScriptTree(expected.leafScripts.map(hexToBytes));
      const signed = parseTransaction(expected.finalTxHex);
      const spend: SpendEstimate = { type: 'scriptPath', tree, leafIndex: expected.leafIndex, p2mr: true };
      const spends = otherInputs(signed, expected.inputIndex, spend);
      expect(estimateVsize(parseTransaction(expected.unsignedTxHex), spends)).toBe(signed.virtualSize());
    });
  }

  for (const expected of vectors.multiASpends) {
    it(`is exact for multi_a ${expected.name}`, () => {
      const tree = assembleScriptTree([hexToBytes(expected.leafScript)]);
      const spend: SpendEstimate = { type: 'scriptPath', tree, leafIndex: 0, p2mr: false };
      const signed = parseTransaction(expected.finalTxHex);
      expect(estimateVsize(parseTransaction(expected.unsignedTxHex), [spend])).toBe(signed.virtualSize());
    });
  }

  it('asks for stack sizes for a leaf it does not recognise', () => {
    const tree = assembleScriptTree([Uint8Array.of(0x51)]);
    const tx = parseTransaction(vectors.scriptPathSpends[0]!.unsignedTxHex);
    expect(() => estimateVsize(tx, [{ type: 'scriptPath', tree, leafIndex: 0, p2mr: true }])).toThrow(
      'pass stack sizes for this leaf',
    );
    expect(estimateVsize(tx, [{ type: 'scriptPath', tree, leafIndex: 0, p2mr: true, stack: [] }])).toBeGreaterThan(0);
  });
});
