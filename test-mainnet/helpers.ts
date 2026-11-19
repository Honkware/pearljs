import { readFileSync } from 'node:fs';
import { parseBlock } from '../src/block.js';
import type { PearlBlock } from '../src/block.js';
import { fromHex } from '../src/internal/bytes.js';

/** A mainnet block saved under fixtures/ as pearld's getblock verbosity 0 hex. */
export function mainnetBlock(height: number): PearlBlock {
  return parseBlock(fromHex(readFileSync(new URL(`./fixtures/block-${height}.hex`, import.meta.url), 'utf8').trim()));
}
