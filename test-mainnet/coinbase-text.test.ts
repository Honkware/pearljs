// Mainnet miners that write the extra nonce or the tag as raw bytes instead
// of pushes. coinbaseText reads the script as pushes, so a raw nonce byte
// becomes an opcode or a push length that swallows part of the tag, and a
// raw "/" (0x2f) reads as a push of 47 bytes.

import { describe, expect, it } from 'vitest';
import fixture from './fixtures/coinbase-scripts.json';
import { coinbaseText } from '../src/inspect.js';
import { fromHex } from '../src/internal/bytes.js';

describe('coinbaseText on mainnet coinbases', () => {
  it.each(fixture.scripts.map((s) => [s.height, s.tag, s.hex] as const))('finds the tag of block %i, %s, whole', (_height, tag, hex) => {
    expect(coinbaseText(fromHex(hex))).toContain(tag);
  });
});
