// Connection settings for the examples that talk to a node, read from the
// environment so no credential is ever written into a file:
//
//   PEARL_NETWORK     mainnet, testnet, testnet2, regtest (default) or simnet
//   PEARLD_RPC_URL    default https://127.0.0.1:<the network's RPC port>
//   PEARLD_RPC_USER   pearld's --rpcuser
//   PEARLD_RPC_PASS   pearld's --rpcpass
//   PEARLD_RPC_CERT   path to pearld's rpc.cert, to trust its self-signed TLS
import { readFileSync } from 'node:fs';
import { Agent } from 'undici';
import { networks, PEARLD_RPC_PORTS, type PearlNetwork, type PearlNetworkName } from 'pearljs';

export function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    console.error(`${name} is not set`);
    process.exit(1);
  }
  return value;
}

export function network(): PearlNetwork {
  const name = process.env.PEARL_NETWORK ?? 'regtest';
  if (!(name in networks)) {
    console.error(`PEARL_NETWORK must be one of ${Object.keys(networks).join(', ')}`);
    process.exit(1);
  }
  return networks[name as PearlNetworkName];
}

/** An undici Agent that trusts pearld's rpc.cert, or undefined to use the system's CAs. */
export function dispatcher(): Agent | undefined {
  const path = process.env.PEARLD_RPC_CERT;
  return path === undefined ? undefined : new Agent({ connect: { ca: readFileSync(path, 'utf8') } });
}

export function pearld(): { url: string; username: string; password: string } {
  const port = PEARLD_RPC_PORTS[network().name as PearlNetworkName];
  return {
    url: process.env.PEARLD_RPC_URL ?? `https://127.0.0.1:${port}`,
    username: required('PEARLD_RPC_USER'),
    password: required('PEARLD_RPC_PASS'),
  };
}
