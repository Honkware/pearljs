// The regtest launcher without a pearld: a script that takes pearld's and
// oyster's flags and answers over TLS stands in for both binaries, so the
// launcher's own work is tested here: the flags it passes, waiting for the
// certificate and the first reply, mining in batches, stopping and cleaning
// up. That real binaries accept those flags is the live suite's to show.

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { PearldClient, networks } from '../src/index.js';
import { SimulatedChain, TEST_MNEMONIC } from '../src/testing.js';
import { startRegtest, trustingFetch } from '../src/testing-regtest.js';
import type { Regtest } from '../src/testing-regtest.js';

const work = mkdtempSync(join(tmpdir(), 'pearljs-launcher-test-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

// A throwaway certificate for 127.0.0.1, made by the machine's openssl; without one these tests are skipped.
const pair = ((): { cert: string; key: string } | null => {
  if (process.platform === 'win32') return null;
  const [key, cert] = [join(work, 'fake.key'), join(work, 'fake.cert')];
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', key, '-out', cert], { stdio: 'ignore' });
    return { cert, key };
  } catch {
    return null;
  }
})();

const argsFile = join(work, 'args.jsonl');
const exe = join(work, 'fake-pearld');
writeFileSync(exe, `#!/bin/sh\nexec "${process.execPath}" "${fileURLToPath(new URL('./fixtures/fake-pearld.mjs', import.meta.url))}" "$@"\n`);
chmodSync(exe, 0o755);
const launches = (): string[][] => readFileSync(argsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as string[]);

describe.skipIf(pair === null)('startRegtest', () => {
  let regtest: Regtest | null = null;
  const env = (extra: Record<string, string> = {}): void => {
    Object.assign(process.env, { FAKE_CERT: pair!.cert, FAKE_KEY: pair!.key, FAKE_ARGS: argsFile, FAKE_CRASH: '0', FAKE_BUSY: '0', ...extra });
    rmSync(argsFile, { force: true });
  };
  afterEach(async () => {
    await regtest?.stop();
    regtest = null;
  });

  it('starts pearld with the live suite\'s flags in a directory of its own, mines in batches and cleans up', async () => {
    env({ FAKE_BUSY: '1' });
    regtest = await startRegtest({ pearld: exe, pearldArgs: ['--rejectreplacement'] });
    const [args] = launches();
    const port = new URL(regtest.endpoint.url).port;
    expect(args).toEqual([
      '--regtest',
      `--datadir=${join(regtest.dir, 'pearld', 'data')}`,
      `--logdir=${join(regtest.dir, 'pearld', 'logs')}`,
      '--rpcuser=pearljs',
      '--rpcpass=pearljs-regtest',
      '--rpclimituser=pearljs-limited',
      '--rpclimitpass=pearljs-regtest-limited',
      `--rpclisten=127.0.0.1:${port}`,
      `--rpccert=${join(regtest.dir, 'pearld', 'rpc.cert')}`,
      `--rpckey=${join(regtest.dir, 'pearld', 'rpc.key')}`,
      `--listen=${regtest.p2p}`,
      '--nodnsseed',
      `--miningaddr=${new SimulatedChain({ premine: 0 }).faucet.address}`,
      '--txindex',
      '--addrindex',
      '--rejectnonstd',
      '--rejectreplacement',
    ]);
    expect(regtest.network).toBe(networks.regtest);
    expect(regtest.miningAddress).toBe(new SimulatedChain({ premine: 0 }).faucet.address);
    expect(regtest.endpoint.ca).toBe(readFileSync(pair!.cert, 'utf8'));
    expect(regtest.oyster).toBeNull();
    expect(await regtest.node.getBlockCount()).toBe(0);
    // 25 blocks are three requests, after one that found the miner busy.
    const hashes = await regtest.mine(25);
    expect(hashes).toHaveLength(25);
    expect(await regtest.node.getBlockCount()).toBe(25);
    // Another client for the same node, built from the endpoint.
    const { ca, ...login } = regtest.endpoint;
    expect(await new PearldClient({ ...login, fetch: trustingFetch(ca) }).getBlockCount()).toBe(25);
    await expect(new PearldClient({ url: login.url, ...regtest.limited, fetch: trustingFetch(ca) }).getBlockCount()).rejects.toMatchObject({ code: 'RPC_HTTP', status: 401 });
    await expect(new PearldClient(login).getBlockCount()).rejects.toMatchObject({ code: 'RPC_NETWORK' });

    const { dir } = regtest;
    expect(existsSync(join(dir, 'pearld', 'pearld.log'))).toBe(true);
    await regtest.stop();
    await regtest.stop();
    expect(existsSync(dir)).toBe(false);
    await expect(regtest.node.getBlockCount()).rejects.toMatchObject({ code: 'RPC_NETWORK' });
  });

  it('starts Oyster against the node when given its binary, and keeps a directory it was handed', async () => {
    env();
    const dir = join(work, 'kept');
    regtest = await startRegtest({ pearld: exe, oyster: exe, dir, indexes: false, miningAddress: 'rprl1pexample', oysterPassphrase: 'secret words' });
    const [node, create, wallet] = launches();
    expect(node).toContain('--miningaddr=rprl1pexample');
    expect(node!.some((arg) => arg === '--txindex' || arg === '--addrindex')).toBe(false);
    expect(create).toEqual(['--regtest', `--appdata=${join(dir, 'oyster', 'appdata')}`, `--logdir=${join(dir, 'oyster', 'logs')}`, `--createfromfile=${join(dir, 'oyster', 'create.json')}`]);
    // The seed file is gone once the wallet exists.
    expect(existsSync(join(dir, 'oyster', 'create.json'))).toBe(false);
    expect(wallet).toEqual([
      ...create!.slice(0, 3),
      `--rpcconnect=${new URL(regtest.endpoint.url).host}`,
      `--cafile=${join(dir, 'oyster', 'pearld.cert')}`,
      '--pearldusername=pearljs',
      '--pearldpassword=pearljs-regtest',
      `--rpclisten=${new URL(regtest.oyster!.endpoint.url).host}`,
      `--rpccert=${join(dir, 'oyster', 'rpc.cert')}`,
      `--rpckey=${join(dir, 'oyster', 'rpc.key')}`,
      '--username=pearljs',
      '--password=pearljs-regtest',
    ]);
    expect(readFileSync(join(dir, 'oyster', 'pearld.cert'), 'utf8')).toBe(regtest.endpoint.ca);
    expect(regtest.oyster!.passphrase).toBe('secret words');
    expect(await regtest.oyster!.client.call('getinfo')).toEqual({ blocks: 0 });
    await regtest.stop();
    expect(existsSync(join(dir, 'pearld', 'pearld.log'))).toBe(true);
    expect(TEST_MNEMONIC.split(' ')).toHaveLength(12);
  });

  it('fails with the server\'s log when it exits, and with the reason when the binary cannot be run', async () => {
    env({ FAKE_CRASH: '1' });
    const dir = join(work, 'crash');
    await expect(startRegtest({ pearld: exe, dir })).rejects.toMatchObject({ code: 'REGTEST_FAILED', message: expect.stringContaining('fake pearld: refusing to start') });
    await expect(startRegtest({ pearld: join(work, 'no-such-binary') })).rejects.toMatchObject({ code: 'REGTEST_FAILED', message: expect.stringContaining('ENOENT') });
    env();
    // A node that is up is stopped again when Oyster does not start.
    const half = join(work, 'half');
    await expect(startRegtest({ pearld: exe, oyster: join(work, 'no-such-binary'), dir: half })).rejects.toMatchObject({ code: 'REGTEST_FAILED' });
    const port = launches()[0]!.find((arg) => arg.startsWith('--rpclisten='))!.split(':')[1];
    await expect(new PearldClient({ url: `https://127.0.0.1:${port}`, fetch: trustingFetch(readFileSync(pair!.cert, 'utf8')) }).getBlockCount()).rejects.toMatchObject({ code: 'RPC_NETWORK' });
  });

  it('gives up when the RPC server never answers', async () => {
    env();
    // Something that listens on TLS and never replies to a call.
    const silent = createServer({ cert: readFileSync(pair!.cert), key: readFileSync(pair!.key) }, () => {});
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const sleeper = join(work, 'sleeper');
    writeFileSync(sleeper, '#!/bin/sh\nsleep 30\n');
    chmodSync(sleeper, 0o755);
    const started = Date.now();
    await expect(startRegtest({ pearld: sleeper, startTimeout: 600 })).rejects.toMatchObject({ code: 'REGTEST_FAILED', message: expect.stringContaining('did not come up within 600 ms') });
    expect(Date.now() - started).toBeLessThan(5000);
    silent.close();
  });
});
