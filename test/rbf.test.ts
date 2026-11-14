// Replacement and package limits against TxPools built in generate.go: each
// scenario offers its transactions to a fresh pool and records what pearld
// accepted or refused, and the tests replay them through checkReplacement and
// checkPackageLimits. Fees and CPFP are checked against the same pools.

import { describe, expect, it } from 'vitest';
import {
  checkPackageLimits,
  checkReplacement,
  cpfpChildFee,
  DEFAULT_ANCESTOR_COUNT_LIMIT,
  feeForVsize,
  MAX_RBF_SEQUENCE,
  minRelayFee,
  packageFeeRate,
  parseTransaction,
  replacementFee,
  signalsReplacement,
} from '../src/index.js';
import type { MempoolTx, Transaction } from '../src/index.js';
import vectors from '../vectors/pearl-go.json' with { type: 'json' };

type Scenario = (typeof vectors.mempool)[number];

const scenario = (name: string): Scenario => vectors.mempool.find((item) => item.name === name)!;
const tx = (s: Scenario, name: string): Transaction =>
  parseTransaction(s.transactions.find((item) => item.name === name)!.txHex);
const fee = (s: Scenario, name: string): bigint => BigInt(s.transactions.find((item) => item.name === name)!.fee);

/** Offers the scenario's transactions in order; returns each refusal and the pool after the last accepted one. */
function replay(s: Scenario, until?: string): { errors: string[]; pool: Map<string, MempoolTx> } {
  const pool = new Map<string, MempoolTx>();
  const errors: string[] = [];
  for (const item of s.transactions) {
    if (item.name === until) break;
    const candidate = parseTransaction(item.txHex);
    let evicted: string[] = [];
    let error = '';
    try {
      evicted = checkReplacement(candidate, BigInt(item.fee), pool, { rejectReplacement: s.rejectReplacement });
      checkPackageLimits(candidate, pool, { replaced: evicted });
    } catch (err) {
      error = (err as Error).message;
    }
    errors.push(error);
    if (error === '') {
      evicted.forEach((txid) => pool.delete(txid));
      pool.set(candidate.getId(), { tx: candidate, fee: BigInt(item.fee) });
    }
  }
  return { errors, pool };
}

describe('replacement and package limits', () => {
  for (const s of vectors.mempool) {
    it(`gives pearld's result for every transaction in ${s.name}`, () => {
      expect(replay(s).errors).toEqual(s.transactions.map((item) => item.error));
    });
  }

  it('measures vsize the way the pool does', () => {
    for (const s of vectors.mempool) {
      for (const item of s.transactions) expect(parseTransaction(item.txHex).virtualSize()).toBe(item.vsize);
    }
  });

  it('removes the replaced transaction from the pool', () => {
    const s = scenario('explicit-signal');
    const { pool } = replay(s, 'replacing-a-non-signalling-transaction');
    expect([...pool.keys()]).toEqual([tx(s, 'replacement').getId()]);
  });

  it('evicts a conflict together with its descendants', () => {
    const s = scenario('evicts-100');
    const { pool } = replay(s, 'replacement');
    expect(checkReplacement(tx(s, 'replacement'), fee(s, 'replacement'), pool)).toHaveLength(100);
  });

  it('returns no conflicts for a transaction that spends nothing in the pool', () => {
    const s = scenario('explicit-signal');
    expect(checkReplacement(tx(s, 'original'), 1000n, new Map())).toEqual([]);
  });
});

describe('signalsReplacement', () => {
  const s = scenario('inherited-signal');
  const { pool } = replay(s, 'child-replacement');

  it('signals through an input sequence at or below 0xfffffffd', () => {
    const parent = tx(s, 'signalling-parent');
    expect(parent.ins[0]!.sequence).toBe(MAX_RBF_SEQUENCE);
    expect(signalsReplacement(parent)).toBe(true);
    parent.ins[0]!.sequence = MAX_RBF_SEQUENCE + 1;
    expect(signalsReplacement(parent)).toBe(false);
  });

  it('inherits the signal from an unconfirmed ancestor only when given the pool', () => {
    const child = tx(s, 'non-signalling-child');
    expect(signalsReplacement(child)).toBe(false);
    expect(signalsReplacement(child, pool)).toBe(true);
  });

  it('treats a transaction as final once its signalling parent leaves the pool', () => {
    const child = tx(s, 'non-signalling-child');
    const withoutParent = new Map([...pool].filter(([txid]) => txid !== tx(s, 'signalling-parent').getId()));
    expect(signalsReplacement(child, withoutParent)).toBe(false);
  });
});

describe('replacementFee', () => {
  it('is the fee pearld accepted at the exact minimum', () => {
    const s = scenario('absolute-fee');
    const original = s.transactions.find((item) => item.name === 'original')!;
    const exact = s.transactions.find((item) => item.name === 'exact-minimum')!;
    expect(replacementFee([{ fee: BigInt(original.fee), vsize: original.vsize }], exact.vsize)).toBe(BigInt(exact.fee));
  });

  it('beats the evicted fee rate when that binds harder than the absolute fee', () => {
    const s = scenario('fee-rate-not-higher');
    const { pool } = replay(s, 'larger-replacement-at-a-lower-rate');
    const original = s.transactions.find((item) => item.name === 'original')!;
    const larger = tx(s, 'larger-replacement-at-a-lower-rate');
    const needed = replacementFee([{ fee: BigInt(original.fee), vsize: original.vsize }], larger.virtualSize());
    expect(needed).toBeGreaterThan(BigInt(original.fee) + minRelayFee(larger.virtualSize()));
    expect(checkReplacement(larger, needed, pool)).toHaveLength(1);
    expect(() => checkReplacement(larger, needed - 1n, pool)).toThrow('insufficient fee rate');
  });

  it('covers a hundred evictions', () => {
    const s = scenario('evicts-100');
    const { pool } = replay(s, 'replacement');
    const replacement = tx(s, 'replacement');
    const evicted = [...pool.values()].map((entry) => ({ fee: entry.fee, vsize: entry.tx.virtualSize() }));
    const needed = replacementFee(evicted, replacement.virtualSize());
    expect(checkReplacement(replacement, needed, pool)).toHaveLength(100);
    expect(() => checkReplacement(replacement, needed - 1n, pool)).toThrow('insufficient absolute fee');
  });

  it('is the least fee whose truncated rate exceeds the evicted rate', () => {
    const evicted = { fee: 50_000n, vsize: 200 };
    const evictedRate = (evicted.fee * 1000n) / 200n;
    for (let vsize = 201; vsize < 2000; vsize += 7) {
      const needed = replacementFee([evicted], vsize);
      const rate = (fee: bigint): bigint => (fee * 1000n) / BigInt(vsize);
      expect(rate(needed), `vsize ${vsize}`).toBeGreaterThan(evictedRate);
      const absolute = evicted.fee + minRelayFee(vsize);
      if (needed > absolute) expect(rate(needed - 1n), `vsize ${vsize}`).toBeLessThanOrEqual(evictedRate);
    }
  });

  it('uses a higher relay fee when given one', () => {
    expect(replacementFee([{ fee: 1000n, vsize: 111 }], 111, 5000n)).toBe(1000n + 555n);
  });
});

describe('checkPackageLimits', () => {
  it('lets a chain of 25 in and the 26th only under raised limits', () => {
    const s = scenario('ancestor-count');
    const { pool } = replay(s, 'chain-25');
    expect(pool.size).toBe(DEFAULT_ANCESTOR_COUNT_LIMIT);
    // The first transaction would also have 25 descendants.
    const chained = tx(s, 'chain-25');
    expect(() => checkPackageLimits(chained, pool, { limits: { ancestorCount: 26 } })).toThrow('too many descendants');
    const limits = { ancestorCount: 26, descendantCount: 26 };
    expect(() => checkPackageLimits(chained, pool, { limits })).not.toThrow();
  });

  it('enforces nothing when every limit is 0', () => {
    const s = scenario('ancestor-size');
    const { pool } = replay(s, 'fat-child');
    const limits = { ancestorCount: 0, ancestorSize: 0, descendantCount: 0 };
    expect(() => checkPackageLimits(tx(s, 'fat-child'), pool, { limits })).not.toThrow();
  });

  it('does not count descendants the transaction replaces', () => {
    const s = scenario('descendant-count');
    const { pool } = replay(s, 'child-24');
    const child = tx(s, 'child-24');
    expect(() => checkPackageLimits(child, pool)).toThrow('too many descendants');
    const replaced = [tx(s, 'child-0').getId()];
    expect(() => checkPackageLimits(child, pool, { replaced })).not.toThrow();
  });

  it('uses a vsize given for an unsigned transaction', () => {
    const s = scenario('ancestor-size');
    const { pool } = replay(s, 'fat-child');
    expect(() => checkPackageLimits(tx(s, 'fat-child'), pool, { vsize: 1000 })).not.toThrow();
  });
});

describe('cpfpChildFee', () => {
  const parent = { fee: 1000n, vsize: 111 };

  it('lifts the package to the target rate', () => {
    const childFee = cpfpChildFee([parent], 111, 20_000n);
    expect(childFee).toBe(feeForVsize(222, 20_000n) - 1000n);
    expect(packageFeeRate([parent, { fee: childFee, vsize: 111 }])).toBeGreaterThanOrEqual(20_000n);
    expect(packageFeeRate([parent, { fee: childFee - 1n, vsize: 111 }])).toBeLessThan(20_000n);
  });

  it('never asks less than the child relay fee', () => {
    expect(cpfpChildFee([{ fee: 1_000_000n, vsize: 111 }], 150, 1000n)).toBe(minRelayFee(150));
  });

  it('sums several parents', () => {
    const childFee = cpfpChildFee([parent, { fee: 2000n, vsize: 154 }], 200, 10_000n);
    expect(childFee).toBe(feeForVsize(465, 10_000n) - 3000n);
  });

  it('refuses a package with no vsize', () => {
    expect(() => packageFeeRate([])).toThrow(RangeError);
  });
});
