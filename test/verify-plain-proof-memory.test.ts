// A plain proof that declares large dimensions makes zk-pow allocate by them
// before its sanity check refuses them, and the module's memory never
// shrinks. Audit 5, finding 2: one 26 KB share with k = 2^26 left the reused
// instance holding 3.7 GiB. A file of its own, so the spy here does not reach
// the other tests.

import { afterEach, describe, expect, it, vi } from 'vitest';
import vectors from '../vectors/mining/plain.json';
import { fromHex } from '../src/internal/bytes.js';
import { withDimensions } from './plain-proof-wire.js';

const base = vectors.bases.find((b) => b.name === 'V2 dense')!;
const job = { incompleteHeader: fromHex(base.header), certVersion: 2 };
const proof = fromHex(base.proof);
const accepted = { valid: true, outcome: 'accepted', message: 'accepted' };

// Every instance the loader makes, in order.
async function watched() {
  const instantiate = WebAssembly.instantiate.bind(WebAssembly) as (module: WebAssembly.Module, imports: WebAssembly.Imports) => Promise<WebAssembly.Instance>;
  const memories: WebAssembly.Memory[] = [];
  vi.spyOn(WebAssembly, 'instantiate').mockImplementation((async (module: WebAssembly.Module, imports: WebAssembly.Imports) => {
    const instance = await instantiate(module, imports);
    memories.push(instance.exports.memory as WebAssembly.Memory);
    return instance;
  }) as typeof WebAssembly.instantiate);
  vi.resetModules();
  const { verifyPlainProof } = await import('../src/verify-proof.js');
  // The module graph is new after resetModules, so the threshold is read from the copy verify-proof uses.
  const { retirement } = await import('../src/internal/verifier-retire.js');
  return { verifyPlainProof, memories, retirement };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('verifyPlainProof and the module\'s memory', () => {
  it('refuses dimensions past zk-pow\'s sanity bounds without growing the module\'s memory', async () => {
    const { verifyPlainProof, memories } = await watched();
    expect(await verifyPlainProof(job, proof)).toEqual(accepted);
    const before = memories[0]!.buffer.byteLength;
    const cases: [Parameters<typeof withDimensions>[1], string][] = [
      [{ k: 2n ** 26n }, 'k must be <= 2^16 || k=67108864'],
      [{ k: 2n ** 16n + 64n }, 'k must be <= 2^16 || k=65600'],
      [{ m: 2n ** 24n + 1n }, 'm must be <= 2^24 || m=16777217'],
      [{ n: 2n ** 32n }, 'n must be <= 2^24 || n=4294967296'],
      [{ rank: 2048n }, 'Rank must be 2^5..2^10 || r=2048'],
    ];
    for (const [dims, message] of cases) {
      expect(await verifyPlainProof(job, withDimensions(proof, dims))).toEqual({ valid: false, outcome: 'rejected', message: `rejected: ${message}` });
    }
    expect(memories).toHaveLength(1);
    expect(memories[0]!.buffer.byteLength).toBe(before);
  });

  it('lets an instance go once a share has grown it past the threshold, after the calls already holding it', async () => {
    const { verifyPlainProof, memories, retirement } = await watched();
    expect(retirement.bytes).toBe(256 * 1024 * 1024);
    expect(await verifyPlainProof(job, proof)).toEqual(accepted);
    // A share inside the bounds still grows the memory a little; lower the threshold under that growth.
    retirement.bytes = memories[0]!.buffer.byteLength + 1;
    const hostile = withDimensions(proof, { k: 2n ** 16n });
    const verdicts = await Promise.all([verifyPlainProof(job, hostile), verifyPlainProof(job, proof), verifyPlainProof(job, proof)]);
    expect(verdicts.map((v) => v.outcome)).toEqual(['rejected', 'accepted', 'accepted']);
    expect(memories[0]!.buffer.byteLength).toBeGreaterThan(retirement.bytes);
    expect(memories).toHaveLength(1);

    expect(await verifyPlainProof(job, proof)).toEqual(accepted);
    expect(memories).toHaveLength(2);
    expect(memories[1]!.buffer.byteLength).toBeLessThanOrEqual(retirement.bytes);
    expect(await verifyPlainProof(job, proof)).toEqual(accepted);
    expect(memories).toHaveLength(2);
  });
});
