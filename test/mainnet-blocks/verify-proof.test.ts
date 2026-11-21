// Mainnet blocks whose proofs pearld accepted. Each V2 and V3 block is the
// smallest block (coinbase only) that shows one way a verifier built before
// zk-pow's matrix positions were computed in 64 bits failed on the chain: a
// thrown RangeError, a rejection or a panic. The V1 blocks were read from a
// mainnet pearld's block store.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyBlockProof } from '../../src/verify-proof.js';
import { mainnetBlock } from './helpers.js';

describe('verifyBlockProof on mainnet', () => {
  it.each([
    [98976, 'a V2 proof that threw a RangeError'],
    [91600, 'a V2 proof the verifier called invalid'],
    [98800, 'a V2 proof that panicked as unreachable code'],
    [145267, 'a V3 proof the verifier called invalid'],
    [144600, 'a V3 proof that panicked with an index out of bounds'],
  ])('accepts the proof of block %i, %s', async (height) => {
    const verdict = await verifyBlockProof(mainnetBlock(height));
    expect(verdict).toEqual({ valid: true, outcome: 'accepted', message: 'Proof verified successfully' });
  });

  it.each([
    [200, 'the V1 proof'],
    [24000, 'a V1 proof of 6013 rows'],
    [71740, 'a V1 proof whose B matrix holds 2^34 bytes, past a 32-bit position'],
    [71934, 'the last V1 proof'],
  ])('accepts block %i, %s, as pearld\'s V1 path does', async (height) => {
    expect(await verifyBlockProof(mainnetBlock(height))).toEqual({ valid: true, outcome: 'accepted', message: 'V1 proof verified successfully' });
  });

  it('keeps its memory flat over many proofs in one process', async () => {
    // Before the patch freed each proof's circuit layout, the module kept some
    // 24 MB a proof and reached WebAssembly's 4 GB after about 250.
    const block = mainnetBlock(139000);
    expect((await verifyBlockProof(block)).outcome).toBe('accepted');
    const before = process.memoryUsage().external;
    let most = 0;
    for (let i = 0; i < 60; i += 1) {
      expect((await verifyBlockProof(block)).outcome).toBe('accepted');
      globalThis.gc?.();
      most = Math.max(most, process.memoryUsage().external - before);
    }
    expect(most).toBeLessThan(32 * 1024 * 1024);
  });

  it('keeps the module\'s memory flat over 100 V1 proofs', async () => {
    // Before the patch freed each V1 proof's circuit layout in place, rayon's
    // spawned drop never ran on wasm32 and every proof kept its layout.
    const instantiate = WebAssembly.instantiate.bind(WebAssembly) as (module: WebAssembly.Module, imports: WebAssembly.Imports) => Promise<WebAssembly.Instance>;
    let memory: WebAssembly.Memory | undefined;
    vi.spyOn(WebAssembly, 'instantiate').mockImplementation((async (module: WebAssembly.Module, imports: WebAssembly.Imports) => {
      const instance = await instantiate(module, imports);
      memory = instance.exports.memory as WebAssembly.Memory;
      return instance;
    }) as typeof WebAssembly.instantiate);
    vi.resetModules();
    const { verifyBlockProof: verify } = await import('../../src/verify-proof.js');
    const blocks = [200, 24000, 71740, 71934].map(mainnetBlock);
    for (const block of blocks) expect((await verify(block)).outcome).toBe('accepted');
    const before = memory!.buffer.byteLength;
    for (let i = 0; i < 100; i += 1) expect((await verify(blocks[i % blocks.length]!)).outcome).toBe('accepted');
    expect(memory!.buffer.byteLength).toBe(before);
  }, 300_000);
});

afterEach(() => {
  vi.restoreAllMocks();
});
