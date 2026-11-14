import { describe, expect, it } from 'vitest';
import {
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

  it('rejects out-of-range amounts', () => {
    expect(() => formatPearl(-1n)).toThrow(/out of range/);
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
