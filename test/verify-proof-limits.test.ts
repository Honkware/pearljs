// The checks verifyProof makes before it copies a certificate into the
// module: what the module would refuse first is refused without touching its
// memory, which never shrinks. The messages are the module's, the same as
// zkpow.VerifyZKProofFFI gives for each of these certificates on Pearl's
// fp8-scheme branch. A file of its own, so the spy here does not reach the
// other tests.

import { afterEach, describe, expect, it, vi } from 'vitest';
import vectors from '../vectors/mining/proofs.json';
import type { CertificateVersion, PearlCertificate } from '../src/block.js';
import { certificateProofCommitment } from '../src/block.js';
import type { PearlBlockHeader } from '../src/blockheader.js';
import { blockHash, parseBlockHeader } from '../src/blockheader.js';
import { fromHex } from '../src/internal/bytes.js';

function base(name: string): { header: PearlBlockHeader; publicData: Uint8Array; proof: Uint8Array } {
  const c = vectors.cases.find((x) => x.name === name)!;
  return { header: parseBlockHeader(fromHex(c.header)), publicData: fromHex(c.certificate.publicData), proof: fromHex((vectors.proofs as Record<string, string>)[c.certificate.proof.from]!) };
}

function bound(name: string, version: CertificateVersion, edit: { publicData?: Uint8Array; proof?: Uint8Array; ancestors?: number }): { header: PearlBlockHeader; certificate: PearlCertificate } {
  const b = base(name);
  const certificate: PearlCertificate = { version, hash: new Uint8Array(32), publicData: edit.publicData ?? b.publicData, proof: edit.proof ?? b.proof };
  if (version === 4) certificate.ancestorHeaders = Array.from({ length: edit.ancestors ?? 0 }, () => b.header);
  const header = { ...b.header, proofCommitment: certificateProofCommitment(certificate) };
  certificate.hash = blockHash(header);
  return { header, certificate };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('verifyProof before the module', () => {
  it.each([
    ['V4 with four ancestor headers', bound('V4 H100', 4, { ancestors: 4, proof: new Uint8Array(62001) }), 'invalid v4 headers length 540'],
    ['V4 proof of 62001 bytes', bound('V4 H100', 4, { proof: new Uint8Array(62001), publicData: new Uint8Array(239) }), 'FP8 proof too large'],
    ['V4 public data of 239 bytes', bound('V4 H100', 4, { publicData: new Uint8Array(239) }), 'invalid public_data_len 239'],
    ['V4 public data of 833 bytes', bound('V4 H100', 4, { publicData: new Uint8Array(833) }), 'invalid public_data_len 833'],
    ['V3 proof of 62001 bytes', bound('V3 dense', 3, { proof: new Uint8Array(62001), publicData: new Uint8Array(163) }), 'ZK Proof too large'],
    ['V3 public data of 163 bytes', bound('V3 dense', 3, { publicData: new Uint8Array(163) }), 'invalid public_data_len 163'],
    ['V2 public data of 198 bytes', bound('V3 dense', 2, { publicData: new Uint8Array(198) }), 'invalid public_data_len 198'],
    ['V2 public data of 4808 bytes', bound('V3 dense', 2, { publicData: new Uint8Array(4808) }), 'invalid public_data_len 4808'],
  ])('refuses a %s as the module does', async (_, { header, certificate }, message) => {
    const { verifyProof } = await import('../src/verify-proof.js');
    expect(await verifyProof(header, certificate)).toEqual({ valid: false, outcome: 'rejected', message });
  });

  it('refuses a 64 MiB proof without growing the module\'s memory', async () => {
    const instantiate = WebAssembly.instantiate.bind(WebAssembly) as (module: WebAssembly.Module, imports: WebAssembly.Imports) => Promise<WebAssembly.Instance>;
    let memory: WebAssembly.Memory | undefined;
    vi.spyOn(WebAssembly, 'instantiate').mockImplementation((async (module: WebAssembly.Module, imports: WebAssembly.Imports) => {
      const instance = await instantiate(module, imports);
      memory = instance.exports.memory as WebAssembly.Memory;
      return instance;
    }) as typeof WebAssembly.instantiate);
    vi.resetModules();
    const { verifyProof } = await import('../src/verify-proof.js');
    const valid = bound('V4 H100', 4, {});
    expect((await verifyProof(valid.header, valid.certificate)).valid).toBe(true);
    const before = memory!.buffer.byteLength;
    const big = bound('V4 H100', 4, { proof: new Uint8Array(64 << 20) });
    expect(await verifyProof(big.header, big.certificate)).toEqual({ valid: false, outcome: 'rejected', message: 'FP8 proof too large' });
    expect(memory!.buffer.byteLength).toBe(before);
  });
});
