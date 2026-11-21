// Relay policy against mempool.CheckTransactionStandard, IsDust and
// GetDustThreshold run in Go, the mempool.go checks around them, and vsize
// estimates against every transaction Pearl signed for the vectors.

import { describe, expect, it } from 'vitest';
import {
  PolicyError,
  assembleScriptTree,
  checkSanity,
  checkStandard,
  checksigScript,
  createTransaction,
  deriveSigningAccountFromSeed,
  dustThreshold,
  estimateVsize,
  feeForVsize,
  isDust,
  MAX_GRAIN,
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
          relayFeeRate: BigInt(expected.minRelayFee),
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

  it('refuses a fee rate above maxFeeRate when one is given, truncating the rate as testmempoolaccept does', () => {
    const tx = parseTransaction(standard('standard').txHex);
    expect(tx.virtualSize()).toBe(154);
    const spending = (fee: bigint) => ({ prevouts: [{ script: p2tr, value: 15000n + fee }] });
    // 15400 grain over 154 vbytes is 100000 grain per 1000 vbytes exactly.
    expect(() => checkStandard(tx, { ...spending(15400n), maxFeeRate: 100_000n })).not.toThrow();
    // 15401 grain is 100006.49, which truncates to the limit and passes.
    expect(() => checkStandard(tx, { ...spending(15401n), maxFeeRate: 100_006n })).not.toThrow();
    let error: unknown;
    try {
      checkStandard(tx, { ...spending(15401n), maxFeeRate: 100_000n });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(PolicyError);
    expect((error as PolicyError).code).toBe('POLICY_FEE_TOO_HIGH');
    expect((error as PolicyError).message).toContain('max-fee-exceeded');
    // No limit unless asked for.
    expect(() => checkStandard(tx, spending(1_000_000_000n))).not.toThrow();
  });

  it('reports spending more than the inputs before a non-standard version or dust, as pearld does', () => {
    const tx = parseTransaction(standard('standard').txHex);
    tx.version = 3;
    tx.outs[0]!.value = 1n;
    const spent = tx.outs.reduce((sum, output) => sum + output.value, 0n);
    expect(() => checkStandard(tx, { prevouts: [{ script: p2tr, value: spent - 1n }] })).toThrow(
      `total value of all transaction inputs for transaction ${tx.getId()} is ${spent - 1n} which is less than the amount spent of ${spent}`,
    );
  });
});

// Messages confirmed against a regtest pearld by test/live/policy.test.ts.
describe('checkSanity', () => {
  const fresh = (): Transaction => parseTransaction(standard('standard').txHex);

  it('accepts a standard transaction', () => {
    expect(() => checkSanity(fresh())).not.toThrow();
  });

  it('refuses an output above the maximum amount, with the trailing space pearld prints', () => {
    const tx = fresh();
    tx.outs[0]!.value = MAX_GRAIN + 1n;
    const message = 'transaction output value is higher than max allowed value: 2100000000000000001 > 2.1e+18 ';
    expect(() => checkSanity(tx)).toThrow(new PolicyError('SANITY_OUTPUT_TOO_LARGE', message));
    // checkStandard used to call this output dust.
    expect(() => checkStandard(tx)).toThrow(new PolicyError('SANITY_OUTPUT_TOO_LARGE', message));
  });

  it('refuses a negative output and outputs that sum above the maximum', () => {
    const negative = fresh();
    negative.outs[0]!.value = -1n;
    expect(() => checkSanity(negative)).toThrow('transaction output has negative value of -1');
    const tx = fresh();
    tx.outs[0]!.value = MAX_GRAIN;
    tx.outs[1]!.value = 1n;
    expect(() => checkSanity(tx)).toThrow(
      'total value of all transaction outputs is 2100000000000000001 which is higher than max allowed value of 2.1e+18',
    );
  });

  it('refuses duplicate inputs, which checkStandard used to accept', () => {
    const tx = fresh();
    tx.addInput(tx.ins[0]!.hash, tx.ins[0]!.index);
    tx.setWitness(tx.ins.length - 1, tx.ins[0]!.witness);
    expect(() => checkSanity(tx)).toThrow('transaction contains duplicate inputs');
    expect(() => checkStandard(tx)).toThrow('transaction contains duplicate inputs');
  });

  it('refuses a null previous output and a coinbase', () => {
    const tx = fresh();
    tx.addInput(new Uint8Array(32), 0xffffffff);
    expect(() => checkSanity(tx)).toThrow('transaction input refers to previous output that is null');

    const coinbase = fresh();
    coinbase.ins.splice(1);
    coinbase.ins[0]!.hash = new Uint8Array(32);
    coinbase.ins[0]!.index = 0xffffffff;
    expect(() => checkSanity(coinbase)).toThrow(
      'coinbase transaction script length of 0 is out of range (min: 2, max: 100)',
    );
    coinbase.ins[0]!.script = Uint8Array.of(0x51, 0x51);
    expect(() => checkSanity(coinbase)).toThrow(`transaction is an individual coinbase ${coinbase.getId()}`);
  });

  it('refuses a transaction with no inputs, no outputs or more vbytes than a block', () => {
    const noInputs = fresh();
    noInputs.ins.splice(0);
    expect(() => checkSanity(noInputs)).toThrow('transaction has no inputs');
    const noOutputs = fresh();
    noOutputs.outs.splice(0);
    expect(() => checkSanity(noOutputs)).toThrow('transaction has no outputs');
    const huge = fresh();
    huge.outs[0]!.script = Uint8Array.from([0x6a, ...new Uint8Array(1_000_000)]);
    expect(() => checkSanity(huge)).toThrow(/^transaction vsize is too big - got \d+, max 1000000$/);
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

  for (const expected of vectors.tapscriptExtras.filter((item) => item.annex !== '')) {
    it(`is exact for ${expected.name}, whose witness ends with a ${expected.annex.length / 2}-byte annex`, () => {
      const signed = parseTransaction(expected.finalTxHex);
      const inputIndex = signed.ins.findIndex((input) => input.witness.length >= 2 && bytesToHex(input.witness.at(-1)!) === expected.annex);
      const tree = assembleScriptTree([hexToBytes(expected.leafScript)]);
      const spend: SpendEstimate = {
        type: 'scriptPath',
        tree,
        leafIndex: 0,
        p2mr: expected.kind === 'p2mr',
        stack: signed.ins[inputIndex]!.witness.slice(0, -3).map((item) => item.length),
        annexLength: expected.annex.length / 2,
      };
      const spends = otherInputs(signed, inputIndex, spend);
      expect(estimateVsize(parseTransaction(expected.unsignedTxHex), spends)).toBe(signed.virtualSize());
    });
  }

  it('adds the annex and its length prefix to a key-path witness, as the 5-byte annexes on mainnet do', () => {
    // 94 bytes without witness, 4 weight each; witness: marker and flag 2, item count 1, signature 1 + 64, annex 1 + 5.
    const unsigned = createTransaction(2);
    unsigned.addInput(new Uint8Array(32), 0);
    unsigned.addOutput(p2tr, 1000n);
    expect(estimateVsize(unsigned, [{ type: 'keyPath' }])).toBe(Math.ceil((94 * 4 + 2 + 1 + 65) / 4));
    expect(estimateVsize(unsigned, [{ type: 'keyPath', annexLength: 5 }])).toBe(Math.ceil((94 * 4 + 2 + 1 + 65 + 6) / 4));
    expect(() => estimateVsize(unsigned, [{ type: 'keyPath', annexLength: 0 }])).toThrow(RangeError);
  });

  it('sizes an annex or a witness item of 2 GiB by arithmetic, without allocating it, and refuses a size that is not a byte count', () => {
    const unsigned = createTransaction(2);
    unsigned.addInput(new Uint8Array(32), 0);
    unsigned.addOutput(p2tr, 1000n);
    // 9-byte length prefix past 2^32, 5 bytes below it.
    expect(estimateVsize(unsigned, [{ type: 'keyPath', annexLength: 2 ** 33 }])).toBe(Math.ceil((94 * 4 + 2 + 1 + 65 + 9 + 2 ** 33) / 4));
    expect(estimateVsize(unsigned, [{ type: 'witness', items: [2 ** 31] }])).toBe(Math.ceil((94 * 4 + 2 + 1 + 5 + 2 ** 31) / 4));
    expect(estimateVsize(unsigned, [{ type: 'witness', items: [] }])).toBe(94);
    for (const size of [-1, 1.5, Number.NaN, 2 ** 53]) {
      expect(() => estimateVsize(unsigned, [{ type: 'witness', items: [size] }])).toThrow(RangeError);
      expect(() => estimateVsize(unsigned, [{ type: 'keyPath', annexLength: size }])).toThrow(RangeError);
    }
  });

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
