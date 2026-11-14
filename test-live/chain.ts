// Helpers the live tests share: the node connection, a funded pearljs miner,
// broadcasting, mining and confirming.

import { describe, expect, inject } from 'vitest';
import {
  createPsbt,
  createTransaction,
  deriveSigningAccountFromSeed,
  estimateVsize,
  feeForVsize,
  finalizePsbt,
  mnemonicToSeed,
  networks,
  parseTransaction,
  serializeTransaction,
  toOutputScript,
  transactionId,
  witnessTransactionId,
} from '../src/index.js';
import type { Prevout, SpendEstimate, Transaction } from '../src/index.js';
import { MINER_MNEMONIC, mineBlocks } from './context.js';
import { rpcClient, type Rpc } from './rpc.js';

export const live = inject('live');
export const describeLive = describe.skipIf(live === null);
export const describeOyster = describe.skipIf(live?.oyster === null || live?.oyster === undefined);

const unavailable: Rpc = () => Promise.reject(new Error('no live node'));
export const pearld: Rpc = live === null ? unavailable : rpcClient(live.pearld);
export const oyster: Rpc = live?.oyster ? rpcClient(live.oyster) : unavailable;

export const network = networks.regtest;
/** Coinbases pay index 0 of this account; change goes to index 1. */
export const miner = deriveSigningAccountFromSeed(mnemonicToSeed(MINER_MNEMONIC), network);
const minerScript = toOutputScript(miner.deriveAddress(0), network);
const changeScript = toOutputScript(miner.deriveAddress(1), network);

/** Fee rate for the test transactions, in grain per 1000 vbytes: twice pearld's floor. */
export const FEE_RATE = 2000n;

export function mine(n = 1): Promise<string[]> {
  return mineBlocks(pearld, n);
}

interface RawTransactionVerbose {
  txid: string;
  hash: string;
  vsize: number;
  size: number;
  confirmations?: number;
  blockhash?: string;
}

export async function getTransaction(txid: string): Promise<RawTransactionVerbose> {
  return pearld<RawTransactionVerbose>('getrawtransaction', txid, 1);
}

/** Broadcasts with sendrawtransaction and checks pearld reports pearljs's txid. */
export async function broadcast(tx: Transaction): Promise<string> {
  const txid = await pearld<string>('sendrawtransaction', serializeTransaction(tx));
  expect(txid).toBe(transactionId(tx));
  return txid;
}

/** Mines a block and checks that it confirmed tx. Returns pearld's view of it. */
export async function confirm(tx: Transaction): Promise<RawTransactionVerbose> {
  const [blockHash] = await mine(1);
  const info = await getTransaction(transactionId(tx));
  expect(info.blockhash).toBe(blockHash);
  expect(info.confirmations).toBe(1);
  expect(info.hash).toBe(witnessTransactionId(tx));
  return info;
}

/** broadcast, then confirm. */
export async function broadcastAndConfirm(tx: Transaction): Promise<RawTransactionVerbose> {
  await broadcast(tx);
  return confirm(tx);
}

export interface TestMempoolAcceptResult {
  txid: string;
  allowed: boolean;
  vsize?: number;
  'reject-reason'?: string;
}

export async function testMempoolAccept(tx: Transaction): Promise<TestMempoolAcceptResult> {
  // pearld requires maxfeerate although btcjson documents it as optional; 0 selects the default.
  const [result] = await pearld<TestMempoolAcceptResult[]>('testmempoolaccept', [serializeTransaction(tx)], 0);
  // pearld omits allowed when it is false.
  return { ...result!, allowed: result!.allowed === true };
}

/** A mature coinbase output that pays the miner and is not spent, in the chain or the mempool. */
let searchFrom = 1;
async function matureCoinbase(): Promise<{ tx: Transaction; vout: number }> {
  const tip = await pearld<number>('getblockcount');
  // Spendable in the next block once it is 100 blocks deep.
  for (let height = searchFrom; height <= tip + 1 - 100; height++) {
    const hash = await pearld<string>('getblockhash', height);
    const block = await pearld<{ tx: string[] }>('getblock', hash, 1);
    const txid = block.tx[0]!;
    const tx = parseTransaction(await pearld<string>('getrawtransaction', txid, 0));
    const vout = tx.outs.findIndex((out) => Buffer.from(out.script).equals(minerScript));
    if (vout >= 0 && (await pearld('gettxout', txid, vout, true)) !== null) {
      searchFrom = height;
      return { tx, vout };
    }
  }
  throw new Error('no mature coinbase left; mine more blocks');
}

/**
 * Pays outputs from a mature coinbase with a BIP86 key-path spend, mines it,
 * and returns the funding transaction.
 */
export async function fund(outputs: readonly Prevout[]): Promise<Transaction> {
  const coinbase = await matureCoinbase();
  const value = coinbase.tx.outs[coinbase.vout]!.value;
  const tx = createTransaction(2);
  tx.addInput(coinbase.tx.getHash(), coinbase.vout);
  for (const output of outputs) tx.addOutput(output.script, output.value);
  addChange(tx, value, [{ type: 'keyPath' }]);

  const psbt = createPsbt(tx);
  miner.prepareInput(psbt, 0, { index: 0, value });
  miner.signInput(psbt, 0, { index: 0 });
  const signed = finalizePsbt(psbt);
  await broadcastAndConfirm(signed);
  return signed;
}

/** The prevouts a transaction's inputs spend, looked up in the given transactions. */
export function prevoutsOf(tx: Transaction, previous: readonly Transaction[]): Prevout[] {
  return tx.ins.map((input) => {
    const source = previous.find((prev) => Buffer.from(prev.getHash()).equals(input.hash));
    const output = source?.outs[input.index];
    if (output === undefined) throw new Error('missing previous transaction');
    return { script: output.script, value: output.value };
  });
}

/**
 * Adds an output to the miner's change address paying what the fee for the
 * estimated vsize leaves, and returns that estimate.
 */
export function addChange(tx: Transaction, inputValue: bigint, spends: readonly SpendEstimate[]): number {
  const index = tx.addOutput(changeScript, 0n);
  const vsize = estimateVsize(tx, spends);
  const spent = tx.outs.reduce((sum, output) => sum + output.value, 0n);
  tx.outs[index]!.value = inputValue - spent - feeForVsize(vsize, FEE_RATE);
  return vsize;
}

export { changeScript, minerScript };
