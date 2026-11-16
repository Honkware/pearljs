// Starts prebuilt pearld and oyster binaries on regtest and stops them, with
// the flags pearljs's own live tests run them with (test-live/processes.ts,
// which this repeats until the live suite is moved onto it). Every listener
// is on 127.0.0.1, RPC runs over each server's default TLS with the
// certificate it generates, and nothing here builds or downloads a binary.

/**
 * A regtest launcher for tests that want a real node: starts pearld, and
 * Oyster when asked, from binaries you already have, in a temporary
 * directory, and hands back clients that trust their certificates. Node only.
 *
 * @module
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PearlError, PearlRpcError } from './errors.js';
import { deriveSigningAccountFromSeed } from './keys.js';
import { mnemonicToSeed } from './mnemonic.js';
import { networks } from './networks.js';
import { OysterClient, PearldClient } from './rpc.js';
import type { JsonRpcClient } from './rpc.js';
import { FAUCET_MNEMONIC, TEST_MNEMONIC } from './testing/keys.js';

/** Where a started server listens and how to log in. */
export interface RegtestEndpoint {
  /** https://127.0.0.1:port */
  readonly url: string;
  readonly username: string;
  readonly password: string;
  /** The server's self-signed rpc.cert, PEM. Pass it to trustingFetch, or to a WebSocket that takes a CA. */
  readonly ca: string;
}

/** Options for startRegtest. */
export interface RegtestOptions {
  /** Path of a pearld binary. */
  pearld: string;
  /** Path of an oyster binary; Oyster is started only when given. */
  oyster?: string;
  /** Where data, certificates and logs go. A new temporary directory, removed on stop, unless given. */
  dir?: string;
  /** Where generate pays. The address of pearljs/testing's faucet mnemonic unless given. */
  miningAddress?: string;
  /** Run pearld with --txindex and --addrindex, which pearldBackend needs. On unless false. */
  indexes?: boolean;
  /** More flags for pearld, such as --rejectreplacement. */
  pearldArgs?: readonly string[];
  /** The seed Oyster's wallet is created from. TEST_MNEMONIC unless given. */
  oysterMnemonic?: string;
  /** Oyster's private passphrase. "pearljs-regtest" unless given. */
  oysterPassphrase?: string;
  /** Milliseconds to wait for each server's RPC to answer. 60000 unless given. */
  startTimeout?: number;
}

/** A running regtest node, and wallet when one was asked for. */
export interface Regtest {
  readonly network: typeof networks.regtest;
  /** A client logged in as pearld's admin user. */
  readonly node: PearldClient;
  readonly endpoint: RegtestEndpoint;
  /** pearld's --rpclimituser, for testing what a read-only client may do. */
  readonly limited: { readonly username: string; readonly password: string };
  /** host:port of pearld's P2P listener, for a second node to connect to. */
  readonly p2p: string;
  /** Oyster's client and endpoint, or null when no oyster binary was given. */
  readonly oyster: { readonly client: OysterClient; readonly endpoint: RegtestEndpoint; readonly passphrase: string } | null;
  readonly dir: string;
  readonly miningAddress: string;
  /**
   * Mines blocks with generate and returns their hashes. Every regtest
   * block carries a real proof and takes seconds, so 101 blocks to a first
   * spendable coinbase take minutes; mine once and keep the directory, or
   * submit saved blocks with submitblock, when that matters.
   */
  mine(blocks?: number): Promise<string[]>;
  /** Stops Oyster, then pearld, and removes the directory if startRegtest made it. Safe to call twice. */
  stop(): Promise<void>;
}

const ADMIN = { username: 'pearljs', password: 'pearljs-regtest' };
const LIMITED = { username: 'pearljs-limited', password: 'pearljs-regtest-limited' };
const GENERATE_BATCH = 10;

function failed(message: string, cause?: unknown): PearlError {
  return new PearlError('REGTEST_FAILED', message, cause === undefined ? undefined : { cause });
}

/**
 * A fetch that trusts one certificate, for clients of a server started
 * here: `new PearldClient({ ...endpoint, fetch: trustingFetch(endpoint.ca) })`.
 * Node's own fetch takes a CA only through a dispatcher from undici.
 */
export function trustingFetch(ca: string): typeof globalThis.fetch {
  return (input, init = {}) =>
    new Promise<Response>((resolve, reject) => {
      const headers = Object.fromEntries(new Headers(init.headers));
      const req = request(String(input), { method: init.method ?? 'GET', headers, ca, ...(init.signal ? { signal: init.signal } : {}) }, (res) => {
        const chunks: Uint8Array[] = [];
        res.on('data', (chunk: Uint8Array) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 502 })));
      });
      req.on('error', reject);
      req.end(typeof init.body === 'string' ? init.body : undefined);
    });
}

/** A port nothing is listening on right now. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address === null || typeof address === 'string') reject(failed('could not find a free port'));
        else resolve(address.port);
      });
    });
  });
}

const children = new Set<ChildProcess>();
const spawnErrors = new WeakMap<ChildProcess, Error>();
let exitHook = false;

function launch(exe: string, args: string[], logFile: string): ChildProcess {
  // Last resort when the test process dies without calling stop.
  if (!exitHook) {
    exitHook = true;
    process.on('exit', () => {
      for (const child of children) child.kill('SIGKILL');
    });
  }
  const log = createWriteStream(logFile, { flags: 'a' });
  const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  // A binary that cannot be run is reported by whoever waits for the process.
  child.on('error', (err) => {
    spawnErrors.set(child, err);
    children.delete(child);
  });
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}

const gone = (child: ChildProcess): boolean => child.exitCode !== null || child.signalCode !== null || child.pid === undefined;
async function whyGone(child: ChildProcess, logFile: string): Promise<string> {
  // spawn reports a binary it could not run on a later turn of the loop.
  await new Promise((resolve) => setImmediate(resolve));
  return spawnErrors.get(child)?.message ?? (await logTail(logFile));
}

function exited(child: ChildProcess): Promise<void> {
  if (gone(child)) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
    child.once('error', () => resolve());
  });
}

async function logTail(logFile: string): Promise<string> {
  const text = await readFile(logFile, 'utf8').catch(() => '');
  return text.split('\n').slice(-20).join('\n');
}

// Waits for the server to write its certificate and answer one call.
async function waitForRpc<Client extends JsonRpcClient>(
  child: ChildProcess,
  certFile: string,
  connect: (ca: string) => Client,
  method: string,
  logFile: string,
  timeout: number,
): Promise<{ ca: string; client: Client }> {
  const deadline = Date.now() + timeout;
  let ca: string | undefined;
  let client: Client | undefined;
  for (;;) {
    if (gone(child)) throw failed(`${child.spawnfile} exited before its RPC server came up:\n${await whyGone(child, logFile)}`);
    try {
      ca ??= await readFile(certFile, 'utf8');
      client ??= connect(ca);
      await client.call(method);
      return { ca, client };
    } catch (err) {
      if (Date.now() > deadline) throw failed(`RPC did not come up within ${timeout} ms: ${String(err)}\n${await logTail(logFile)}`, err);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function shutDown(child: ChildProcess, client: JsonRpcClient): Promise<void> {
  if (gone(child)) return;
  await client.call('stop').catch(() => child.kill('SIGTERM'));
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
  await exited(child);
  clearTimeout(timer);
}

/**
 * Starts pearld on regtest, and Oyster connected to it when `oyster` is
 * given, and resolves once their RPC servers answer. The chain is empty:
 * call `mine`. Throws REGTEST_FAILED, with the end of the server's log, when
 * a binary cannot be started or does not come up.
 */
export async function startRegtest(options: RegtestOptions): Promise<Regtest> {
  const network = networks.regtest;
  const timeout = options.startTimeout ?? 60_000;
  const ownDir = options.dir === undefined;
  const dir = options.dir ?? (await mkdtemp(join(tmpdir(), 'pearljs-regtest-')));
  const miningAddress = options.miningAddress ?? deriveSigningAccountFromSeed(mnemonicToSeed(FAUCET_MNEMONIC), network).deriveAddress(0);
  const running: (() => Promise<void>)[] = [];
  let stopped: Promise<void> | null = null;
  const stop = (): Promise<void> =>
    (stopped ??= (async () => {
      for (const halt of running.reverse()) await halt();
      if (ownDir) await rm(dir, { recursive: true, force: true });
    })());

  try {
    const [rpcPort, p2pPort] = [await freePort(), await freePort()];
    const nodeDir = join(dir, 'pearld');
    await mkdir(nodeDir, { recursive: true });
    const nodeLog = join(nodeDir, 'pearld.log');
    const nodeCert = join(nodeDir, 'rpc.cert');
    const pearld = launch(
      options.pearld,
      [
        '--regtest',
        `--datadir=${join(nodeDir, 'data')}`,
        `--logdir=${join(nodeDir, 'logs')}`,
        `--rpcuser=${ADMIN.username}`,
        `--rpcpass=${ADMIN.password}`,
        `--rpclimituser=${LIMITED.username}`,
        `--rpclimitpass=${LIMITED.password}`,
        `--rpclisten=127.0.0.1:${rpcPort}`,
        // Without these pearld writes the pair into the user's home directory.
        `--rpccert=${nodeCert}`,
        `--rpckey=${join(nodeDir, 'rpc.key')}`,
        `--listen=127.0.0.1:${p2pPort}`,
        '--nodnsseed',
        `--miningaddr=${miningAddress}`,
        ...(options.indexes === false ? [] : ['--txindex', '--addrindex']),
        // Regtest relays non-standard transactions by default; mainnet does not.
        '--rejectnonstd',
        ...(options.pearldArgs ?? []),
      ],
      nodeLog,
    );
    running.push(async () => {
      if (!gone(pearld)) pearld.kill('SIGKILL');
    });
    const url = `https://127.0.0.1:${rpcPort}`;
    const { ca, client: node } = await waitForRpc(pearld, nodeCert, (pem) => new PearldClient({ url, ...ADMIN, fetch: trustingFetch(pem) }), 'getblockcount', nodeLog, timeout);
    running[0] = () => shutDown(pearld, node);

    let oyster: Regtest['oyster'] = null;
    if (options.oyster !== undefined) {
      const walletDir = join(dir, 'oyster');
      const appData = join(walletDir, 'appdata');
      await mkdir(appData, { recursive: true });
      const passphrase = options.oysterPassphrase ?? 'pearljs-regtest';
      const common = ['--regtest', `--appdata=${appData}`, `--logdir=${join(walletDir, 'logs')}`];
      const createFile = join(walletDir, 'create.json');
      const createLog = join(walletDir, 'create.log');
      await writeFile(createFile, JSON.stringify({ PrivatePassphrase: passphrase, Seed: options.oysterMnemonic ?? TEST_MNEMONIC, Bday: '0' }));
      const creator = launch(options.oyster, [...common, `--createfromfile=${createFile}`], createLog);
      await exited(creator);
      // The file holds the seed; the wallet has it now.
      await rm(createFile, { force: true });
      if (creator.exitCode !== 0) throw failed(`oyster --createfromfile failed:\n${await whyGone(creator, createLog)}`);

      const walletPort = await freePort();
      const walletCert = join(walletDir, 'rpc.cert');
      const walletLog = join(walletDir, 'oyster.log');
      const pearldCert = join(walletDir, 'pearld.cert');
      await writeFile(pearldCert, ca);
      const child = launch(
        options.oyster,
        [
          ...common,
          `--rpcconnect=127.0.0.1:${rpcPort}`,
          `--cafile=${pearldCert}`,
          `--pearldusername=${ADMIN.username}`,
          `--pearldpassword=${ADMIN.password}`,
          `--rpclisten=127.0.0.1:${walletPort}`,
          `--rpccert=${walletCert}`,
          `--rpckey=${join(walletDir, 'rpc.key')}`,
          `--username=${ADMIN.username}`,
          `--password=${ADMIN.password}`,
        ],
        walletLog,
      );
      running.push(async () => {
        if (!gone(child)) child.kill('SIGKILL');
      });
      const walletUrl = `https://127.0.0.1:${walletPort}`;
      const up = await waitForRpc(child, walletCert, (pem) => new OysterClient({ url: walletUrl, ...ADMIN, fetch: trustingFetch(pem) }), 'getinfo', walletLog, timeout);
      running[1] = () => shutDown(child, up.client);
      oyster = { client: up.client, endpoint: { url: walletUrl, ...ADMIN, ca: up.ca }, passphrase };
    }

    return {
      network,
      node,
      endpoint: { url, ...ADMIN, ca },
      limited: LIMITED,
      p2p: `127.0.0.1:${p2pPort}`,
      oyster,
      dir,
      miningAddress,
      async mine(blocks = 1) {
        const hashes: string[] = [];
        // Small batches keep each request short: a block takes seconds to prove.
        while (hashes.length < blocks) {
          try {
            hashes.push(...(await node.generate(Math.min(GENERATE_BATCH, blocks - hashes.length))));
          } catch (err) {
            // An earlier generate that timed out is still running; wait for it.
            if (!(err instanceof PearlRpcError) || !err.message.includes('already CPU mining')) throw err;
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }
        return hashes;
      },
      stop,
    };
  } catch (err) {
    await stop();
    throw err;
  }
}
