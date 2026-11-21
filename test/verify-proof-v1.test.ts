// V1 proofs against pearld's own verdicts: four mainnet V1 blocks
// (test/mainnet-blocks/fixtures) as mined, after one tampering each and with their
// public data changed at random and at the sizes where a 32-bit usize would
// wrap, judged by zkpow.VerifyCertificate, which sends a V1 certificate to
// verify_zk_proof_v1 (vectors/mining/proofs-v1.json, from
// vectors/mining/proofs/v1/main.go). pearld truncates the verifier's message
// to 127 bytes and prefixes it; pearljs gives it in full.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import vectors from '../vectors/mining/proofs-v1.json';
import proofs from '../vectors/mining/proofs.json';
import type { CertificateVersion, PearlCertificate } from '../src/block.js';
import { certificateProofCommitment, parseBlock } from '../src/block.js';
import type { PearlBlockHeader } from '../src/blockheader.js';
import { blockHash, parseBlockHeader } from '../src/blockheader.js';
import { fromHex } from '../src/internal/bytes.js';
import { verifyProof } from '../src/verify-proof.js';
import type { ProofVerdict } from '../src/verify-proof.js';

interface Case {
  name?: string;
  base: string;
  version: number;
  edits: [number, string][];
  proof?: { flip?: number; length?: number };
  header?: string;
  hash?: string;
  error: string | null;
}

interface Base {
  header: PearlBlockHeader;
  publicData: Uint8Array;
  proof: Uint8Array;
}

const bases = new Map<string, Base>();
for (const height of ['200', '24000', '71740', '71934']) {
  const block = parseBlock(fromHex(readFileSync(new URL(`../test/mainnet-blocks/fixtures/block-${height}.hex`, import.meta.url), 'utf8').trim()));
  bases.set(height, { header: block.header, publicData: block.certificate!.publicData, proof: block.certificate!.proof });
}
for (const name of ['V2 dense', 'V3 dense']) {
  const c = proofs.cases.find((x) => x.name === name)!;
  bases.set(name, { header: parseBlockHeader(fromHex(c.header)), publicData: fromHex(c.certificate.publicData), proof: fromHex((proofs.proofs as Record<string, string>)[name]!) });
}

function load(c: Case): { header: PearlBlockHeader; certificate: PearlCertificate } {
  const b = bases.get(c.base)!;
  const publicData = Uint8Array.from(b.publicData);
  for (const [at, hex] of c.edits) publicData.set(fromHex(hex), at);
  let proof = Uint8Array.from(b.proof);
  if (c.proof?.flip !== undefined) proof[c.proof.flip]! ^= 1;
  if (c.proof?.length !== undefined) {
    proof = new Uint8Array(c.proof.length);
    proof.set(b.proof.subarray(0, c.proof.length));
  }
  const certificate: PearlCertificate = { version: c.version as CertificateVersion, hash: new Uint8Array(32), publicData, proof };
  if (c.header !== undefined) {
    certificate.hash = fromHex(c.hash!);
    return { header: parseBlockHeader(fromHex(c.header)), certificate };
  }
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

function asPearld(verdict: ProofVerdict, version: number, fromVerifier: boolean): string | null {
  if (verdict.valid) return null;
  if (!fromVerifier) return verdict.message;
  const prefix = version === 1 ? 'v1 ' : '';
  return `${prefix}${verdict.outcome === 'error' ? 'verification system error' : 'proof rejected'}: ${cut(verdict.message)}`;
}

const cases = vectors.cases as Case[];

describe('verifyProof on V1 certificates', () => {
  it.each(cases.filter((c) => c.name !== undefined).map((c) => [c.name!, c] as const))('judges %s as pearld does', async (_, c) => {
    const { header, certificate } = load(c);
    const verdict = await verifyProof(header, certificate);
    expect(verdict.valid).toBe(c.error === null);
    const fromVerifier = c.error !== null && /^(v1 )?(proof rejected|verification system error): /.test(c.error) && !c.error.includes('legacy proof data too large');
    expect(asPearld(verdict, certificate.version, fromVerifier)).toBe(c.error);
  });

  it('gives pearld\'s verdict and message for every certificate with changed public data', async () => {
    const differ: string[] = [];
    for (const [i, c] of cases.entries()) {
      if (c.name !== undefined) continue;
      const { header, certificate } = load(c);
      const verdict = await verifyProof(header, certificate);
      const fromVerifier = c.error !== null && /^v1 (proof rejected|verification system error): /.test(c.error);
      const ours = asPearld(verdict, 1, fromVerifier);
      if (ours !== c.error) differ.push(`${i} ${c.base}: ${ours} | pearld: ${c.error}`);
    }
    expect(differ).toEqual([]);
  }, 600_000);

  it('gives a V1 certificate judged at share bits VerifyZKProofFFI\'s answer, which has no V1 path', async () => {
    const { header, certificate } = load(cases[0]!);
    expect(await verifyProof(header, certificate, { bits: header.bits })).toEqual({ valid: false, outcome: 'rejected', message: 'unsupported certificate version 1 for FFI verification' });
  });

  it('refuses V1 public data of another length with verify_zk_proof_v1\'s message', async () => {
    const { header: base, certificate } = load(cases[0]!);
    certificate.publicData = certificate.publicData.subarray(0, 163);
    const header = { ...base, proofCommitment: certificateProofCommitment(certificate) };
    certificate.hash = blockHash(header);
    expect(await verifyProof(header, certificate)).toEqual({ valid: false, outcome: 'rejected', message: 'v1 proof requires 164 byte public_data, got 163' });
  });
});
