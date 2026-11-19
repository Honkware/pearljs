// verifyProof and checkJackpot against pearld on 2334 certificates whose
// public data was changed at random and at the matrix sizes where a 32-bit
// usize would wrap (vectors/mining/proofs-differential.json, judged by
// zkpow.VerifyZKProofFFI; vectors/mining/proofs/differential/main.go writes
// it). The verifier must give pearld's verdict and message for every one,
// and checkJackpot must refuse only what pearld refuses, in its words.

import { describe, expect, it } from 'vitest';
import vectors from '../vectors/mining/proofs.json';
import differential from '../vectors/mining/proofs-differential.json';
import type { CertificateVersion, PearlCertificate } from '../src/block.js';
import { certificateProofCommitment } from '../src/block.js';
import { blockHash, parseBlockHeader } from '../src/blockheader.js';
import type { PearlBlockHeader } from '../src/blockheader.js';
import { fromHex } from '../src/internal/bytes.js';
import { checkJackpot } from '../src/mining.js';
import { verifyProof } from '../src/verify-proof.js';
import type { ProofVerdict } from '../src/verify-proof.js';

interface Case {
  base: string;
  version: number;
  bits: number | null;
  length: number;
  edits: [number, string][];
  error: string | null;
}

const bases = new Map(
  vectors.cases
    .filter((c) => c.name in vectors.proofs)
    .map((c) => [c.name, {
      header: parseBlockHeader(fromHex(c.header)),
      publicData: fromHex(c.certificate.publicData),
      proof: fromHex((vectors.proofs as Record<string, string>)[c.name]!),
      ancestors: ((c.certificate as { ancestorHeaders?: string[] }).ancestorHeaders ?? []).map((h) => parseBlockHeader(fromHex(h))),
    }] as const),
);

function load(c: Case): { header: PearlBlockHeader; certificate: PearlCertificate } {
  const b = bases.get(c.base)!;
  const publicData = new Uint8Array(c.length);
  publicData.set(b.publicData.subarray(0, c.length));
  for (const [at, hex] of c.edits) publicData.set(fromHex(hex), at);
  const certificate: PearlCertificate = { version: c.version as CertificateVersion, hash: new Uint8Array(32), publicData, proof: b.proof };
  if (c.version === 4) certificate.ancestorHeaders = b.ancestors;
  const header = { ...b.header, proofCommitment: certificateProofCommitment(certificate) };
  certificate.hash = blockHash(header);
  return { header, certificate };
}

// pearld's C buffer holds 127 bytes of the verifier's message.
function cut(message: string): string {
  const bytes = new TextEncoder().encode(message);
  let end = Math.min(bytes.length, 127);
  while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

const prefix = (version: number): string => (version === 4 ? 'v4 ' : '');

function asPearld(verdict: ProofVerdict, version: number, fromVerifier: boolean): string | null {
  if (verdict.valid) return null;
  if (!fromVerifier) return verdict.message;
  return `${prefix(version)}${verdict.outcome === 'error' ? 'verification system error' : 'proof rejected'}: ${cut(verdict.message)}`;
}

const cases = differential.cases as Case[];

describe('the verifier and pearld on changed certificates', () => {
  it('gives pearld\'s verdict and message for every one', async () => {
    const differ: string[] = [];
    for (const [i, c] of cases.entries()) {
      const { header, certificate } = load(c);
      const verdict = await verifyProof(header, certificate, c.bits === null ? {} : { bits: c.bits });
      const fromVerifier = c.error !== null && /^(v4 )?(proof rejected|verification system error): /.test(c.error);
      const ours = asPearld(verdict, c.version, fromVerifier);
      if (ours !== c.error) differ.push(`${i} ${c.base} V${c.version}: ${ours} | pearld: ${c.error}`);
    }
    expect(differ).toEqual([]);
  }, 600_000);

  it('has checkJackpot refuse only what pearld refuses, with its message', () => {
    const differ: string[] = [];
    for (const [i, c] of cases.entries()) {
      const { header, certificate } = load(c);
      try {
        checkJackpot(certificate, c.bits ?? header.bits);
      } catch (error) {
        const message = (error as Error).message;
        const expected = message === 'empty public data' ? message : `${prefix(c.version)}proof rejected: ${cut(message)}`;
        if (expected !== c.error) differ.push(`${i} ${c.base} V${c.version}: ${message} | pearld: ${c.error}`);
      }
    }
    expect(differ).toEqual([]);
  });
});
