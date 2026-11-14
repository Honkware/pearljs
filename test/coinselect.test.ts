// Coin selection against Oyster's own: every case in the coinSelection
// vectors is txauthor.NewUnsignedTransaction run in Go over coins arranged by
// Oyster's strategies, and pearljs must pick the same inputs, change and fee.
// Property tests then check what must hold for any set of coins.

import { describe, expect, it } from 'vitest';
import {
  arrangeCoins,
  COINBASE_MATURITY,
  confirmations,
  DEFAULT_MIN_RELAY_FEE,
  InsufficientFundsError,
  isDust,
  minRelayFee,
  selectCoins,
  spendableUtxos,
} from '../src/index.js';
import type { CoinSelection, CoinSelectionStrategy, Utxo } from '../src/index.js';
import vectors from '../vectors/pearl-go.json' with { type: 'json' };
import { hexToBytes } from './vector-helpers.js';
import { coinsOf, INPUT_KINDS, outpoint, seededRandom, selectionCase } from './wallet-helpers.js';
import type { SelectionVector } from './wallet-helpers.js';

const p2trScript = (byte: number) => hexToBytes(`5120${byte.toString(16).padStart(2, '0').repeat(32)}`);

function run(vector: SelectionVector, coins = coinsOf(vector)): CoinSelection {
  const byOutpoint = new Map(coins.map((coin) => [outpoint(coin), coin]));
  // Go's shuffle cannot be replayed, so the order Oyster's input source saw
  // is fed in directly; the filter before the shuffle is checked on its own.
  const strategy: CoinSelectionStrategy =
    vector.strategy === 'random'
      ? () => vector.arranged.map((id) => byOutpoint.get(id)!)
      : (vector.strategy as 'largest' | 'all');
  return selectCoins({
    utxos: coins,
    outputs: vector.outputs.map((output) => ({ script: hexToBytes(output.script), value: BigInt(output.value) })),
    feeRate: BigInt(vector.feeRate),
    changeScript: hexToBytes(vector.changeScript),
    strategy,
  });
}

describe('selection against Oyster', () => {
  const comparable = vectors.coinSelection.cases.filter(
    (vector) => vector.error === '' && vector.changeScriptSize === 34 && !vector.name.startsWith('P2MR'),
  );

  for (const vector of comparable) {
    it(`picks Oyster's inputs, change and fee for ${vector.name}`, () => {
      const selection = run(vector);
      expect(selection.inputs.map(outpoint)).toEqual(vector.inputs);
      expect(selection.totalInput).toBe(BigInt(vector.totalInput));
      expect(selection.fee).toBe(BigInt(vector.fee));
      expect(selection.change).toBe(BigInt(vector.change));
    });
  }

  it('covers enough cases to mean something', () => {
    expect(comparable.length).toBeGreaterThanOrEqual(14);
    expect(comparable.some((vector) => vector.changeIndex < 0 && BigInt(vector.fee) > 155n)).toBe(true);
  });

  it('arranges largest first in the order Oyster does', () => {
    const vector = selectionCase('three inputs');
    expect(arrangeCoins(coinsOf(vector), 'largest', 1000n).map(outpoint)).toEqual(vector.arranged);
  });

  it('offers the random strategy the coins Oyster offers it', () => {
    const vector = selectionCase('random skips coins that cost more than they add');
    const coins = coinsOf(vector);
    const arranged = arrangeCoins(coins, 'random', BigInt(vector.feeRate), seededRandom(1));
    expect(arranged.map(outpoint).sort()).toEqual([...vector.arranged].sort());
    expect(arranged.length).toBe(coins.length - 2);
  });

  it('shuffles the random strategy with the generator it is given', () => {
    const coins = coinsOf(selectionCase('six inputs'));
    const order = (seed: number) => arrangeCoins(coins, 'random', 1000n, seededRandom(seed)).map(outpoint);
    expect(order(1)).toEqual(order(1));
    expect(order(1)).not.toEqual(order(2));
    expect([...order(1)].sort()).toEqual(coins.map(outpoint).sort());
  });

  for (const estimate of vectors.coinSelection.sizeEstimates) {
    it(`prices ${estimate.inputs} key-path inputs and ${estimate.outputs.length} outputs at Oyster's size`, () => {
      const options = {
        utxos: Array.from({ length: estimate.inputs }, (_, i): Utxo => ({
          txid: i.toString(16).padStart(64, '0'),
          vout: 0,
          value: 1_000_000n,
          script: p2trScript(1),
        })),
        outputs: estimate.outputs.map((script) => ({ script: hexToBytes(script), value: 1n })),
        feeRate: 1000n,
        changeScript: p2trScript(0xcc),
        strategy: 'all' as const,
      };
      if (estimate.inputs === 0) {
        const error = catchError(() => selectCoins(options));
        expect(error.fee).toBe(BigInt(estimate.vsize));
        return;
      }
      const selection = selectCoins(options);
      expect(selection.vsize).toBe(estimate.vsize);
      expect(selection.fee).toBe(BigInt(estimate.vsize));
    });
  }

  it('says how much is missing when the coins do not cover the outputs', () => {
    const vector = selectionCase('not enough coins');
    expect(vector.error).toBe('insufficient funds available to construct transaction');
    const error = catchError(() => run(vector));
    // 5000 out and 213 for two inputs, against 3000 in coins.
    expect(error.available).toBe(3000n);
    expect(error.required).toBe(5213n);
    expect(error.missing).toBe(2213n);
    expect(error.message).toBe(
      'insufficient funds: 0.00002213 PRL short (0.00003 PRL spendable, 0.00005213 PRL needed including a fee of 0.00000213 PRL)',
    );
  });

  it('says how much is missing when only the fee does not fit', () => {
    const vector = selectionCase('enough for the output but not the fee');
    expect(vector.error).not.toBe('');
    expect(catchError(() => run(vector)).missing).toBe(9950n + 155n - 10000n);
  });

  it('charges 9 vbytes less than sweepaccount, which sizes its output as a script', () => {
    const real = selectionCase('sweep to one output');
    const sweepaccount = selectionCase('sweep as sweepaccount sizes it');
    expect(sweepaccount.changeScriptSize).toBe(43);
    expect(BigInt(sweepaccount.fee) - BigInt(real.fee)).toBe(9n);
    expect(run(sweepaccount).fee).toBe(BigInt(real.fee));
  });

  it('prices a P2MR input by its leaf where Oyster prices a key path', () => {
    const vector = selectionCase('P2MR coins priced as key paths');
    expect(() => run(vector)).toThrow(/is P2MR and needs `spend`/);
    const { spend, witness } = INPUT_KINDS[1];
    const selection = run(vector, coinsOf(vector).map((coin) => ({ ...coin, spend })));
    expect(selection.inputs.map(outpoint)).toEqual(vector.inputs);
    // Two inputs of 41 bytes, three outputs of 43, and the witnesses.
    const realVsize = 10 + 2 * 41 + 2 * 43 + Math.ceil((2 + 2 * (1 + witness.reduce((sum, item) => sum + 1 + item, 0))) / 4);
    expect(selection.vsize).toBe(realVsize);
    expect(selection.fee).toBe(minRelayFee(realVsize));
    // Oyster's fee for the same spend would not be relayed at this rate.
    expect(BigInt(vector.fee)).toBeLessThan(minRelayFee(realVsize));
  });
});

function catchError(run: () => unknown): InsufficientFundsError {
  try {
    run();
  } catch (err) {
    if (err instanceof InsufficientFundsError) return err;
    throw err;
  }
  throw new Error('expected insufficient funds');
}

describe('selection properties', () => {
  const random = seededRandom(0x5eed);
  const int = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
  const pick = <T,>(items: readonly T[]): T => items[int(0, items.length - 1)]!;

  it('holds its invariants over random coins, outputs and fee rates', () => {
    let selected = 0;
    let dropped = 0;
    let short = 0;
    for (let round = 0; round < 600; round += 1) {
      const kinds = Array.from({ length: int(1, 12) }, () => pick(random() < 0.6 ? [INPUT_KINDS[0]] : INPUT_KINDS));
      const utxos = kinds.map((kind, i): Utxo => ({
        txid: (round * 100 + i).toString(16).padStart(64, '0'),
        vout: i,
        value: BigInt(int(300, pick([2_000, 50_000, 3_000_000]))),
        script: kind.script,
        ...(kind.spend === undefined ? {} : { spend: kind.spend }),
      }));
      const available = utxos.reduce((sum, utxo) => sum + utxo.value, 0n);
      // One round in five spends everything and leaves about a fee over, so
      // change lands on both sides of the dust limit.
      const tight = random() < 0.2 && available > 5000n;
      const outputs = tight
        ? [{ script: p2trScript(0xa0), value: available - BigInt(int(150, 3000)) }]
        : Array.from({ length: int(1, 3) }, (_, i) => ({
            script: p2trScript(0xa0 + i),
            value: BigInt(int(333, pick([1_000, 40_000, 2_000_000]))),
          }));
      const feeRate = BigInt(pick([1000, 1000, 1001, 1999, 2500, 12_345, 50_000]));
      const strategy = tight ? 'all' : pick(['largest', 'random', 'all'] as const);
      const changeScript = p2trScript(0xcc);
      const target = outputs.reduce((sum, output) => sum + output.value, 0n);

      let selection;
      try {
        selection = selectCoins({ utxos, outputs, feeRate, changeScript, strategy, random });
      } catch (err) {
        if (!(err instanceof InsufficientFundsError)) throw err;
        short += 1;
        expect(err.missing).toBeGreaterThan(0n);
        expect(err.required).toBe(target + err.fee);
        // With the fee Oyster would ask for all of them, the coins fall short.
        expect(err.available).toBeLessThan(err.required);
        if (strategy !== 'random') expect(err.available).toBe(available);
        continue;
      }
      selected += 1;

      const total = selection.inputs.reduce((sum, input) => sum + input.value, 0n);
      expect(selection.totalInput).toBe(total);
      expect(total).toBe(target + selection.change + selection.fee);
      expect(new Set(selection.inputs.map(outpoint)).size).toBe(selection.inputs.length);
      if (strategy === 'all') expect(selection.inputs.length).toBe(utxos.length);

      // The size the transaction will really have, from witness sizes worked
      // out by hand for each kind of input rather than from estimateVsize.
      const base = (changeOutput: boolean) =>
        10 + selection.inputs.length * 41 + (outputs.length + (changeOutput ? 1 : 0)) * 43;
      const witness = selection.inputs.reduce((sum, input) => {
        const kind = INPUT_KINDS.find((item) => item.script === input.script)!;
        return sum + 1 + kind.witness.reduce((size: number, item) => size + (item < 253 ? 1 : 3) + item, 0);
      }, 2);
      const vsize = base(selection.change > 0n) + Math.ceil(witness / 4);
      expect(selection.fee).toBeGreaterThanOrEqual(minRelayFee(vsize));
      expect(selection.fee).toBeGreaterThanOrEqual(minRelayFee(vsize, feeRate));
      // Oyster allows a byte more per signature and one varint, so its size
      // runs over the real one by a weight unit per input and one more.
      const slack = Math.ceil((selection.inputs.length + 1) / 4);

      if (selection.change > 0n) {
        expect(isDust({ script: changeScript, value: selection.change }, DEFAULT_MIN_RELAY_FEE)).toBe(false);
        expect(selection.fee).toBeLessThanOrEqual(minRelayFee(vsize + slack, feeRate));
      } else {
        dropped += 1;
        // Without change the fee also takes a remainder too small to return.
        const kept = selection.fee - minRelayFee(base(true) + Math.ceil(witness / 4) + slack, feeRate);
        expect(kept).toBeLessThan(333n);
      }

      if (strategy === 'largest') {
        // No coin is taken that the ones before it already made unnecessary.
        const withoutLast = total - selection.inputs[selection.inputs.length - 1]!.value;
        expect(withoutLast).toBeLessThan(target + selection.fee);
        const values = selection.inputs.map((input) => input.value);
        expect(values).toEqual([...values].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0)));
      }
    }
    expect(selected).toBeGreaterThan(200);
    expect(short).toBeGreaterThan(50);
    expect(dropped).toBeGreaterThan(5);
  });
});

describe('spendable outputs', () => {
  const coin = (extra: Partial<Utxo>): Utxo => ({ txid: '00'.repeat(32), vout: 0, value: 1000n, script: p2trScript(1), ...extra });

  it('uses the coinbase maturity of Pearl\'s chain parameters', () => {
    expect(COINBASE_MATURITY).toBe(vectors.coinSelection.coinbaseMaturity);
  });

  it('counts confirmations as Oyster does', () => {
    expect(confirmations(100, 100)).toBe(1);
    expect(confirmations(90, 100)).toBe(11);
    expect(confirmations(undefined, 100)).toBe(0);
    expect(confirmations(-1, 100)).toBe(0);
    expect(confirmations(101, 100)).toBe(0);
  });

  it('asks for one confirmation unless told otherwise', () => {
    const coins = [coin({}), coin({ confirmations: 0 }), coin({ confirmations: 1 }), coin({ confirmations: 5 })];
    expect(spendableUtxos(coins)).toEqual([coins[2], coins[3]]);
    expect(spendableUtxos(coins, { minConfirmations: 0 })).toEqual(coins);
    expect(spendableUtxos(coins, { minConfirmations: 3 })).toEqual([coins[3]]);
  });

  it('holds coinbase outputs back until they have 100 confirmations', () => {
    const young = coin({ coinbase: true, confirmations: 99 });
    const mature = coin({ coinbase: true, confirmations: 100 });
    expect(spendableUtxos([young, mature])).toEqual([mature]);
    expect(spendableUtxos([young, mature], { minConfirmations: 0 })).toEqual([mature]);
    expect(spendableUtxos([young, mature], { coinbaseMaturity: 50 })).toEqual([young, mature]);
  });

  it('leaves out outputs worth nothing', () => {
    expect(spendableUtxos([coin({ value: 0n, confirmations: 3 })])).toEqual([]);
  });
});

describe('selection inputs', () => {
  const base = {
    outputs: [{ script: p2trScript(0xa1), value: 1000n }],
    feeRate: 1000n,
    changeScript: p2trScript(0xcc),
  };
  const coin: Utxo = { txid: '11'.repeat(32), vout: 0, value: 50_000n, script: p2trScript(1) };

  it('refuses coins that are not P2TR or P2MR, as Oyster does', () => {
    const legacy = { ...coin, script: hexToBytes(`0014${'01'.repeat(20)}`) };
    expect(() => selectCoins({ ...base, utxos: [legacy] })).toThrow(/not a supported address type \(p2tr or p2mr\)/);
  });

  it('refuses amounts that are not bigint grains', () => {
    expect(() => selectCoins({ ...base, utxos: [{ ...coin, value: 5 as unknown as bigint }] })).toThrow(/outside Pearl amount bounds/);
    expect(() => selectCoins({ ...base, utxos: [coin], feeRate: 1000 as unknown as bigint })).toThrow(/fee rate/);
    expect(() => selectCoins({ ...base, utxos: [coin], outputs: [{ script: p2trScript(2), value: -1n }] })).toThrow(/negative/);
  });

  it('prices an XMSS input at its real size', () => {
    const { spend, script } = INPUT_KINDS[2];
    const selection = selectCoins({ ...base, utxos: [{ ...coin, script, spend }] });
    // The README's 701 vbytes for one XMSS input and one output, plus a 43-byte change output.
    expect(selection.vsize).toBe(701 + 43);
    expect(selection.fee).toBe(744n);
  });

  it('takes a custom arrangement of the coins', () => {
    const coins = [1, 2, 3].map((n): Utxo => ({ ...coin, txid: `0${n}`.repeat(32), value: BigInt(n) * 10_000n }));
    const smallestFirst = selectCoins({ ...base, utxos: coins, strategy: (utxos) => [...utxos].sort((a, b) => Number(a.value - b.value)) });
    expect(smallestFirst.inputs).toEqual([coins[0]]);
    expect(selectCoins({ ...base, utxos: coins }).inputs).toEqual([coins[2]]);
  });
});
