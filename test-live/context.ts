// What global setup hands to the live tests, and the fixed test wallets.

import type { Rpc, RpcEndpoint } from './rpc.js';

export interface LiveContext {
  pearld: RpcEndpoint;
  oyster: RpcEndpoint | null;
}

// Throwaway regtest wallets. Never fund these anywhere else.
export const MINER_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
export const OYSTER_MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
export const OYSTER_PASSPHRASE = 'pearljs-live';

/**
 * Mines n blocks with pearld's generate. Each block carries a real ZK
 * certificate on regtest, so blocks are mined in small batches to keep each
 * request well under fetch's timeouts.
 */
export async function mineBlocks(rpc: Rpc, n: number): Promise<string[]> {
  const hashes: string[] = [];
  while (hashes.length < n) {
    hashes.push(...(await rpc<string[]>('generate', Math.min(10, n - hashes.length))));
  }
  return hashes;
}
