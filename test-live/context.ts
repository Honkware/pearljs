// What global setup hands to the live tests, the fixed test wallets, and the
// typed clients every test talks to the servers through.

import { Agent } from 'undici';
import { OysterClient, PearldClient } from '../src/index.js';
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
}

// Throwaway regtest wallets. Never fund these anywhere else.
export const MINER_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
export const OYSTER_MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
export const OYSTER_PASSPHRASE = 'pearljs-live';

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
    init: { dispatcher: new Agent({ connect: { ca: endpoint.ca } }) },
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
 * request well under fetch's timeouts.
 */
export async function mineBlocks(client: PearldClient, n: number): Promise<string[]> {
  const hashes: string[] = [];
  while (hashes.length < n) {
    hashes.push(...(await client.call<string[]>('generate', [Math.min(10, n - hashes.length)])));
  }
  return hashes;
}
