import { describe, expect, it } from 'vitest';
import {
  feeRateFromGrainPerVbyte,
  feeRateFromPearlPerKvB,
  feeRateToGrainPerVbyte,
  feeRateToPearlPerKvB,
  formatPearl,
  GRAIN_PER_PEARL,
  MAX_GRAIN,
  parsePearl,
} from '../src/amount.js';

describe('constants', () => {
  it('defines grains per pearl and the maximum amount', () => {
    expect(GRAIN_PER_PEARL).toBe(100000000n);
    // btcutil.MaxGrain = 21e9 * 1e8, not the chain total supply.
    expect(MAX_GRAIN).toBe(2100000000000000000n);
  });
});

describe('parsePearl', () => {
  it('reads an amount followed by one space and either ticker', () => {
    expect(parsePearl('1.5 PRL')).toBe(150000000n);
    expect(parsePearl('1.5 PEARL')).toBe(150000000n);
    expect(parsePearl(formatPearl(12345678901n, 'PEARL'))).toBe(12345678901n);
    for (const bad of ['1.5PRL', '1.5  PRL', '1.5 prl', '1.5 PRL ', 'PRL 1.5', '1.5 BTC', ' PRL', '1.5 PRL PRL']) {
      expect(() => parsePearl(bad)).toThrow(/invalid/);
    }
  });

  it('formats with a unit only when asked for one', () => {
    expect(formatPearl(150000000n)).toBe('1.5');
    expect(formatPearl(150000000n, 'PRL')).toBe('1.5 PRL');
    expect(formatPearl(-1n, 'PEARL')).toBe('-0.00000001 PEARL');
    expect(() => formatPearl(1n, 'BTC' as never)).toThrow(TypeError);
  });

  it('parses whole pearls', () => {
    expect(parsePearl('0')).toBe(0n);
    expect(parsePearl('1')).toBe(100000000n);
    expect(parsePearl('42')).toBe(4200000000n);
  });

  it('parses fractional pearls up to 8 decimals', () => {
    expect(parsePearl('0.00000001')).toBe(1n);
    expect(parsePearl('1.5')).toBe(150000000n);
    expect(parsePearl('0.10000000')).toBe(10000000n);
    expect(parsePearl('123.45678901')).toBe(12345678901n);
  });

  it('accepts the exact maximum and rejects one grain above it', () => {
    expect(parsePearl('21000000000')).toBe(MAX_GRAIN);
    expect(parsePearl('21000000000.00000000')).toBe(MAX_GRAIN);
    expect(() => parsePearl('21000000000.00000001')).toThrow(/exceeds/);
    expect(() => parsePearl('21000000001')).toThrow(/exceeds/);
  });

  it('rejects more than 8 decimal places', () => {
    expect(() => parsePearl('0.000000001')).toThrow(/invalid/);
    expect(() => parsePearl('1.000000001')).toThrow(/invalid/);
    // Leading zeros are refused: '00000001' is not one PRL.
    for (const text of ['00000001', '01', '00', '00.5', '01.5']) expect(() => parsePearl(text)).toThrow(/invalid/);
    expect(parsePearl('0')).toBe(0n);
    expect(parsePearl('0.5')).toBe(50000000n);
  });

  it('rejects non-decimal input', () => {
    for (const bad of [
      '',
      ' ',
      'abc',
      '-1',
      '-0.5',
      '+1',
      '.5',
      '1.',
      '1.5.0',
      '1e3',
      '0x10',
      '1,000',
      ' 1',
      '1 ',
      'Infinity',
      'NaN',
    ]) {
      expect(() => parsePearl(bad)).toThrow(/invalid/);
    }
  });

  it('rejects JS number input', () => {
    for (const bad of [1, 1.5, 0, Number.MAX_SAFE_INTEGER]) {
      expect(() => parsePearl(bad as unknown as string)).toThrow(TypeError);
    }
  });
});

describe('formatPearl', () => {
  it('formats whole pearls without a decimal point', () => {
    expect(formatPearl(0n)).toBe('0');
    expect(formatPearl(100000000n)).toBe('1');
    expect(formatPearl(MAX_GRAIN)).toBe('21000000000');
  });

  it('formats fractional pearls with up to 8 decimals', () => {
    expect(formatPearl(1n)).toBe('0.00000001');
    expect(formatPearl(150000000n)).toBe('1.5');
    expect(formatPearl(10000000n)).toBe('0.1');
    expect(formatPearl(12345678901n)).toBe('123.45678901');
  });

  it('formats negative amounts with a leading minus, as wallet history shows sends', () => {
    expect(formatPearl(-1n)).toBe('-0.00000001');
    expect(formatPearl(-150000000n)).toBe('-1.5');
    expect(formatPearl(-100000000n)).toBe('-1');
    expect(formatPearl(-MAX_GRAIN)).toBe('-21000000000');
    expect(formatPearl(-0n)).toBe('0');
  });

  it('rejects out-of-range amounts', () => {
    expect(() => formatPearl(-MAX_GRAIN - 1n)).toThrow(/out of range/);
    expect(() => formatPearl(MAX_GRAIN + 1n)).toThrow(/out of range/);
  });

  it('rejects JS number input', () => {
    for (const bad of [0, 1, 21000000000]) {
      expect(() => formatPearl(bad as unknown as bigint)).toThrow(TypeError);
    }
  });

  it('round-trips with parsePearl on both boundaries', () => {
    const samples = [
      0n,
      1n,
      100000000n,
      150000000n,
      12345678901n,
      MAX_GRAIN - 1n,
      MAX_GRAIN,
    ];
    for (const grain of samples) {
      expect(parsePearl(formatPearl(grain))).toBe(grain);
    }
  });
});

describe('fee rate units', () => {
  it('converts grain per vbyte to grain per 1000 vbytes', () => {
    expect(feeRateFromGrainPerVbyte(1n)).toBe(1000n);
    expect(feeRateFromGrainPerVbyte('1')).toBe(1000n);
    expect(feeRateFromGrainPerVbyte('1.5')).toBe(1500n);
    expect(feeRateFromGrainPerVbyte('0.001')).toBe(1n);
    expect(feeRateFromGrainPerVbyte('12.34')).toBe(12340n);
    expect(feeRateFromGrainPerVbyte(0n)).toBe(0n);
  });

  it('converts back without trailing zeros', () => {
    expect(feeRateToGrainPerVbyte(1000n)).toBe('1');
    expect(feeRateToGrainPerVbyte(1500n)).toBe('1.5');
    expect(feeRateToGrainPerVbyte(1n)).toBe('0.001');
    expect(feeRateToGrainPerVbyte(12340n)).toBe('12.34');
    expect(feeRateToGrainPerVbyte(0n)).toBe('0');
  });

  it('reads and writes PRL per 1000 vbytes, the unit of the RPC', () => {
    // pearld's default relay fee of 1000 grain per 1000 vbytes.
    expect(feeRateFromPearlPerKvB('0.00001')).toBe(1000n);
    expect(feeRateToPearlPerKvB(1000n)).toBe('0.00001');
    expect(feeRateToPearlPerKvB(feeRateFromGrainPerVbyte('2.5'))).toBe('0.000025');
    expect(feeRateToGrainPerVbyte(feeRateFromPearlPerKvB('0.0001'))).toBe('10');
  });

  it('round-trips every rate it can express', () => {
    for (const rate of [0n, 1n, 999n, 1000n, 1001n, 123456789n]) {
      expect(feeRateFromGrainPerVbyte(feeRateToGrainPerVbyte(rate))).toBe(rate);
      expect(feeRateFromPearlPerKvB(feeRateToPearlPerKvB(rate))).toBe(rate);
    }
  });

  it('rejects numbers, negative rates and finer than a thousandth of a grain', () => {
    expect(() => feeRateFromGrainPerVbyte(1.5 as unknown as string)).toThrow(TypeError);
    for (const bad of ['', '-1', '1.2345', '1e3', ' 1', '.5']) {
      expect(() => feeRateFromGrainPerVbyte(bad)).toThrow(/invalid fee rate/);
    }
    expect(() => feeRateFromGrainPerVbyte(-1n)).toThrow(/invalid fee rate/);
    expect(() => feeRateToGrainPerVbyte(-1n)).toThrow(/non-negative/);
    expect(() => feeRateToPearlPerKvB(-1n)).toThrow(/non-negative/);
  });
});
