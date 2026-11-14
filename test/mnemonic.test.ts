import { describe, expect, it } from 'vitest';
import {
  entropyToMnemonic,
  generateMnemonic,
  mnemonicToEntropy,
  mnemonicToSeed,
  normalizeMnemonic,
  parseSeedInput,
  seedFromInput,
  validateMnemonic,
} from '../src/mnemonic.js';

const ABANDON = `${'abandon '.repeat(11)}about`;
const LEGAL = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('mnemonic helpers', () => {
  it('normalizes case and whitespace', () => {
    expect(normalizeMnemonic(`  ABANDON\tabandon\n abandon  `)).toBe('abandon abandon abandon');
  });

  it('validates after normalizing', () => {
    expect(validateMnemonic(ABANDON)).toBe(true);
    expect(validateMnemonic(`\n${ABANDON.toUpperCase().replace(/ /g, '  ')} `)).toBe(true);
    expect(validateMnemonic('abandon abandon abandon')).toBe(false);
  });

  it('encodes and decodes the official BIP39 entropy vectors', () => {
    expect(entropyToMnemonic(new Uint8Array(16))).toBe(ABANDON);
    expect(entropyToMnemonic(new Uint8Array(16).fill(0x7f))).toBe(LEGAL);
    expect(hex(mnemonicToEntropy(LEGAL))).toBe('7f'.repeat(16));
    expect(() => entropyToMnemonic(new Uint8Array(15))).toThrow(RangeError);
    expect(() => entropyToMnemonic(new Uint8Array(36))).toThrow(RangeError);
    expect(() => mnemonicToEntropy('abandon abandon')).toThrow(/invalid BIP39 mnemonic/);
  });

  it('generates valid mnemonics of every allowed length', () => {
    expect(generateMnemonic().split(' ')).toHaveLength(12);
    for (const n of [12, 15, 18, 21, 24] as const) {
      const m = generateMnemonic(n);
      expect(m.split(' ')).toHaveLength(n);
      expect(validateMnemonic(m)).toBe(true);
    }
    expect(generateMnemonic()).not.toBe(generateMnemonic());
    expect(() => generateMnemonic(13 as 12)).toThrow(RangeError);
  });

  it('derives the same seed however the phrase is pasted', () => {
    const plain = hex(mnemonicToSeed(ABANDON));
    expect(plain).toBe(
      '5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4',
    );
    expect(hex(mnemonicToSeed(`  ${ABANDON.toUpperCase()}\n`))).toBe(plain);
    expect(hex(mnemonicToSeed(ABANDON.replace(/ /g, '\t')))).toBe(plain);
  });

  it('uses an empty passphrase by default', () => {
    expect(hex(mnemonicToSeed(ABANDON, ''))).toBe(hex(mnemonicToSeed(ABANDON)));
    expect(hex(mnemonicToSeed(ABANDON, 'TREZOR'))).not.toBe(hex(mnemonicToSeed(ABANDON)));
  });
});

describe('parseSeedInput', () => {
  it('reads a mnemonic', () => {
    const r = parseSeedInput(` ${LEGAL.toUpperCase()} `);
    expect(r.kind).toBe('mnemonic');
    if (r.kind === 'mnemonic') {
      expect(r.wordCount).toBe(12);
      expect(hex(r.seed)).toBe(hex(mnemonicToSeed(LEGAL)));
    }
  });

  it('reads 16 to 64 byte hex seeds, with or without 0x', () => {
    for (const bytes of [16, 32, 64]) {
      const h = 'ab'.repeat(bytes);
      for (const input of [h, h.toUpperCase(), `0x${h}`]) {
        const r = parseSeedInput(input);
        expect(r.kind).toBe('hex');
        if (r.kind === 'hex') expect(hex(r.seed)).toBe(h);
      }
    }
  });

  it('ignores the passphrase for hex seeds', () => {
    expect(hex(seedFromInput('ab'.repeat(16), 'x'))).toBe('ab'.repeat(16));
  });

  it('reports why input is invalid', () => {
    const reason = (s: string) => {
      const r = parseSeedInput(s);
      return r.kind === 'invalid' ? r.reason : r.kind;
    };
    expect(reason('  ')).toMatch(/empty/);
    expect(reason('ab'.repeat(15))).toMatch(/16 to 64 bytes/);
    expect(reason('ab'.repeat(65))).toMatch(/16 to 64 bytes/);
    expect(reason('abc')).toMatch(/even number/);
    expect(reason('hello')).toMatch(/mnemonic or a hex/);
    expect(reason(`${ABANDON} zzzz`)).toMatch(/"zzzz" is not a BIP39 word/);
    expect(reason('abandon abandon abandon')).toMatch(/12, 15, 18, 21 or 24 words, got 3/);
    expect(reason(`${'abandon '.repeat(11)}abandon`)).toMatch(/checksum/);
    expect(() => seedFromInput('nope')).toThrow(/invalid seed/);
  });
});
