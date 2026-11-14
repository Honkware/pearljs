// Starts prebuilt pearld and oyster binaries on regtest and stops them. Nothing
// is built here: the binaries come from the PEARLD and OYSTER environment
// variables. Every listener is on 127.0.0.1 and the node takes no peers.

import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { rpcClient, type Rpc, type RpcEndpoint } from './rpc.js';

export interface RunningProcess {
  readonly endpoint: RpcEndpoint;
  readonly rpc: Rpc;
  readonly logFile: string;
  stop(): Promise<void>;
}

const USER = 'pearljs';
const PASS = 'pearljs-live';

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
  const log = createWriteStream(logFile);
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

async function waitForRpc(child: ChildProcess, rpc: Rpc, method: string, logFile: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`process exited before its RPC server came up:\n${await logTail(logFile)}`);
    }
    try {
      await rpc(method);
      return;
    } catch (error) {
      if (Date.now() > deadline) throw new Error(`RPC did not come up: ${String(error)}\n${await logTail(logFile)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function stopper(child: ChildProcess, rpc: Rpc): () => Promise<void> {
  return async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await rpc('stop').catch(() => child.kill('SIGTERM'));
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

export async function startPearld(options: PearldOptions): Promise<RunningProcess> {
  const [rpcPort, p2pPort] = [await freePort(), await freePort()];
  const endpoint = { url: `http://127.0.0.1:${rpcPort}`, user: USER, pass: PASS };
  await mkdir(options.dir, { recursive: true });
  const logFile = join(options.dir, 'pearld.log');
  const child = launch(
    options.exe,
    [
      '--regtest',
      `--datadir=${join(options.dir, 'data')}`,
      `--logdir=${join(options.dir, 'logs')}`,
      `--rpcuser=${USER}`,
      `--rpcpass=${PASS}`,
      `--rpclisten=127.0.0.1:${rpcPort}`,
      // Plain HTTP is only accepted because the listener is loopback.
      '--notls',
      `--listen=127.0.0.1:${p2pPort}`,
      '--nodnsseed',
      `--miningaddr=${options.miningAddress}`,
      '--txindex',
      // Regtest relays non-standard transactions by default; mainnet does not.
      '--rejectnonstd',
    ],
    logFile,
  );
  const rpc = rpcClient(endpoint);
  try {
    await waitForRpc(child, rpc, 'getblockcount', logFile);
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  }
  return { endpoint, rpc, logFile, stop: stopper(child, rpc) };
}

export interface OysterOptions {
  exe: string;
  dir: string;
  pearld: RpcEndpoint;
  mnemonic: string;
  passphrase: string;
}

export async function startOyster(options: OysterOptions): Promise<RunningProcess> {
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
  const endpoint = { url: `http://127.0.0.1:${rpcPort}`, user: USER, pass: PASS };
  const child = launch(
    options.exe,
    [
      ...common,
      `--rpcconnect=${new URL(options.pearld.url).host}`,
      '--noclienttls',
      `--pearldusername=${options.pearld.user}`,
      `--pearldpassword=${options.pearld.pass}`,
      `--rpclisten=127.0.0.1:${rpcPort}`,
      '--noservertls',
      `--username=${USER}`,
      `--password=${PASS}`,
    ],
    logFile,
  );
  const rpc = rpcClient(endpoint);
  try {
    await waitForRpc(child, rpc, 'getinfo', logFile);
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  }
  return { endpoint, rpc, logFile, stop: stopper(child, rpc) };
}
