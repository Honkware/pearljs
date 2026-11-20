// Proof verification against pearld's own verdicts: certificates mined by
// zk-pow's CPU miners, as found and after one tampering each, judged by
// zkpow.VerifyZKProofFFI on Pearl's fp8-scheme branch
// (vectors/mining/proofs.json, from vectors/mining/proofs/main.go). pearld
// truncates the verifier's message to 127 bytes and prefixes it; pearljs
// gives it in full.

import { describe, expect, it } from 'vitest';
import vectors from '../vectors/mining/proofs.json';
import type { CertificateVersion, PearlCertificate } from '../src/block.js';
import { parseBlockHeader } from '../src/blockheader.js';
import type { PearlBlockHeader } from '../src/blockheader.js';
import { fromHex } from '../src/internal/bytes.js';
import { verifyBlockProof, verifyProof } from '../src/verify-proof.js';
import type { ProofVerdict } from '../src/verify-proof.js';

interface Case {
  name: string;
  header: string;
  certificate: {
    version: number;
    hash: string;
    publicData: string;
    proof: { from: string; flip?: number; length?: number };
    ancestorHeaders?: string[];
  };
  bits: number | null;
  error: string | null;
}

const cases = vectors.cases as Case[];
const proofs = vectors.proofs as Record<string, string>;

function load(c: Case): { header: PearlBlockHeader; certificate: PearlCertificate } {
  const { version, hash, publicData, proof, ancestorHeaders } = c.certificate;
  let bytes = fromHex(proofs[proof.from]!);
  if (proof.flip !== undefined) bytes[proof.flip]! ^= 1;
  if (proof.length !== undefined) bytes = bytes.subarray(0, proof.length);
  const certificate: PearlCertificate = { version: version as CertificateVersion, hash: fromHex(hash), publicData: fromHex(publicData), proof: bytes };
  if (ancestorHeaders) certificate.ancestorHeaders = ancestorHeaders.map((h) => parseBlockHeader(fromHex(h)));
  return { header: parseBlockHeader(fromHex(c.header)), certificate };
}

// How pearld words a verdict. Its own checks before the verifier return their
// message as is; the verifier's message is prefixed, and cut to the 127 bytes
// its C buffer holds, at a character boundary.
function asPearld(verdict: ProofVerdict, version: number, fromVerifier: boolean): string | null {
  if (verdict.valid) return null;
  if (!fromVerifier) return verdict.message;
  const bytes = new TextEncoder().encode(verdict.message);
  let end = Math.min(bytes.length, 127);
  while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  const text = new TextDecoder().decode(bytes.subarray(0, end));
  const v4 = version === 4 ? 'v4 ' : '';
  return verdict.outcome === 'error' ? `${v4}verification system error: ${text}` : `${v4}proof rejected: ${text}`;
}

describe('verifyProof', () => {
  it.each(cases.map((c) => [c.name, c] as const))('judges %s as pearld does', async (_, c) => {
    const { header, certificate } = load(c);
    const verdict = await verifyProof(header, certificate, c.bits === null ? {} : { bits: c.bits });
    expect(verdict.valid).toBe(c.error === null);
    const fromVerifier = c.error !== null && /^(v4 )?(proof rejected|verification system error): /.test(c.error);
    expect(asPearld(verdict, certificate.version, fromVerifier)).toBe(c.error);
  });
});

describe('verifyProof outside the verifier', () => {
  const v3 = load(cases.find((c) => c.name === 'V3 dense')!);

  it('rejects a block without a certificate', async () => {
    expect(await verifyBlockProof({ header: v3.header, certificate: null, transactions: [] })).toEqual({ valid: false, outcome: 'rejected', message: 'block has no certificate' });
  });

  it('verifies a block\'s own certificate against its own header', async () => {
    expect((await verifyBlockProof({ header: v3.header, certificate: v3.certificate, transactions: [] })).valid).toBe(true);
  });

  it('refuses bits that are not a uint32', async () => {
    await expect(verifyProof(v3.header, v3.certificate, { bits: 2 ** 32 })).rejects.toThrow(RangeError);
  });
});
