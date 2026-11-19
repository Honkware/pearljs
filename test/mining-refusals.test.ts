// checkJackpot, checkBlockWork and checkCertificateBinding on certificates
// edited from the ones in vectors/mining/proofs.json. Each expected message
// is the one pearld gives for the same certificate (zkpow.VerifyZKProofFFI
// for V2 to V4, zkpow.VerifyCertificate for V1, on Pearl's fp8-scheme
// branch), without its "proof rejected: " prefix.

import { describe, expect, it } from 'vitest';
import vectors from '../vectors/mining/proofs.json';
import type { CertificateVersion, PearlCertificate } from '../src/block.js';
import { certificateProofCommitment } from '../src/block.js';
import type { PearlBlockHeader } from '../src/blockheader.js';
import { blockHash, parseBlockHeader } from '../src/blockheader.js';
import { fromHex } from '../src/internal/bytes.js';
import { checkBlockWork, checkJackpot } from '../src/mining.js';
import { networks } from '../src/networks.js';

function base(name: string): { header: PearlBlockHeader; publicData: Uint8Array; proof: Uint8Array; ancestors: PearlBlockHeader[] } {
  const c = vectors.cases.find((x) => x.name === name)!;
  return {
    header: parseBlockHeader(fromHex(c.header)),
    publicData: fromHex(c.certificate.publicData),
    proof: fromHex((vectors.proofs as Record<string, string>)[c.certificate.proof.from]!),
    ancestors: ((c.certificate as { ancestorHeaders?: string[] }).ancestorHeaders ?? []).map((h) => parseBlockHeader(fromHex(h))),
  };
}

function edited(name: string, version: CertificateVersion, edit: (pd: Uint8Array, view: DataView) => Uint8Array | void, bits?: number): { header: PearlBlockHeader; certificate: PearlCertificate } {
  const b = base(name);
  const copy = Uint8Array.from(b.publicData);
  const publicData = edit(copy, new DataView(copy.buffer)) ?? copy;
  const certificate: PearlCertificate = { version, hash: new Uint8Array(32), publicData, proof: b.proof };
  if (version === 4) certificate.ancestorHeaders = b.ancestors;
  const header = { ...b.header, bits: bits ?? b.header.bits, proofCommitment: certificateProofCommitment(certificate) };
  certificate.hash = blockHash(header);
  return { header, certificate };
}

describe('checkJackpot on statements that do no work', () => {
  // The V4 statement's offsets: k at 108, B's tile size at 121, A's at 164.
  it.each([
    ['A tile size', 164, 'h must be >= 4 || h=0'],
    ['B tile size', 121, 'w must be >= 16 || w=0'],
    ['k', 108, 'k must be >= 1024 || k=0'],
  ])('refuses a V4 statement whose %s is 0 with Pearl\'s bound', (_, at, message) => {
    const { header, certificate } = edited('V4 H100', 4, (_pd, view) => view.setUint32(at, 0, true));
    expect(() => checkJackpot(certificate, header.bits)).toThrow(expect.objectContaining({ code: 'CERTIFICATE_MALFORMED', message }));
  });
});

describe('checkJackpot and checkBlockWork on V1', () => {
  // V3 dense public data is a valid V1 layout: its experts and top_k are 0, so its last 32 config bytes are.
  it('passes a V1 jackpot within its bound', () => {
    const { header, certificate } = edited('V3 dense', 1, (pd) => pd.fill(0, 116, 148), 0x1d00ffff);
    expect(() => checkJackpot(certificate, header.bits)).not.toThrow();
    expect(() => checkBlockWork({ header, certificate, transactions: [] }, networks.mainnet, 1000)).not.toThrow();
  });

  it('refuses a V1 jackpot over its bound', () => {
    const { header, certificate } = edited('V3 dense', 1, (pd) => pd.fill(0xff, 116, 148), 0x1d00ffff);
    expect(() => checkBlockWork({ header, certificate, transactions: [] }, networks.mainnet, 1000)).toThrow(
      expect.objectContaining({ code: 'JACKPOT_ABOVE_TARGET', message: 'Jackpot condition not satisfied: hash does not meet difficulty target' }),
    );
  });

  it('refuses V1 public data whose reserved bytes are not zero, the experts field included', () => {
    for (const at of [20, 40]) {
      const { header, certificate } = edited('V3 dense', 1, (pd) => {
        pd[at] = 4;
      });
      expect(() => checkJackpot(certificate, header.bits)).toThrow(expect.objectContaining({ code: 'CERTIFICATE_MALFORMED', message: 'Reserved field must be all zeros' }));
    }
  });

  it('refuses V1 public data that is not 164 bytes', () => {
    const { header, certificate } = edited('V3 dense', 1, (pd) => pd.slice(0, 100));
    expect(() => checkJackpot(certificate, header.bits)).toThrow(expect.objectContaining({ code: 'CERTIFICATE_MALFORMED', message: 'v1 proof requires 164 byte public_data, got 100' }));
  });
});
