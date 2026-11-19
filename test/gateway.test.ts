// The miner-to-gateway protocol against lines pearl-gateway's own code wrote
// (vectors/mining/gateway.json from master, gateway-fp8.json from the
// fp8-scheme branch): requests from the miners' JSONRPCClient, replies from
// MinerRpcServer's handler, and the gateway's bits_to_target.

import { describe, expect, it } from 'vitest';
import {
  ancestorChain,
  decodeGatewayRequest,
  decodeGatewayResponse,
  encodeGatewayRequest,
  encodeGatewayResponse,
  gatewayTarget,
  GATEWAY_ERROR_CODES,
  miningJob,
} from '../src/index.js';
import type { BlockSkeleton, GatewayRequest } from '../src/index.js';
import master from '../vectors/mining/gateway.json' with { type: 'json' };
import fp8 from '../vectors/mining/gateway-fp8.json' with { type: 'json' };
import { hexToBytes } from './vector-helpers.js';

// The method a reply answers; a line that is not JSON was answered as no method, which reads the same.
const methodOf = (request: string): GatewayRequest['method'] =>
  request.includes('"method": "submitPlainProof"') ? 'submitPlainProof' : 'getMiningInfo';

describe.each([['master', master], ['fp8-scheme', fp8]])('pearl-gateway %s', (_name, vectors) => {
  it('writes a miner\'s requests byte for byte as its JSONRPCClient does', () => {
    const fromClient = vectors.frames.filter((frame) => /^(getMiningInfo|submitPlainProof) \d$/.test(frame.name));
    expect(fromClient.length).toBeGreaterThanOrEqual(6);
    for (const frame of fromClient) {
      const request = decodeGatewayRequest(frame.request);
      expect(encodeGatewayRequest(request), frame.name).toBe(frame.request);
    }
  });

  it('reads every reply and writes it back byte for byte as the gateway does', () => {
    for (const frame of vectors.frames) {
      const response = decodeGatewayResponse(frame.response, methodOf(frame.request));
      expect(encodeGatewayResponse(response), frame.name).toBe(frame.response);
    }
  });

  it('reads the jobs the gateway hands out, targets as exact integers', () => {
    const replies = vectors.frames.filter((frame) => /^getMiningInfo \d$/.test(frame.name)).map((frame) => decodeGatewayResponse(frame.response, 'getMiningInfo'));
    for (const [i, reply] of replies.entries()) {
      if (!('result' in reply) || reply.result === 'submitted') throw new Error('expected a job');
      expect(reply.result.incompleteHeader).toHaveLength(76);
      expect(Buffer.from(reply.result.incompleteHeader).toString('base64')).toBe(vectors.jobs[i]!.incomplete_header_bytes);
      expect(reply.result.certVersion).toBe(vectors.jobs[i]!.cert_version);
    }
    const first = replies[0]!;
    expect('result' in first && first.result !== 'submitted' && first.result.target).toBe(0x7fffffn << 232n);
  });

  it('decodes the gateway\'s refusals with their codes', () => {
    const errors = Object.fromEntries(vectors.frames.map((frame) => [frame.name, decodeGatewayResponse(frame.response, methodOf(frame.request))]));
    const code = (name: string): number | undefined => {
      const reply = errors[name]!;
      return 'error' in reply ? reply.error.code : undefined;
    };
    expect(code('mining paused')).toBe(GATEWAY_ERROR_CODES.MINING_PAUSED);
    expect(code('unknown method')).toBe(GATEWAY_ERROR_CODES.METHOD_NOT_FOUND);
    expect(code('params on getMiningInfo')).toBe(GATEWAY_ERROR_CODES.INVALID_PARAMS);
    expect(code('missing jsonrpc')).toBe(GATEWAY_ERROR_CODES.INVALID_REQUEST);
    expect(code('not json')).toBe(GATEWAY_ERROR_CODES.PARSE_ERROR);
    expect(code('proof not base64')).toBe(GATEWAY_ERROR_CODES.INVALID_PARAMS);
  });

  it('refuses the requests the gateway refuses', () => {
    for (const name of ['params on getMiningInfo', 'missing jsonrpc', 'not json', 'proof not base64', 'job without header', 'unknown method']) {
      const frame = vectors.frames.find((f) => f.name === name)!;
      expect(() => decodeGatewayRequest(frame.request), name).toThrow(expect.objectContaining({ code: 'GATEWAY_MESSAGE_INVALID' }));
    }
  });

  it('computes the target the gateway puts in a job', () => {
    for (const vector of vectors.targets) expect(gatewayTarget(vector.bits).toString()).toBe(vector.target);
  });
});

describe('V4 jobs', () => {
  const job = decodeGatewayResponse(fp8.frames.find((f) => f.name === 'getMiningInfo 3')!.response, 'getMiningInfo');

  it('keeps the master gateway\'s jobs without ancestor headers and the fp8 gateway\'s with them', () => {
    const old = decodeGatewayResponse(master.frames[0]!.response, 'getMiningInfo');
    expect('result' in old && old.result !== 'submitted' && old.result.ancestorHeaders).toBeUndefined();
    expect('result' in job && job.result !== 'submitted' && job.result.ancestorHeaders?.length).toBe(4);
  });

  it('gives the headers a certificate carries for each ancestor in the window', () => {
    if (!('result' in job) || job.result === 'submitted') throw new Error('expected a job');
    const headers = job.result.ancestorHeaders!;
    expect(ancestorChain(job.result, headers[0]!)).toEqual([]);
    expect(ancestorChain(job.result, headers[3]!)).toEqual(headers.slice(0, 3));
    expect(ancestorChain(job.result, new Uint8Array(108))).toBeNull();
  });

  it('makes a job from a skeleton as the fp8 gateway does from a template', () => {
    const header = { version: 0x20000000, prevBlock: hexToBytes('11'.repeat(32)), merkleRoot: hexToBytes('22'.repeat(32)), timestamp: 1, bits: 0x1d00ffff, proofCommitment: new Uint8Array(32) };
    const skeleton = { height: 9, certVersion: 3, header, transactions: [], witnessCommitment: new Uint8Array(32), ancestorHeaders: [] } as BlockSkeleton;
    const made = miningJob(skeleton);
    expect(made.target).toBe(BigInt(master.targets[0]!.target));
    expect(made.incompleteHeader).toHaveLength(76);
    expect(encodeGatewayResponse({ id: 1, result: made })).toContain('"ancestor_headers": []');
  });
});
