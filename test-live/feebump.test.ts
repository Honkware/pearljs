// The rest of pearld's replacement and package rules against rbf.ts:
// signalling inherited from an unconfirmed parent, a replacement that brings
// a new unconfirmed input or spends what it replaces, the cap of 100
// evictions, a chain of 25, a parent with 24 children and ancestors of
// 101000 vbytes at the package limits, a node started with
// --rejectreplacement, and the order of pearld's block template when a
// low-fee parent has a high-fee child.

import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import {
  checkPackageLimits,
  checkReplacement,
  cpfpChildFee,
  createPsbt,
  createTransaction,
  DEFAULT_ANCESTOR_COUNT_LIMIT,
  DEFAULT_ANCESTOR_SIZE_LIMIT,
  DEFAULT_DESCENDANT_COUNT_LIMIT,
  deriveSigningAccountFromSeed,
  feeForVsize,
  finalizePsbt,
  MAX_RBF_SEQUENCE,
  MAX_REPLACEMENT_EVICTIONS,
  minRelayFee,
  mnemonicToSeed,
  OP_CODES,
  packageFeeRate,
  parseBlock,
  PolicyError,
  replacementFee,
  serializeTransaction,
  signalsReplacement,
  toOutputScript,
  transactionId,
} from '../src/index.js';
import type { MempoolTx, PearldClient, PearlErrorCode, Transaction } from '../src/index.js';
import { broadcast, describeLive, FEE_RATE, fund, live, mine, miner, network, pearld, testMempoolAccept } from './chain.js';
import { startPearld, type RunningPearld } from './processes.js';

const account = deriveSigningAccountFromSeed(
  mnemonicToSeed('scheme spot photo card baby mountain device kick cradle pact join borrow'),
  network,
);
const VALUE = 10_000_000n;

/** An output of the account, confirmed or not. */
interface Coin {
  hash: Uint8Array;
  txid: string;
  vout: number;
  value: bigint;
  index: number;
}

interface Built extends MempoolTx {
  txid: string;
  vsize: number;
  coins: Coin[];
}

let nextIndex = 0;

/** Confirmed coins of VALUE each, from one funding transaction. */
async function coins(count: number): Promise<Coin[]> {
  const indices = Array.from({ length: count }, () => nextIndex++);
  const funding = await fund(indices.map((index) => ({ script: toOutputScript(account.deriveAddress(index), network), value: VALUE })));
  return indices.map((index, vout) => ({ hash: funding.getHash(), txid: funding.getId(), vout, value: VALUE, index }));
}

/** Spends the coins into equal outputs of the account, leaving exactly fee. */
function spend(inputs: readonly Coin[], fee: bigint, options: { sequence?: number; outputs?: number; padding?: number } = {}): Built {
  const count = options.outputs ?? 1;
  const total = inputs.reduce((sum, coin) => sum + coin.value, 0n) - fee;
  const tx = createTransaction(2);
  for (const coin of inputs) tx.addInput(coin.hash, coin.vout, options.sequence);
  const outputs = Array.from({ length: count }, (_, i) => ({
    index: nextIndex++,
    value: total / BigInt(count) + (i === 0 ? total % BigInt(count) : 0n),
  }));
  for (const output of outputs) tx.addOutput(toOutputScript(account.deriveAddress(output.index), network), output.value);
  // An OP_RETURN of that many bytes after the account's outputs, to make the transaction as large as a test needs.
  if (options.padding !== undefined) {
    const push = Uint8Array.of(OP_CODES.OP_RETURN, OP_CODES.OP_PUSHDATA2, options.padding & 0xff, options.padding >> 8);
    tx.addOutput(Uint8Array.from([...push, ...new Uint8Array(options.padding)]), 0n);
  }
  const psbt = createPsbt(tx);
  inputs.forEach((coin, i) => account.prepareInput(psbt, i, { index: coin.index, value: coin.value }));
  inputs.forEach((coin, i) => account.signInput(psbt, i, { index: coin.index }));
  const signed = finalizePsbt(psbt);
  return {
    tx: signed,
    fee,
    txid: signed.getId(),
    vsize: signed.virtualSize(),
    coins: outputs.map((output, vout) => ({ hash: signed.getHash(), txid: signed.getId(), vout, ...output })),
  };
}

/** The size spend() will produce, to price a fee before building. */
const vsizeOf = (inputs: readonly Coin[], outputs = 1): number => spend(inputs, 1000n, { outputs }).vsize;
const atRate = (inputs: readonly Coin[], rate = FEE_RATE): bigint => feeForVsize(vsizeOf(inputs), rate);
const poolOf = (...entries: Built[]): Map<string, MempoolTx> => new Map(entries.map((entry) => [entry.txid, entry]));

/** The reason pearljs predicts, which the node's testmempoolaccept must give word for word. */
async function expectSameRefusal(code: PearlErrorCode, predict: () => unknown, tx: Transaction, node: PearldClient = pearld): Promise<string> {
  let predicted = '';
  try {
    predict();
  } catch (error) {
    expect(error).toBeInstanceOf(PolicyError);
    expect((error as PolicyError).code).toBe(code);
    predicted = (error as Error).message;
  }
  expect(predicted).not.toBe('');
  const [result] = await node.testMempoolAccept([serializeTransaction(tx)]);
  expect(result).toMatchObject({ allowed: false, 'reject-reason': predicted });
  return predicted;
}

async function expectMempool(...txids: string[]): Promise<void> {
  expect((await pearld.getRawMempool()).sort()).toEqual([...txids].sort());
}

describeLive('fee bumping', () => {
  let second: RunningPearld | undefined;
  afterAll(async () => {
    await second?.stop();
  });

  it('replaces a child that signals only through its unconfirmed parent', async () => {
    const [a] = await coins(1);
    const parent = spend([a!], atRate([a!]), { sequence: MAX_RBF_SEQUENCE });
    await broadcast(parent.tx);
    const child = spend(parent.coins, atRate(parent.coins));
    await broadcast(child.tx);
    const pool = poolOf(parent, child);
    expect(signalsReplacement(child.tx)).toBe(false);
    expect(signalsReplacement(child.tx, pool)).toBe(true);

    const needed = replacementFee([child], child.vsize);
    const underpaid = spend(parent.coins, needed - 1n);
    expect(await expectSameRefusal('RBF_FEE_TOO_LOW', () => checkReplacement(underpaid.tx, underpaid.fee, pool), underpaid.tx)).toBe(
      `${underpaid.txid}: replacement transaction has an insufficient absolute fee: needs ${needed}, has ${needed - 1n}`,
    );
    const replacement = spend(parent.coins, needed);
    expect(checkReplacement(replacement.tx, needed, pool)).toEqual([child.txid]);
    expect(await testMempoolAccept(replacement.tx)).toMatchObject({ allowed: true, fees: { base: needed } });
    await broadcast(replacement.tx);
    await expectMempool(parent.txid, replacement.txid);
    await mine(1);
    await expectMempool();
  });

  it('refuses a replacement that spends another unconfirmed output, or an output of what it replaces', async () => {
    const [a, b, c] = await coins(3);
    const original = spend([a!], atRate([a!]), { sequence: MAX_RBF_SEQUENCE });
    const unrelated = spend([b!], atRate([b!]));
    await broadcast(original.tx);
    await broadcast(unrelated.tx);
    const pool = poolOf(original, unrelated);

    const withNew = spend([a!, unrelated.coins[0]!], 100n * original.fee);
    expect(await expectSameRefusal('RBF_NEW_UNCONFIRMED_INPUT', () => checkReplacement(withNew.tx, withNew.fee, pool), withNew.tx)).toBe(
      `replacement transaction spends new unconfirmed input ${unrelated.txid}:0 not found in conflicting transactions`,
    );
    const ownParent = spend([a!, original.coins[0]!], 100n * original.fee);
    expect(await expectSameRefusal('RBF_SPENDS_CONFLICT', () => checkReplacement(ownParent.tx, ownParent.fee, pool), ownParent.tx)).toBe(
      `${ownParent.txid}: replacement transaction spends parent transaction ${original.txid}`,
    );
    // A second input that is confirmed is no obstacle.
    const fine = spend([a!, c!], replacementFee([original], vsizeOf([a!, c!])));
    expect(checkReplacement(fine.tx, fine.fee, pool)).toEqual([original.txid]);
    await broadcast(fine.tx);
    await expectMempool(unrelated.txid, fine.txid);
    await mine(1);
  });

  it('refuses a replacement that would evict 101 transactions and takes one that evicts 100', async () => {
    const confirmed = await coins(MAX_REPLACEMENT_EVICTIONS + 1);
    const originals = confirmed.map((coin) => spend([coin], atRate([coin]), { sequence: MAX_RBF_SEQUENCE }));
    for (const original of originals) await broadcast(original.tx);
    const pool = poolOf(...originals);

    const tooMany = spend(confirmed, 100n * originals.reduce((sum, entry) => sum + entry.fee, 0n));
    expect(await expectSameRefusal('RBF_TOO_MANY_EVICTIONS', () => checkReplacement(tooMany.tx, tooMany.fee, pool), tooMany.tx)).toContain(
      `replacement transaction evicts more transactions than permitted: max is ${MAX_REPLACEMENT_EVICTIONS}`,
    );

    const hundred = confirmed.slice(0, MAX_REPLACEMENT_EVICTIONS);
    const evicted = originals.slice(0, MAX_REPLACEMENT_EVICTIONS);
    const needed = replacementFee(evicted, vsizeOf(hundred));
    expect(needed).toBe(evicted.reduce((sum, entry) => sum + entry.fee, 0n) + minRelayFee(vsizeOf(hundred)));
    const underpaid = spend(hundred, needed - 1n);
    await expectSameRefusal('RBF_FEE_TOO_LOW', () => checkReplacement(underpaid.tx, underpaid.fee, pool), underpaid.tx);
    const replacement = spend(hundred, needed);
    expect(checkReplacement(replacement.tx, needed, pool)).toEqual(evicted.map((entry) => entry.txid));
    await broadcast(replacement.tx);
    await expectMempool(originals[MAX_REPLACEMENT_EVICTIONS]!.txid, replacement.txid);
    await mine(1);
    await expectMempool();
  });

  it('takes a chain of 25 unconfirmed transactions and refuses the 26th, then mines the 25 in one block', async () => {
    const [a] = await coins(1);
    const chain: Built[] = [];
    let tip = [a!];
    for (let i = 0; i < DEFAULT_ANCESTOR_COUNT_LIMIT; i++) {
      const next = spend(tip, atRate(tip));
      checkPackageLimits(next.tx, poolOf(...chain));
      await broadcast(next.tx);
      chain.push(next);
      tip = next.coins;
    }
    const extra = spend(tip, atRate(tip));
    expect(await expectSameRefusal('PACKAGE_TOO_LONG', () => checkPackageLimits(extra.tx, poolOf(...chain)), extra.tx)).toBe(
      `too-long-mempool-chain: too many unconfirmed ancestors, ${DEFAULT_ANCESTOR_COUNT_LIMIT} [limit: ${DEFAULT_ANCESTOR_COUNT_LIMIT}]`,
    );
    await expectMempool(...chain.map((entry) => entry.txid));

    const [blockHash] = await mine(1);
    const block = parseBlock(await pearld.getRawBlock(blockHash!));
    // Every fee rate is the same, so only the dependencies order the block.
    expect(block.transactions.slice(1).map(transactionId)).toEqual(chain.map((entry) => entry.txid));
    // What was one too many a block ago is fine now.
    checkPackageLimits(extra.tx, poolOf());
    await broadcast(extra.tx);
    await mine(1);
  });

  it('takes a child that brings its unconfirmed ancestors to exactly 101000 vbytes and refuses one vbyte more', async () => {
    const [a] = await coins(1);
    const sized = (inputs: readonly Coin[], vsize: number): Built => {
      const padding = 1000 + vsize - spend(inputs, 1000n, { padding: 1000 }).vsize;
      const built = spend(inputs, feeForVsize(vsize, FEE_RATE), { padding });
      expect(built.vsize).toBe(vsize);
      return built;
    };
    // Two ancestors of 40000 vbytes each, in a chain.
    const first = sized([a!], 40_000);
    const second = sized(first.coins, 40_000);
    for (const built of [first, second]) await broadcast(built.tx);
    const pool = poolOf(first, second);

    const over = sized(second.coins, DEFAULT_ANCESTOR_SIZE_LIMIT - 80_000 + 1);
    expect(await expectSameRefusal('PACKAGE_TOO_LONG', () => checkPackageLimits(over.tx, pool), over.tx)).toBe(
      `too-long-mempool-chain: exceeds ancestor size limit, ${DEFAULT_ANCESTOR_SIZE_LIMIT + 1} vbytes [limit: ${DEFAULT_ANCESTOR_SIZE_LIMIT}]`,
    );
    const exact = sized(second.coins, DEFAULT_ANCESTOR_SIZE_LIMIT - 80_000);
    checkPackageLimits(exact.tx, pool);
    await broadcast(exact.tx);
    await expectMempool(first.txid, second.txid, exact.txid);
    await mine(1);
    await expectMempool();
  });

  it('takes 24 children of one unconfirmed parent and refuses the 25th', async () => {
    const [a] = await coins(1);
    const parent = spend([a!], feeForVsize(vsizeOf([a!], DEFAULT_DESCENDANT_COUNT_LIMIT), FEE_RATE), {
      outputs: DEFAULT_DESCENDANT_COUNT_LIMIT,
    });
    await broadcast(parent.tx);
    const pool: Built[] = [parent];
    for (const coin of parent.coins.slice(0, DEFAULT_DESCENDANT_COUNT_LIMIT - 1)) {
      const child = spend([coin], atRate([coin]));
      checkPackageLimits(child.tx, poolOf(...pool));
      await broadcast(child.tx);
      pool.push(child);
    }
    const last = parent.coins[DEFAULT_DESCENDANT_COUNT_LIMIT - 1]!;
    const extra = spend([last], atRate([last]));
    expect(await expectSameRefusal('PACKAGE_TOO_LONG', () => checkPackageLimits(extra.tx, poolOf(...pool)), extra.tx)).toBe(
      `too-long-mempool-chain: too many descendants for tx ${parent.txid} [limit: ${DEFAULT_DESCENDANT_COUNT_LIMIT}]`,
    );
    await mine(1);
    await expectMempool();
  });

  it('orders its block template by the fee rate of each transaction alone, so a high-fee child does not lift its parent', async () => {
    const [a, b] = await coins(2);
    const parent = spend([a!], minRelayFee(vsizeOf([a!])));
    const childVsize = vsizeOf(parent.coins);
    const child = spend(parent.coins, cpfpChildFee([parent], childVsize, 20n * FEE_RATE));
    const middle = spend([b!], atRate([b!], 5n * FEE_RATE));
    const rate = (entry: Built): bigint => packageFeeRate([entry]);
    // Together the parent and child pay more than the transaction in the middle.
    expect(packageFeeRate([parent, child])).toBeGreaterThanOrEqual(20n * FEE_RATE);
    expect(rate(child)).toBeGreaterThan(rate(middle));
    expect(rate(middle)).toBeGreaterThan(rate(parent));
    for (const entry of [parent, child, middle]) await broadcast(entry.tx);

    const template = await pearld.getBlockTemplate();
    // A miner scoring by ancestor package would put parent and child first.
    expect(template.transactions.map((tx) => tx.txid)).toEqual([middle.txid, parent.txid, child.txid]);
    expect(template.transactions.map((tx) => tx.depends)).toEqual([[], [], [2]]);
    expect(template.transactions.map((tx) => tx.fee)).toEqual([middle.fee, parent.fee, child.fee]);
    const [blockHash] = await mine(1);
    const block = parseBlock(await pearld.getRawBlock(blockHash!));
    expect(block.transactions.slice(1).map(transactionId)).toEqual([middle.txid, parent.txid, child.txid]);
  });

  it('gets no replacement into a pearld started with --rejectreplacement', async () => {
    const [a] = await coins(1);
    second = await startPearld({
      exe: process.env.PEARLD!,
      dir: join(live!.dir, 'pearld-rejectreplacement'),
      miningAddress: miner.deriveAddress(1),
      extraArgs: ['--rejectreplacement'],
    });
    const other = second.client;
    await other.call('node', ['connect', live!.p2p, 'temp']);
    const deadline = Date.now() + 300_000;
    while ((await other.getBestBlockHash()) !== (await pearld.getBestBlockHash())) {
      if (Date.now() > deadline) throw new Error('the second node did not sync');
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await other.call('node', ['disconnect', live!.p2p]);
    while ((await pearld.call<unknown[]>('getpeerinfo')).length > 0) await new Promise((resolve) => setTimeout(resolve, 250));

    const original = spend([a!], atRate([a!]), { sequence: MAX_RBF_SEQUENCE });
    const replacement = spend([a!], replacementFee([original], original.vsize));
    const pool = poolOf(original);
    expect(await other.sendRawTransaction(serializeTransaction(original.tx))).toBe(original.txid);
    expect(
      await expectSameRefusal('RBF_NOT_REPLACEABLE', () => checkReplacement(replacement.tx, replacement.fee, pool, { rejectReplacement: true }), replacement.tx, other),
    ).toBe(`output already spent in mempool: output=${a!.txid}:0, tx=${original.txid}`);
    expect(await other.getRawMempool()).toEqual([original.txid]);

    // The suite's node, started without the flag, takes the same replacement.
    await broadcast(original.tx);
    expect(checkReplacement(replacement.tx, replacement.fee, pool)).toEqual([original.txid]);
    await broadcast(replacement.tx);
    await expectMempool(replacement.txid);
    await mine(1);
  });
});
