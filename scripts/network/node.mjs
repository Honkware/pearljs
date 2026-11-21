// Connection to a testnet2 pearld, from the same PEARL_TESTNET_* variables the
// tests read, or from rpc.pass and rpc.cert in PEARL_TESTNET_DIR when they are unset. Imports `pearljs` from dist/: build first.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PearldClient } from 'pearljs';
import { pearldFetch } from 'pearljs/tls-fetch';

if (!process.env.PEARL_TESTNET_DIR) throw new Error('PEARL_TESTNET_DIR is not set');
export const nodeDir = process.env.PEARL_TESTNET_DIR;

export function endpoint() {
  return {
    url: process.env.PEARL_TESTNET_RPC_URL ?? 'https://127.0.0.1:44114',
    username: process.env.PEARL_TESTNET_RPC_USER ?? 'pearljs',
    password: process.env.PEARL_TESTNET_RPC_PASS ?? readFileSync(join(nodeDir, 'rpc.pass'), 'utf8').trim(),
    ca: readFileSync(process.env.PEARL_TESTNET_RPC_CA ?? join(nodeDir, 'rpc.cert'), 'utf8'),
  };
}

export function client(options = {}) {
  const { url, username, password, ca } = endpoint();
  return new PearldClient({ url, username, password, fetch: pearldFetch({ ca }), retry: true, ...options });
}
