// Plain proofs against Pearl's own verdicts: proofs mined by zk-pow's CPU
// miners and its two committed fixtures, as mined and after one change each
// and 1500 random edits, judged by verify_plain_proof_ffi and
// verify_plain_proof_v4_ffi from the fp8-scheme branch's Go bindings
// (vectors/mining/plain.json, from vectors/mining/plain/main.go). The FFI's
// buffer holds 127 bytes of the message; pearljs gives it in full.

import { afterEach, describe, expect, it, vi } from 'vitest';
import vectors from '../vectors/mining/plain.json';
import { fromHex } from '../src/internal/bytes.js';
import { verifyPlainProof } from '../src/verify-proof.js';
import type { ProofVerdict } from '../src/verify-proof.js';

interface Case {
  name?: string;
  base: string;
  certVersion: number;
  bits: number;
  header?: string;
  length?: number;
  edits?: [number, string][];
  code: number;
  message: string;
}

const bases = new Map(vectors.bases.map((b) => [b.name, { header: fromHex(b.header), proof: fromHex(b.proof) }]));

function load(c: Case): { header: Uint8Array; proof: Uint8Array } {
  const b = bases.get(c.base)!;
  let proof = Uint8Array.from(b.proof);
  if (c.length !== undefined) {
    proof = new Uint8Array(c.length);
    proof.set(b.proof.subarray(0, c.length));
  }
  for (const [at, hex] of c.edits ?? []) proof.set(fromHex(hex), at);
  return { header: c.header === undefined ? b.header : fromHex(c.header), proof };
}

function cut(message: string): string {
  const bytes = new TextEncoder().encode(message);
  let end = Math.min(bytes.length, 127);
  while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

const code = (verdict: ProofVerdict): number => ({ accepted: 0, rejected: 1, error: 2 })[verdict.outcome];

// WebAssembly's usize is 32 bits. bincode refuses a usize field or a length
// past 2^32 there while the 64-bit FFI decodes it and rejects the proof later,
// or fails on the bytes that follow: the same verdict, other words. No valid
// proof has such a field.
function decodedOnlyAt64Bits(ours: string, pearl: string): boolean {
  return ours.startsWith('deserialize: ') && (!pearl.startsWith('deserialize: ') || /expected usize|must fit in a usize/.test(ours));
}

// verifyPlainProof refuses m, n, k and noise_rank past zk-pow's sanity bounds
// before the module allocates by them, with the sanity check's words, where
// the FFI rejects the same proof at an earlier step. No accepted proof is past
// them.
function boundedBeforeModule(ours: string, pearl: string): boolean {
  return /^rejected: (Rank must be 2\^5\.\.2\^10|k must be <= 2\^16|m must be <= 2\^24|n must be <= 2\^24) \|\| /.test(ours) && /^(rejected|deserialize): /.test(pearl);
}

const cases = vectors.cases as Case[];

async function judge(c: Case): Promise<ProofVerdict> {
  const { header, proof } = load(c);
  return verifyPlainProof({ incompleteHeader: header, certVersion: c.certVersion }, proof, { bits: c.bits });
}

describe('verifyPlainProof', () => {
  it.each(cases.filter((c) => c.name !== undefined).map((c) => [c.name!, c] as const))('judges %s as Pearl does', async (_, c) => {
    const verdict = await judge(c);
    expect(code(verdict)).toBe(c.code);
    expect(verdict.valid).toBe(c.code === 0);
    if (!decodedOnlyAt64Bits(verdict.message, c.message) && !boundedBeforeModule(verdict.message, c.message)) expect(cut(verdict.message)).toBe(c.message);
  });

  it('gives Pearl\'s verdict for every proof with random edits, and its message unless bincode refuses a 64-bit size or a dimension is past its bound', async () => {
    const differ: string[] = [];
    let words = 0;
    let bounded = 0;
    for (const [i, c] of cases.entries()) {
      if (c.name !== undefined) continue;
      const verdict = await judge(c);
      if (code(verdict) === c.code && cut(verdict.message) === c.message) continue;
      if (code(verdict) === c.code && boundedBeforeModule(verdict.message, c.message)) bounded += 1;
      else if (code(verdict) === c.code && decodedOnlyAt64Bits(verdict.message, c.message)) words += 1;
      else differ.push(`${i} ${c.base}: ${code(verdict)} ${verdict.message} | Pearl: ${c.code} ${c.message}`);
    }
    expect(differ).toEqual([]);
    expect([words, bounded]).toEqual([24, 37]);
  }, 600_000);

  it('accepts a MiningJob from pearljs/gateway as the job', async () => {
    const base = vectors.bases.find((b) => b.name === 'V3 dense')!;
    const job = { incompleteHeader: fromHex(base.header), target: 0n, certVersion: 3, ancestorHeaders: [] };
    expect(await verifyPlainProof(job, fromHex(base.proof))).toEqual({ valid: true, outcome: 'accepted', message: 'accepted' });
  });

  it('rejects a proof longer than maxSize without reading it, 8 MiB unless given', async () => {
    const { header, proof } = bases.get('V3 dense')!;
    const job = { incompleteHeader: header, certVersion: 3 };
    expect(await verifyPlainProof(job, proof, { maxSize: proof.length - 1 })).toEqual({
      valid: false,
      outcome: 'rejected',
      message: `plain proof too large: ${proof.length} bytes (max ${proof.length - 1})`,
    });
    expect((await verifyPlainProof(job, proof, { maxSize: proof.length })).message).not.toContain('too large');
    const huge = new Uint8Array(8 * 1024 * 1024 + 1);
    expect((await verifyPlainProof(job, huge)).message).toBe(`plain proof too large: ${huge.length} bytes (max ${8 * 1024 * 1024})`);
    expect((await verifyPlainProof(job, huge, { maxSize: Infinity })).message).not.toContain('too large');
    await expect(verifyPlainProof(job, proof, { maxSize: -1 })).rejects.toBeInstanceOf(RangeError);
  });

  it('refuses a header that is not 76 bytes', async () => {
    await expect(verifyPlainProof({ incompleteHeader: new Uint8Array(108), certVersion: 3 }, new Uint8Array(1))).rejects.toThrow(RangeError);
  });
});

describe('verifyPlainProof over many proofs', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps the module\'s memory flat over 100 plain proofs of each format', async () => {
    const instantiate = WebAssembly.instantiate.bind(WebAssembly) as (module: WebAssembly.Module, imports: WebAssembly.Imports) => Promise<WebAssembly.Instance>;
    let memory: WebAssembly.Memory | undefined;
    vi.spyOn(WebAssembly, 'instantiate').mockImplementation((async (module: WebAssembly.Module, imports: WebAssembly.Imports) => {
      const instance = await instantiate(module, imports);
      memory = instance.exports.memory as WebAssembly.Memory;
      return instance;
    }) as typeof WebAssembly.instantiate);
    vi.resetModules();
    const { verifyPlainProof: verify } = await import('../src/verify-proof.js');
    const proofs = ['V2 dense', 'V3 dense', 'V4 H100', 'V4 B200'].map((name) => {
      const b = vectors.bases.find((x) => x.name === name)!;
      return { job: { incompleteHeader: fromHex(b.header), certVersion: b.certVersion }, proof: fromHex(b.proof) };
    });
    for (const p of proofs) expect((await verify(p.job, p.proof)).outcome).toBe('accepted');
    const before = memory!.buffer.byteLength;
    for (let i = 0; i < 100; i += 1) for (const p of proofs) expect((await verify(p.job, p.proof)).outcome).toBe('accepted');
    expect(memory!.buffer.byteLength).toBe(before);
  }, 300_000);
});
