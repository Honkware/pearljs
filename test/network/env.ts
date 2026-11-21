// What the public-network tests share: the node, the wallet they spend from,
// waiting for blocks other people mine, and the record of what was broadcast.
//
// Every suite is skipped unless PEARL_TESTNET_RPC_URL is set. The other
// variables:
//   PEARL_TESTNET_RPC_USER, PEARL_TESTNET_RPC_PASS (or PEARL_TESTNET_RPC_PASS_FILE),
//   PEARL_TESTNET_RPC_CA        pearld's rpc.cert
//   PEARL_TESTNET_WALLET_DIR    holds secrets.json and store/ (scripts/network/wallet.mjs makes them)
//   PEARL_TESTNET_NETWORK       testnet2 unless given; regtest for a dry run on a local node
//   PEARL_TESTNET_BLOCKBOOK     a Blockbook URL, for the backend comparison
//   PEARL_TESTNET_SCAN_FROM     the height the test wallet was made at or before, where P2MR filter scans start; 0 unless given
//   PEARL_TESTNET_OYSTER_URL, PEARL_TESTNET_OYSTER_CA, with the same user and password, for verifymessage

import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe } from 'vitest';
import { Agent, WebSocket } from 'undici';
import {
  OysterClient,
  PearlWallet,
  PearlWsClient,
  PearldClient,
  deriveSigningAccountFromSeed,
  mnemonicToSeed,
  networks,
  pearldBackend,
  type PearlNetwork,
  type PearlNetworkName,
  type PearlSigningAccount,
  type WalletBackend,
} from '../../src/index.js';
import { createFileStore } from '../../src/store-file.js';

const variable = (name: string): string | undefined => {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
};

export const rpcUrl = variable('PEARL_TESTNET_RPC_URL');
export const enabled = rpcUrl !== undefined;
export const describeTestnet = describe.skipIf(!enabled);

export const network: PearlNetwork = networks[(variable('PEARL_TESTNET_NETWORK') ?? 'testnet2') as PearlNetworkName];
export const walletDir = variable('PEARL_TESTNET_WALLET_DIR') ?? '.';
export const resultsFile = join(dirname(walletDir), 'results.jsonl');
export const blockbookUrl = variable('PEARL_TESTNET_BLOCKBOOK');

const read = (path: string | undefined): string => (path === undefined ? '' : readFileSync(path, 'utf8').trim());
const credentials = {
  username: variable('PEARL_TESTNET_RPC_USER') ?? '',
  password: variable('PEARL_TESTNET_RPC_PASS') ?? read(variable('PEARL_TESTNET_RPC_PASS_FILE')),
};
const ca = enabled ? read(variable('PEARL_TESTNET_RPC_CA')) : '';
const dispatcher = (pem: string): Agent => new Agent({ connect: { ca: pem } });

export const node = new PearldClient({
  url: rpcUrl ?? 'https://127.0.0.1:1',
  ...credentials,
  init: { dispatcher: dispatcher(ca) },
  retry: true,
  maxConcurrentRequests: 8,
});

export function wsClient(): PearlWsClient {
  return new PearlWsClient({ url: rpcUrl ?? 'https://127.0.0.1:1', ...credentials, WebSocket, webSocketInit: { dispatcher: dispatcher(ca) } });
}

export const oysterUrl = variable('PEARL_TESTNET_OYSTER_URL');
export const oyster =
  oysterUrl === undefined ? null : new OysterClient({ url: oysterUrl, ...credentials, init: { dispatcher: dispatcher(read(variable('PEARL_TESTNET_OYSTER_CA'))) } });

interface Secrets {
  mnemonic: string;
  passphrase: string;
}
export const secrets = (): Secrets => JSON.parse(readFileSync(join(walletDir, 'secrets.json'), 'utf8')) as Secrets;

/** Account n of the test wallet's phrase, for signing outside the wallet. */
export function account(n: number): PearlSigningAccount {
  return deriveSigningAccountFromSeed(mnemonicToSeed(secrets().mnemonic), network, n);
}

/** Account 0's first receive address: where every test returns what it has left. */
export const home = (): string => account(0).deriveAddress(0);

export const backend = (): WalletBackend => pearldBackend(node, { network, scanFrom: Number(variable('PEARL_TESTNET_SCAN_FROM') ?? 0) });

export async function openWallet(chain: WalletBackend = backend()): Promise<PearlWallet> {
  const wallet = await PearlWallet.open({ store: createFileStore(join(walletDir, 'store'), { breakStaleLock: true }), backend: chain, quietSyncInterval: 1 });
  await wallet.unlock(secrets().passphrase);
  return wallet;
}

/** Records what a test put on the network, for the report. */
export function record(test: string, what: string, txid: string, extra: Record<string, unknown> = {}): void {
  appendFileSync(resultsFile, `${JSON.stringify({ at: new Date().toISOString(), network: network.name, test, what, txid, ...extra })}\n`);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** How long to wait for blocks mined by others: testnet2 aims at one every 3 min 14 s, and goes quiet for longer. */
export const BLOCK_WAIT = Number(variable('PEARL_TESTNET_BLOCK_WAIT_MS') ?? 90 * 60_000);

/** Waits until the transaction has `confirmations` blocks on it, and returns the hash of the block it is in. */
export async function confirmed(txid: string, confirmations = 1, timeout = BLOCK_WAIT * confirmations): Promise<string> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const tx = await node.getRawTransaction(txid);
    if ((tx.confirmations ?? 0) >= confirmations && tx.blockhash !== undefined) return tx.blockhash;
    if (Date.now() > deadline) throw new Error(`${txid} has ${tx.confirmations ?? 0} of ${confirmations} confirmations after ${timeout} ms`);
    await sleep(10_000);
  }
}

/** Waits until the node's tip is at least `height`. */
export async function reachHeight(height: number, timeout = BLOCK_WAIT * 2): Promise<void> {
  const deadline = Date.now() + timeout;
  while ((await node.getBlockCount()) < height) {
    if (Date.now() > deadline) throw new Error(`the tip did not reach ${height} in ${timeout} ms`);
    await sleep(10_000);
  }
}

/** Waits until the node has the transaction in its mempool or a block. */
export async function seen(txid: string, timeout = 60_000): Promise<void> {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      await node.getRawTransaction(txid);
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await sleep(1000);
    }
  }
}

/** The wallet's confirmed balance in account 0, or a reason to skip a funded test. */
export async function fundsOrSkip(wallet: PearlWallet, needed: bigint): Promise<string | null> {
  await wallet.sync();
  const have = wallet.balance({ account: '0' }).confirmed;
  return have >= needed ? null : `the test wallet holds ${have} grain confirmed in account 0, and this test needs ${needed}; fund ${home()}`;
}

/** A fee rate at the node's relay floor or its estimate, whichever is higher. */
export async function feeRate(): Promise<bigint> {
  const floor = (await node.getInfo()).relayfee;
  let estimate = 0n;
  try {
    estimate = await node.estimateFee(6);
  } catch {
    // No estimate yet on a quiet chain.
  }
  return estimate > floor ? estimate : floor;
}
