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
  parseBlock,
  parseTransaction,
  serializeTransaction,
  toOutputScript,
  transactionId,
  witnessTransactionId,
} from '../src/index.js';
import type { TxOutput, SpendEstimate, TestMempoolAcceptResult, Transaction, TxRawResult } from '../src/index.js';
import { MINER_MNEMONIC, mineBlocks, oysterClient, pearldClient, type LiveEndpoint } from './context.js';

export const live = inject('live');
export const describeLive = describe.skipIf(live === null);
export const describeOyster = describe.skipIf(live?.oyster === null || live?.oyster === undefined);

/** Stands in when there is no node; never called, since every suite is then skipped. */
export const nowhere: LiveEndpoint = { url: 'https://127.0.0.1:1', username: '', password: '', ca: '' };
export const pearld = pearldClient(live?.pearld ?? nowhere);
/** pearld as its limited user. */
export const limited = pearldClient(live?.pearld ?? nowhere, live?.limited);
export const oyster = oysterClient(live?.oyster ?? nowhere);

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

/** Broadcasts with sendrawtransaction and checks pearld reports pearljs's txid. */
export async function broadcast(tx: Transaction): Promise<string> {
  const txid = await pearld.sendRawTransaction(serializeTransaction(tx));
  expect(txid).toBe(transactionId(tx));
  return txid;
}

/** Mines a block and checks that it confirmed tx. Returns pearld's view of it. */
export async function confirm(tx: Transaction): Promise<TxRawResult> {
  const [blockHash] = await mine(1);
  const info = await pearld.getRawTransaction(transactionId(tx));
  expect(info.blockhash).toBe(blockHash);
  expect(info.confirmations).toBe(1);
  expect(info.hash).toBe(witnessTransactionId(tx));
  return info;
}

/** Broadcasts every transaction, mines one block and checks that it confirmed them all. */
export async function broadcastAllAndConfirm(txs: readonly Transaction[]): Promise<TxRawResult[]> {
  for (const tx of txs) await broadcast(tx);
  const [blockHash] = await mine(1);
  const infos: TxRawResult[] = [];
  for (const tx of txs) {
    const info = await pearld.getRawTransaction(transactionId(tx));
    expect(info.blockhash).toBe(blockHash);
    expect(info.hash).toBe(witnessTransactionId(tx));
    infos.push(info);
  }
  return infos;
}

/** broadcast, then confirm. */
export async function broadcastAndConfirm(tx: Transaction): Promise<TxRawResult> {
  await broadcast(tx);
  return confirm(tx);
}

export async function testMempoolAccept(tx: Transaction): Promise<TestMempoolAcceptResult> {
  const [result] = await pearld.testMempoolAccept([serializeTransaction(tx)]);
  return result!;
}

/** The height and median time past a transaction entering the mempool now is judged at. */
export async function nextBlock(): Promise<{ height: number; medianTimePast: number }> {
  const info = await pearld.getBlockchainInfo();
  return { height: info.blocks + 1, medianTimePast: info.mediantime };
}

/** A mature coinbase output that pays the miner and no block has spent. */
let searchFrom = 1;
async function matureCoinbase(): Promise<{ tx: Transaction; vout: number }> {
  const tip = await pearld.getBlockCount();
  // Spendable in the next block once it is 100 blocks deep.
  for (let height = searchFrom; height <= tip + 1 - 100; height++) {
    const block = parseBlock(await pearld.getRawBlock(await pearld.getBlockHash(height)));
    const tx = block.transactions[0]!;
    const txid = transactionId(tx);
    const vout = tx.outs.findIndex((out) => Buffer.from(out.script).equals(minerScript));
    if (vout < 0 || (await pearld.getTxOut(txid, vout)) === null) continue;
    // gettxout still lists an output a mempool transaction spends, and a test that failed can leave one there.
    if ((await pearld.getTxSpendingPrevOut([{ txid, vout }]))[0]?.spendingtxid) continue;
    searchFrom = height;
    return { tx, vout };
  }
  throw new Error('no mature coinbase left; mine more blocks');
}

/**
 * Pays outputs from a mature coinbase with a BIP86 key-path spend, mines it,
 * and returns the funding transaction.
 */
export async function fund(outputs: readonly TxOutput[]): Promise<Transaction> {
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
export function prevoutsOf(tx: Transaction, previous: readonly Transaction[]): TxOutput[] {
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

/** Polls until done or a minute has passed; Oyster follows pearld by notification, a moment behind. */
export async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, timeout = 60_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const fetched = new Map<string, Transaction>();

/** The outputs a mined or mempool transaction spends, looked up by txid in pearld's transaction index. */
export async function spentOutputs(tx: Transaction): Promise<TxOutput[]> {
  const prevouts: TxOutput[] = [];
  for (const input of tx.ins) {
    const txid = Buffer.from(input.hash).reverse().toString('hex');
    let source = fetched.get(txid);
    if (source === undefined) {
      source = parseTransaction(await pearld.getRawTransactionHex(txid));
      fetched.set(txid, source);
    }
    const output = source.outs[input.index]!;
    prevouts.push({ script: output.script, value: output.value });
  }
  return prevouts;
}

export { changeScript, minerScript };
