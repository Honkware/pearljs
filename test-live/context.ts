// What global setup hands to the live tests, the fixed test wallets, and the
// typed clients every test talks to the servers through.

import { Agent, buildConnector } from 'undici';
import { OysterClient, PearldClient, PearlRpcError } from '../src/index.js';
import type { RpcClientOptions } from '../src/index.js';

export interface Credentials {
  username: string;
  password: string;
}

export interface LiveEndpoint extends Credentials {
  /** https://127.0.0.1:port */
  url: string;
  /** The server's self-signed rpc.cert, PEM. */
  ca: string;
}

export interface LiveContext {
  pearld: LiveEndpoint;
  /** pearld's --rpclimituser, who may only call the methods in rpcLimited. */
  limited: Credentials;
  /** pearld's P2P listener, for the second node of the reorg test. */
  p2p: string;
  oyster: LiveEndpoint | null;
  /** The run's temporary directory. */
  dir: string;
  /** Whether pearld forks to V4 certificates on regtest, as Pearl's fp8-scheme branch does from height 1. */
  fp8: boolean;
}

// Throwaway regtest wallets. Never fund these anywhere else.
export const MINER_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
export const OYSTER_MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
export const OYSTER_PASSPHRASE = 'pearljs-live';

// pearld and Oyster close every RPC connection after one reply, so each call
// opens a new one. On this busy macOS host new loopback connections stall now
// and then for 7 to 15 seconds and more, every socket opened in that window
// alike, and a single socket's SYNs can go unanswered until the kernel itself
// gives up. A connect that failed never carried a request, so a new socket is
// tried for every method, sends included, within the 60 second call limit.
const CONNECT_ATTEMPT = 10_000;
const CONNECT_ATTEMPTS = 5;

const stalled = (err: Error): boolean => {
  const code = (err as { code?: unknown }).code;
  return code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT';
};

/** An undici dispatcher that trusts a server's own certificate and opens a new socket when a connect stalls. */
export function trustingAgent(ca: string, connect: buildConnector.BuildOptions = {}): Agent {
  const once = buildConnector({ ca, timeout: CONNECT_ATTEMPT, ...connect });
  const retrying: buildConnector.connector = (options, callback) => {
    let attempt = 1;
    const tryOnce = (): void =>
      once(options, (...result) => {
        const [err] = result;
        if (err !== null && stalled(err) && attempt < CONNECT_ATTEMPTS) {
          attempt += 1;
          tryOnce();
        } else {
          callback(...result);
        }
      });
    tryOnce();
  };
  return new Agent({ connect: retrying });
}

/**
 * Client options that trust the endpoint's own certificate. Node's fetch
 * takes a CA only through an undici dispatcher (or NODE_EXTRA_CA_CERTS when
 * the process starts, before pearld has written its certificate).
 */
export function clientOptions(endpoint: LiveEndpoint, credentials: Credentials = endpoint): RpcClientOptions {
  return {
    url: endpoint.url,
    username: credentials.username,
    password: credentials.password,
    init: { dispatcher: trustingAgent(endpoint.ca) },
  };
}

export function pearldClient(endpoint: LiveEndpoint, credentials?: Credentials): PearldClient {
  return new PearldClient(clientOptions(endpoint, credentials));
}

export function oysterClient(endpoint: LiveEndpoint): OysterClient {
  return new OysterClient(clientOptions(endpoint));
}

/**
 * Mines n blocks with pearld's generate. Each block carries a real ZK
 * certificate on regtest, so blocks are mined in small batches to keep each
 * request well under fetch's timeouts: a V4 block takes some 20 seconds.
 */
export async function mineBlocks(client: PearldClient, n: number): Promise<string[]> {
  const hashes: string[] = [];
  while (hashes.length < n) {
    try {
      hashes.push(...(await client.call<string[]>('generate', [Math.min(5, n - hashes.length)])));
    } catch (error) {
      // A test that timed out leaves its generate running; wait for it instead of failing every test after it.
      if (!(error instanceof PearlRpcError) || !error.message.includes('already CPU mining')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  return hashes;
}
