// Starts prebuilt pearld and oyster binaries on regtest and stops them. Nothing
// is built here: the binaries come from the PEARLD and OYSTER environment
// variables. Every listener is on 127.0.0.1, RPC runs over each server's
// default TLS with the certificate it generates, and a node only ever peers
// with another node started here.

import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import type { JsonRpcClient, OysterClient, PearldClient } from '../src/index.js';
import { oysterClient, pearldClient, type Credentials, type LiveEndpoint } from './context.js';

export interface RunningProcess<Client extends JsonRpcClient> {
  readonly endpoint: LiveEndpoint;
  readonly client: Client;
  readonly logFile: string;
  stop(): Promise<void>;
}

export interface RunningPearld extends RunningProcess<PearldClient> {
  readonly limited: Credentials;
  /** host:port of the P2P listener. */
  readonly p2p: string;
}

const ADMIN: Credentials = { username: 'pearljs', password: 'pearljs-live' };
const LIMITED: Credentials = { username: 'pearljs-limited', password: 'pearljs-limited-live' };

/** A port nothing is listening on right now. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address === null || typeof address === 'string') reject(new Error('no port'));
        else resolve(address.port);
      });
    });
  });
}

const children = new Set<ChildProcess>();
// Last resort when the test process dies without running teardown.
process.on('exit', () => {
  for (const child of children) child.kill('SIGKILL');
});

function launch(exe: string, args: string[], logFile: string): ChildProcess {
  const log = createWriteStream(logFile, { flags: 'a' });
  const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}

function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
}

async function logTail(logFile: string): Promise<string> {
  const text = await readFile(logFile, 'utf8').catch(() => '');
  return text.split('\n').slice(-20).join('\n');
}

/**
 * Waits for the server to write its certificate and answer one call, and
 * returns a client that trusts that certificate.
 */
async function waitForRpc<Client extends JsonRpcClient>(
  child: ChildProcess,
  certFile: string,
  connect: (ca: string) => Client,
  method: string,
  logFile: string,
): Promise<{ ca: string; client: Client }> {
  const deadline = Date.now() + 60_000;
  let ca: string | undefined;
  let client: Client | undefined;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`process exited before its RPC server came up:\n${await logTail(logFile)}`);
    }
    try {
      ca ??= await readFile(certFile, 'utf8');
      client ??= connect(ca);
      await client.call(method);
      return { ca, client };
    } catch (error) {
      if (Date.now() > deadline) throw new Error(`RPC did not come up: ${String(error)}\n${await logTail(logFile)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function stopper(child: ChildProcess, client: JsonRpcClient): () => Promise<void> {
  return async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await client.call('stop').catch(() => child.kill('SIGTERM'));
    const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
    await exited(child);
    clearTimeout(timeout);
  };
}

export interface PearldOptions {
  exe: string;
  dir: string;
  miningAddress: string;
}

export async function startPearld(options: PearldOptions): Promise<RunningPearld> {
  const [rpcPort, p2pPort] = [await freePort(), await freePort()];
  await mkdir(options.dir, { recursive: true });
  const logFile = join(options.dir, 'pearld.log');
  const certFile = join(options.dir, 'rpc.cert');
  const child = launch(
    options.exe,
    [
      '--regtest',
      `--datadir=${join(options.dir, 'data')}`,
      `--logdir=${join(options.dir, 'logs')}`,
      `--rpcuser=${ADMIN.username}`,
      `--rpcpass=${ADMIN.password}`,
      `--rpclimituser=${LIMITED.username}`,
      `--rpclimitpass=${LIMITED.password}`,
      `--rpclisten=127.0.0.1:${rpcPort}`,
      // Without these pearld writes the pair into the user's home directory.
      `--rpccert=${certFile}`,
      `--rpckey=${join(options.dir, 'rpc.key')}`,
      `--listen=127.0.0.1:${p2pPort}`,
      '--nodnsseed',
      `--miningaddr=${options.miningAddress}`,
      '--txindex',
      '--addrindex',
      // Regtest relays non-standard transactions by default; mainnet does not.
      '--rejectnonstd',
    ],
    logFile,
  );
  const url = `https://127.0.0.1:${rpcPort}`;
  try {
    const { ca, client } = await waitForRpc(
      child,
      certFile,
      (pem) => pearldClient({ url, ca: pem, ...ADMIN }),
      'getblockcount',
      logFile,
    );
    return {
      endpoint: { url, ca, ...ADMIN },
      limited: LIMITED,
      p2p: `127.0.0.1:${p2pPort}`,
      client,
      logFile,
      stop: stopper(child, client),
    };
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  }
}

export interface OysterOptions {
  exe: string;
  dir: string;
  pearld: LiveEndpoint;
  mnemonic: string;
  passphrase: string;
}

export async function startOyster(options: OysterOptions): Promise<RunningProcess<OysterClient>> {
  const appData = join(options.dir, 'appdata');
  await mkdir(appData, { recursive: true });
  const logFile = join(options.dir, 'oyster.log');
  const common = ['--regtest', `--appdata=${appData}`, `--logdir=${join(options.dir, 'logs')}`];

  const createFile = join(options.dir, 'create.json');
  await writeFile(
    createFile,
    JSON.stringify({ PrivatePassphrase: options.passphrase, Seed: options.mnemonic, Bday: '0' }),
  );
  const creator = launch(options.exe, [...common, `--createfromfile=${createFile}`], join(options.dir, 'create.log'));
  await exited(creator);
  if (creator.exitCode !== 0) {
    throw new Error(`oyster --createfromfile failed:\n${await logTail(join(options.dir, 'create.log'))}`);
  }

  const rpcPort = await freePort();
  const certFile = join(options.dir, 'rpc.cert');
  const pearldCert = join(options.dir, 'pearld.cert');
  await writeFile(pearldCert, options.pearld.ca);
  const child = launch(
    options.exe,
    [
      ...common,
      `--rpcconnect=${new URL(options.pearld.url).host}`,
      `--cafile=${pearldCert}`,
      `--pearldusername=${options.pearld.username}`,
      `--pearldpassword=${options.pearld.password}`,
      `--rpclisten=127.0.0.1:${rpcPort}`,
      `--rpccert=${certFile}`,
      `--rpckey=${join(options.dir, 'rpc.key')}`,
      `--username=${ADMIN.username}`,
      `--password=${ADMIN.password}`,
    ],
    logFile,
  );
  const url = `https://127.0.0.1:${rpcPort}`;
  try {
    const { ca, client } = await waitForRpc(
      child,
      certFile,
      (pem) => oysterClient({ url, ca: pem, ...ADMIN }),
      'getinfo',
      logFile,
    );
    return { endpoint: { url, ca, ...ADMIN }, client, logFile, stop: stopper(child, client) };
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  }
}
