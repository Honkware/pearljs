// What verifyProof does when a call into the module does not return: the
// verdict is `error`, the instance is dropped, and later calls, including one
// already waiting on the dropped instance, run on a fresh one. A file of its
// own, so the spy here does not reach the other tests.

import { afterEach, describe, expect, it, vi } from 'vitest';
import vectors from '../vectors/mining/proofs.json';
import type { PearlCertificate } from '../src/block.js';
import { certificateProofCommitment } from '../src/block.js';
import type { PearlBlockHeader } from '../src/blockheader.js';
import { blockHash, parseBlockHeader } from '../src/blockheader.js';
import { fromHex } from '../src/internal/bytes.js';
import { verifyProof } from '../src/verify-proof.js';

const v3 = vectors.cases.find((c) => c.name === 'V3 dense')!;
const proof = fromHex((vectors.proofs as Record<string, string>)[v3.certificate.proof.from]!);

function bound(publicData: Uint8Array): { header: PearlBlockHeader; certificate: PearlCertificate } {
  const certificate: PearlCertificate = { version: 3, hash: new Uint8Array(32), publicData, proof };
  const header = { ...parseBlockHeader(fromHex(v3.header)), proofCommitment: certificateProofCommitment(certificate) };
  certificate.hash = blockHash(header);
  return { header, certificate };
}

const valid = bound(fromHex(v3.certificate.publicData));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('verifyProof when the module fails', () => {
  it('still verifies a valid proof after 50 hostile certificates', async () => {
    // m = 2^21 - 1 with k = 2048 put m*k next to 2^32 and the jackpot at 0, so it passes the target.
    const publicData = fromHex(v3.certificate.publicData);
    new DataView(publicData.buffer).setUint32(148, 2 ** 21 - 1, true);
    publicData.fill(0, 116, 148);
    const hostile = bound(publicData);
    for (let i = 0; i < 50; i += 1) expect((await verifyProof(hostile.header, hostile.certificate)).valid).toBe(false);
    expect(await verifyProof(valid.header, valid.certificate)).toMatchObject({ valid: true, outcome: 'accepted' });
  }, 120_000);

  it('reports an exception from inside the module as an error and runs every waiting call on a fresh instance', async () => {
    const instantiate = WebAssembly.instantiate.bind(WebAssembly) as (module: WebAssembly.Module, imports: WebAssembly.Imports) => Promise<WebAssembly.Instance>;
    let instances = 0;
    vi.spyOn(WebAssembly, 'instantiate').mockImplementation((async (module: WebAssembly.Module, imports: WebAssembly.Imports) => {
      const instance = await instantiate(module, imports);
      instances += 1;
      if (instances > 1) return instance;
      const exports: Record<string, unknown> = { ...instance.exports };
      exports.verify_v2 = () => {
        throw new RangeError('Maximum call stack size exceeded');
      };
      return { exports };
    }) as typeof WebAssembly.instantiate);
    vi.resetModules();
    const { verifyProof } = await import('../src/verify-proof.js');
    // Whichever of the two reaches the module first gets the exception.
    const verdicts = await Promise.all([verifyProof(valid.header, valid.certificate), verifyProof(valid.header, valid.certificate)]);
    verdicts.sort((a, b) => Number(a.valid) - Number(b.valid));
    expect(verdicts[0]).toEqual({ valid: false, outcome: 'error', message: 'Internal error: RangeError: Maximum call stack size exceeded' });
    expect(verdicts[1]).toMatchObject({ valid: true, outcome: 'accepted' });
    expect(await verifyProof(valid.header, valid.certificate)).toMatchObject({ valid: true, outcome: 'accepted' });
    expect(instances).toBe(2);
  });
});
