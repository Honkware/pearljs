// pearljs/gateway against Pearl's own pearl-gateway, running on the suite's
// regtest pearld: pearljs plays the miner on the gateway's socket. The job it
// is handed is the one pearljs builds from pearld's template, a plain proof
// mined for it by pearl_mining passes verifyPlainProof as a share, and the
// gateway turns that proof into a block pearld accepts, whose ZK proof
// pearljs then verifies.
//
// PEARL_GATEWAY names the pearl-gateway executable of a Python environment
// that holds Pearl's pearl-gateway and py-pearl-mining packages, from the
// branch the suite's pearld was built from. V4 jobs, which the fp8-scheme
// branch hands out, are mined by the binary PEARL_GATEWAY_MINER_V4 names,
// built from gateway-mine-v4.rs.

import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { openSync, writeFileSync } from 'node:fs';
import { type Socket, connect } from 'node:net';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blockSkeleton, checkBlockWork, parseBlock, serializeBlockHeader } from '../../src/index.js';
import { GATEWAY_ERROR_CODES, decodeGatewayResponse, encodeGatewayRequest, gatewayTarget, miningJob } from '../../src/gateway.js';
import type { GatewayRequest, GatewayResponse, MiningJob } from '../../src/gateway.js';
import { verifyBlockProof, verifyPlainProof } from '../../src/verify-proof.js';
import { live, miner, network, pearld } from './chain.js';

const exe = process.env.PEARL_GATEWAY;
const minerV4 = process.env.PEARL_GATEWAY_MINER_V4;
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const run = promisify(execFile);
const payTo = miner.deriveAddress(9);

let gateway: ChildProcess | undefined;
let socket: Socket | undefined;
let replies: AsyncIterator<string> | undefined;
let nextId = 1;

type Unnumbered<R> = R extends unknown ? Omit<R, 'id'> : never;
async function ask(request: Unnumbered<GatewayRequest>): Promise<GatewayResponse> {
  socket!.write(encodeGatewayRequest({ id: nextId++, ...request }));
  const line = await replies!.next();
  if (line.done === true) throw new Error('the gateway closed the connection');
  return decodeGatewayResponse(`${line.value}\n`, request.method);
}

async function job(): Promise<MiningJob> {
  for (;;) {
    const reply = await ask({ method: 'getMiningInfo' });
    if ('result' in reply && typeof reply.result !== 'string') return reply.result;
    // The gateway has no template until its first poll of pearld returns.
    if (!('error' in reply) || reply.error.code !== GATEWAY_ERROR_CODES.MINING_PAUSED) throw new Error(JSON.stringify(reply));
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

describe.skipIf(live === null || exe === undefined || (live.fp8 && minerV4 === undefined))('gateway', () => {
  beforeAll(async () => {
    const dir = live!.dir;
    const path = join(dir, 'gateway.sock');
    const cert = join(dir, 'gateway-pearld.cert');
    writeFileSync(cert, live!.pearld.ca);
    const log = openSync(join(dir, 'gateway.log'), 'a');
    gateway = spawn(exe!, ['start'], {
      env: {
        ...process.env,
        PEARLD_RPC_URL: live!.pearld.url,
        PEARLD_RPC_USER: live!.pearld.username,
        PEARLD_RPC_PASSWORD: live!.pearld.password,
        PEARLD_MINING_ADDRESS: payTo,
        MINER_RPC_TRANSPORT: 'uds',
        MINER_RPC_SOCKET_PATH: path,
        // The gateway's HTTP client trusts the system's roots; pearld's certificate is its own.
        SSL_CERT_FILE: cert,
      },
      stdio: ['ignore', log, log],
    });
    for (let tries = 0; socket === undefined; tries++) {
      if (gateway.exitCode !== null) throw new Error(`pearl-gateway exited with ${gateway.exitCode}; see ${join(dir, 'gateway.log')}`);
      const attempt = connect(path);
      const connected = await new Promise<boolean>((resolve) => attempt.once('connect', () => resolve(true)).once('error', () => resolve(false)));
      if (connected) socket = attempt;
      else if (tries > 240) throw new Error('pearl-gateway never opened its socket');
      else await new Promise((resolve) => setTimeout(resolve, 500));
    }
    replies = createInterface({ input: socket })[Symbol.asyncIterator]();
  });

  afterAll(() => {
    socket?.destroy();
    gateway?.kill('SIGINT');
  });

  it('is handed the job pearljs builds from the same template', async () => {
    const handed = await job();
    const template = await pearld.getBlockTemplate({ capabilities: ['coinbasevalue'] });
    const built = miningJob(blockSkeleton(template, { network, payTo }));
    expect(handed.certVersion).toBe(built.certVersion);
    expect(handed.target).toBe(built.target);
    expect(handed.target).toBe(gatewayTarget(Number.parseInt(template.bits, 16)));
    // Version, previous block and merkle root; the two templates may differ in time.
    expect(hex(handed.incompleteHeader.subarray(0, 68))).toBe(hex(built.incompleteHeader.subarray(0, 68)));
    expect(hex(handed.incompleteHeader.subarray(72))).toBe(hex(built.incompleteHeader.subarray(72)));
    // A gateway from master sends no ancestor list.
    if (live!.fp8) {
      expect(handed.ancestorHeaders!.map(hex)).toEqual(built.ancestorHeaders!.map(hex));
      expect(handed.ancestorHeaders!.length).toBeGreaterThan(0);
    } else expect(handed.ancestorHeaders).toBeUndefined();
  });

  it('answers an unknown method and a malformed job as pearljs reads them', async () => {
    socket!.write('{"jsonrpc": "2.0", "method": "getWork", "id": 77, "params": {}}\n');
    const unknown = decodeGatewayResponse(`${(await replies!.next()).value}\n`, 'getMiningInfo');
    expect(unknown).toMatchObject({ id: 77, error: { code: GATEWAY_ERROR_CODES.METHOD_NOT_FOUND } });
    socket!.write('{"jsonrpc": "2.0", "method": "submitPlainProof", "id": 78, "params": {"plain_proof": "!"}}\n');
    const invalid = decodeGatewayResponse(`${(await replies!.next()).value}\n`, 'submitPlainProof');
    expect(invalid).toMatchObject({ id: 78, error: { code: GATEWAY_ERROR_CODES.INVALID_PARAMS } });
  });

  it('has the gateway make a block pearld accepts from a plain proof pearljs checked as a share', async () => {
    const python = join(dirname(exe!), 'python');
    const script = join(dirname(fileURLToPath(import.meta.url)), 'gateway-mine.py');
    const before = await pearld.getBlockCount();
    // The gateway drops a proof whose job is no longer its template, which is refreshed every second.
    for (let round = 0; (await pearld.getBlockCount()) === before; round++) {
      expect(round).toBeLessThan(30);
      const handed = await job();
      const mined = handed.certVersion === 4
        ? await run(minerV4!, [hex(handed.incompleteHeader), hex(handed.ancestorHeaders![0]!)], { maxBuffer: 64 * 1024 * 1024 })
        : await run(python, [script, hex(handed.incompleteHeader), String(handed.certVersion)], { maxBuffer: 64 * 1024 * 1024 });
      const plainProof = Uint8Array.from(Buffer.from(mined.stdout.trim(), handed.certVersion === 4 ? 'hex' : 'base64'));
      expect(await verifyPlainProof(handed, plainProof)).toEqual({ valid: true, outcome: 'accepted', message: 'accepted' });
      expect((await verifyPlainProof(handed, plainProof, { bits: 0x03000001 })).valid).toBe(false);

      expect(await ask({ method: 'submitPlainProof', plainProof, job: handed })).toMatchObject({ result: 'submitted' });
      // Proving takes the gateway some seconds; a stale job is dropped at once.
      for (let waited = 0; waited < 120 && (await pearld.getBlockCount()) === before; waited++) {
        if (hex((await job()).incompleteHeader) !== hex(handed.incompleteHeader) && waited > 2) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if ((await pearld.getBlockCount()) === before) continue;

      const block = parseBlock(await pearld.getRawBlock(await pearld.getBlockHash(before + 1)));
      expect(hex(serializeBlockHeader(block.header).subarray(0, 76))).toBe(hex(handed.incompleteHeader));
      checkBlockWork(block, network, before + 1);
      expect((await verifyBlockProof(block)).valid).toBe(true);
    }
    expect(await pearld.getBlockCount()).toBe(before + 1);
  });
});
