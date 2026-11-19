// Helpers the live tests share: the node connection, a funded pearljs miner,
// broadcasting, mining and confirming.

import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, inject } from 'vitest';
import {
  createPsbt,
  createTransaction,
  customNetwork,
  deriveSigningAccountFromSeed,
  estimateVsize,
  feeForVsize,
  finalizePsbt,
  mnemonicToSeed,
  networks,
  parseBlock,
  parseTransaction,
  PearlRpcError,
  serializeTransaction,
  toOutputScript,
  transactionId,
  verifyTransaction,
  witnessTransactionId,
} from '../src/index.js';
import type { CallOptions, PearldClient, SpendEstimate, TestMempoolAcceptResult, Transaction, TransactionResult, TxOutput, TxRawResult } from '../src/index.js';
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

/** Regtest as the suite's pearld runs it: without the FP8 fork when it was built from Pearl master. */
export const network = live?.fp8 === false ? customNetwork(networks.regtest, { forkHeights: { fp8: 0 } }) : networks.regtest;

// Every transaction a test puts to the suite's node through this client,
// with sendrawtransaction or testmempoolaccept, is first judged by the script
// interpreter, and the two verdicts are compared: what pearld takes must
// verify, and what pearld refuses in its script engine must fail here on the
// same input with the engine's own message. Each comparison is written to a
// file in the run's directory, which interpreter.test.ts reads at the end.
export interface Judged {
  outcome: 'accepted' | 'script' | 'other' | 'unjudged' | 'disagree';
  via: string;
  file: string;
  txid?: string;
  hex?: string;
  code?: string;
  detail?: string;
}
export const judgedFile = join(live?.dir ?? '.', 'interpreter.jsonl');
const SCRIPT_REFUSAL = /failed to validate input [0-9a-f]{64}:(\d+) which references output \S+ - (.*?) \(input witness \[/s;
const sourceHex = new Map<string, string>();

function hookInterpreter(client: PearldClient): void {
  const call = client.call.bind(client);
  const judge = async (hex: unknown): Promise<{ tx: Transaction; verdict: TransactionResult } | null> => {
    try {
      const tx = parseTransaction(hex as string);
      const prevouts: TxOutput[] = [];
      for (const input of tx.ins) {
        const txid = Buffer.from(input.hash).reverse().toString('hex');
        if (!sourceHex.has(txid)) sourceHex.set(txid, await call<string>('getrawtransaction', [txid, 0]));
        const output = parseTransaction(sourceHex.get(txid)!).outs[input.index]!;
        prevouts.push({ script: output.script, value: output.value });
      }
      return { tx, verdict: verifyTransaction(tx, prevouts) };
    } catch {
      // Not a transaction, or one whose inputs the node does not have.
      return null;
    }
  };
  const compare = (judged: Awaited<ReturnType<typeof judge>>, via: string, hex: unknown, refusal: string | null): void => {
    const file = (expect.getState().testPath ?? '').split('/').pop() ?? '';
    const write = (entry: Omit<Judged, 'via' | 'file'>): void => appendFileSync(judgedFile, `${JSON.stringify({ via, file, ...entry })}\n`);
    if (judged === null) return write({ outcome: 'unjudged' });
    const { tx, verdict } = judged;
    const txid = tx.getId();
    const disagree = (detail: string): never => {
      write({ outcome: 'disagree', txid, hex: hex as string, detail });
      throw new Error(`the interpreter and pearld disagree about ${txid}: ${detail}`);
    };
    if (refusal === null) {
      if (!verdict.ok) disagree(`pearld accepts it, the interpreter fails input ${verdict.inputIndex} with ${verdict.code}: ${verdict.message}`);
      return write({ outcome: 'accepted', txid, ...(via === 'sendrawtransaction' ? { hex: hex as string } : {}) });
    }
    const script = SCRIPT_REFUSAL.exec(refusal);
    if (script === null) return write({ outcome: 'other', txid, detail: refusal.slice(0, 120) });
    if (verdict.ok) return disagree(`pearld's script engine refuses it (${script[2]}), the interpreter accepts it`);
    if (verdict.inputIndex !== Number(script[1])) disagree(`pearld fails input ${script[1]}, the interpreter input ${verdict.inputIndex}`);
    if (verdict.message !== script[2]) disagree(`pearld says "${script[2]}", the interpreter ${verdict.code}: "${verdict.message}"`);
    return write({ outcome: 'script', txid, code: verdict.code, detail: script[2]! });
  };
  client.call = (async (method: string, params: readonly unknown[] = [], options?: CallOptions) => {
    if (method === 'sendrawtransaction') {
      const judged = await judge(params[0]);
      let result: unknown;
      try {
        result = await call(method, params, options);
      } catch (error) {
        compare(judged, method, params[0], error instanceof PearlRpcError && error.kind === 'rpc' ? error.message : 'not answered');
        throw error;
      }
      compare(judged, method, params[0], null);
      return result;
    }
    if (method === 'testmempoolaccept' && Array.isArray(params[0])) {
      const hexes = params[0] as unknown[];
      const judged: Awaited<ReturnType<typeof judge>>[] = [];
      for (const hex of hexes) judged.push(await judge(hex));
      const results = await call<{ allowed?: boolean; 'reject-reason'?: string }[]>(method, params, options);
      results.forEach((result, i) => compare(judged[i]!, method, hexes[i], result.allowed === true ? null : (result['reject-reason'] ?? '')));
      return results;
    }
    return call(method, params, options);
  }) as PearldClient['call'];
}
if (live !== null) hookInterpreter(pearld);

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
