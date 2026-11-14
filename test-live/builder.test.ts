// The payment builder against a regtest pearld: payFromAccount for key-path
// coins with change, a send-max, a signalling payment that is then replaced,
// P2MR checksig coins alone and next to a key path, the amounts in
// InsufficientFundsError, and coinbase maturity at its boundary. Each
// payment's vsize and fee are compared with testmempoolaccept before it is
// mined.

import { beforeAll, expect, it } from 'vitest';
import {
  assembleScriptTree,
  buildPayment,
  checkReplacement,
  checksigScript,
  COINBASE_MATURITY,
  deriveSigningAccountFromSeed,
  feeForVsize,
  InsufficientFundsError,
  MAX_RBF_SEQUENCE,
  minRelayFee,
  mnemonicToSeed,
  p2mr,
  parseBlock,
  payFromAccount,
  signalsReplacement,
  spendableUtxos,
  toOutputScript,
  transactionId,
} from '../src/index.js';
import type { AccountUtxo, ScriptTree, SignedPayment, Transaction } from '../src/index.js';
import { broadcast, confirm, describeLive, FEE_RATE, fund, mine, miner, minerScript, network, pearld, testMempoolAccept } from './chain.js';

const account = deriveSigningAccountFromSeed(
  mnemonicToSeed('letter advice cage absurd amount doctor acoustic avoid letter advice cage above'),
  network,
);
const recipient = miner.deriveAddress(300);
const change = account.deriveAddress(0, true);

const keyScript = (index: number): Uint8Array => toOutputScript(account.deriveAddress(index), network);
const leafTree = (index: number): ScriptTree => assembleScriptTree([checksigScript(account.derivePublicKey(index))]);

/** The outputs of a confirmed funding transaction as the account's unspent outputs, by child index. */
function utxosOf(funding: Transaction, children: readonly (number | { index: number; tree: ScriptTree })[]): AccountUtxo[] {
  return children.map((child, vout) => ({
    txid: funding.getId(),
    vout,
    value: funding.outs[vout]!.value,
    script: funding.outs[vout]!.script,
    confirmations: 1,
    ...(typeof child === 'number' ? { index: child } : { index: child.index, p2mr: { tree: child.tree, leafIndex: 0 } }),
  }));
}

/** testmempoolaccept must report the payment's own vsize and fee. */
async function expectAccepted(payment: SignedPayment<AccountUtxo>): Promise<void> {
  expect(await testMempoolAccept(payment.transaction)).toMatchObject({
    allowed: true,
    vsize: payment.vsize,
    fees: { base: payment.fee },
  });
}

describeLive('payment builder', () => {
  let funding: Transaction;
  let coins: AccountUtxo[];
  beforeAll(async () => {
    funding = await fund([
      { script: keyScript(0), value: 50_000_000n },
      { script: keyScript(1), value: 30_000_000n },
      { script: keyScript(2), value: 20_000_000n },
    ]);
    coins = utxosOf(funding, [0, 1, 2]);
  });

  it('pays from the two largest key-path coins with change, at the fee and vsize pearld reports', async () => {
    const payment = payFromAccount(account, {
      network,
      utxos: coins,
      recipients: [{ address: recipient, amount: 60_000_000n }],
      feeRate: FEE_RATE,
      changeAddress: change,
    });
    expect(payment.inputs.map((utxo) => utxo.index)).toEqual([0, 1]);
    expect(payment.changeIndex).toBe(1);
    expect(payment.change).toBe(80_000_000n - 60_000_000n - payment.fee);
    // Oyster's size estimate is a vbyte or so above the real size, never under.
    expect(payment.fee).toBeGreaterThanOrEqual(feeForVsize(payment.vsize, FEE_RATE));
    expect(payment.fee).toBeLessThan(feeForVsize(payment.vsize + 4, FEE_RATE));
    await expectAccepted(payment);

    expect(await pearld.sendRawTransaction(payment.hex)).toBe(payment.txid);
    const info = await confirm(payment.transaction);
    expect(info).toMatchObject({ version: 1, vsize: payment.vsize });
    expect(info.vout.map((out) => [out.scriptPubKey.address, out.value])).toEqual([
      [recipient, 60_000_000n],
      [change, payment.change],
    ]);
    coins = [
      coins[2]!,
      { txid: payment.txid, vout: 1, value: payment.change, script: payment.transaction.outs[1]!.script, confirmations: 1, index: 0, change: true },
    ];
  });

  it('sends the maximum: every coin in, one output, nothing left but the fee', async () => {
    const total = coins.reduce((sum, utxo) => sum + utxo.value, 0n);
    const payment = payFromAccount(account, {
      network,
      utxos: coins,
      recipients: [{ address: account.deriveAddress(3), amount: 'max' }],
      feeRate: FEE_RATE,
    });
    expect(payment.inputs).toHaveLength(2);
    expect(payment.transaction.outs).toHaveLength(1);
    expect(payment.changeIndex).toBe(-1);
    expect(payment.transaction.outs[0]!.value).toBe(total - payment.fee);
    await expectAccepted(payment);
    await broadcast(payment.transaction);
    await confirm(payment.transaction);
    for (const utxo of coins) expect(await pearld.getTxOut(utxo.txid, utxo.vout)).toBeNull();
    coins = [{ txid: payment.txid, vout: 0, value: total - payment.fee, script: keyScript(3), confirmations: 1, index: 3 }];
  });

  it('signals replacement with rbf, and a second payment of the same coin at a higher rate replaces it', async () => {
    const options = { network, utxos: coins, changeAddress: change, rbf: true };
    const original = payFromAccount(account, { ...options, recipients: [{ address: recipient, amount: 1_000_000n }], feeRate: FEE_RATE });
    expect(original.transaction.ins.map((input) => input.sequence)).toEqual([MAX_RBF_SEQUENCE]);
    expect(signalsReplacement(original.transaction)).toBe(true);
    await expectAccepted(original);
    await broadcast(original.transaction);

    const replacement = payFromAccount(account, {
      ...options,
      recipients: [{ address: recipient, amount: 2_000_000n }],
      feeRate: 3n * FEE_RATE,
    });
    const pool = new Map([[original.txid, { tx: original.transaction, fee: original.fee }]]);
    expect(checkReplacement(replacement.transaction, replacement.fee, pool)).toEqual([original.txid]);
    await expectAccepted(replacement);
    await broadcast(replacement.transaction);
    expect(await pearld.getRawMempool()).toEqual([replacement.txid]);
    await confirm(replacement.transaction);
    coins = [
      { txid: replacement.txid, vout: 1, value: replacement.change, script: toOutputScript(change, network), confirmations: 1, index: 0, change: true },
    ];
  });

  it('pays from P2MR checksig coins alone, with their previous transaction attached', async () => {
    const trees = [10, 11].map(leafTree);
    const p2mrFunding = await fund(trees.map((tree) => ({ script: p2mr({ merkleRoot: tree.root }).output, value: 15_000_000n })));
    const payment = payFromAccount(account, {
      network,
      utxos: utxosOf(p2mrFunding, [
        { index: 10, tree: trees[0]! },
        { index: 11, tree: trees[1]! },
      ]),
      recipients: [{ address: recipient, amount: 20_000_000n }],
      feeRate: FEE_RATE,
      changeAddress: change,
      previousTransactions: [p2mrFunding],
    });
    expect(payment.inputs).toHaveLength(2);
    // sig, leaf script, one-byte control block.
    for (const input of payment.transaction.ins) expect(input.witness.map((item) => item.length)).toEqual([64, 34, 1]);
    // A leaf spend is larger than Oyster's key-path allowance, so the fee is for the real size.
    expect(payment.fee).toBe(minRelayFee(payment.vsize, FEE_RATE));
    await expectAccepted(payment);
    await broadcast(payment.transaction);
    expect((await confirm(payment.transaction)).vsize).toBe(payment.vsize);
  });

  it('pays from a P2MR coin and a key-path coin in one transaction', async () => {
    const tree = leafTree(12);
    const mixedFunding = await fund([
      { script: p2mr({ merkleRoot: tree.root }).output, value: 15_000_000n },
      { script: keyScript(13), value: 14_000_000n },
    ]);
    const payment = payFromAccount(account, {
      network,
      utxos: utxosOf(mixedFunding, [{ index: 12, tree }, 13]),
      recipients: [{ address: recipient, amount: 25_000_000n }],
      feeRate: FEE_RATE,
      changeAddress: change,
      previousTransactions: [mixedFunding],
    });
    expect(payment.transaction.ins.map((input) => input.witness.length)).toEqual([3, 1]);
    expect(payment.fee).toBe(minRelayFee(payment.vsize, FEE_RATE));
    await expectAccepted(payment);
    await broadcast(payment.transaction);
    expect((await confirm(payment.transaction)).vsize).toBe(payment.vsize);
  });

  it('reports what is missing in InsufficientFundsError, and pearld takes a payment of exactly what it says is there', async () => {
    const [coin] = coins;
    const options = { network, utxos: coins, feeRate: FEE_RATE, changeAddress: change };
    const error = (() => {
      try {
        payFromAccount(account, { ...options, recipients: [{ address: recipient, amount: coin!.value }] });
      } catch (err) {
        return err;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(InsufficientFundsError);
    const short = error as InsufficientFundsError;
    expect(short.available).toBe(coin!.value);
    expect(short.required).toBe(coin!.value + short.fee);
    expect(short.missing).toBe(short.fee);

    // One grain more than the fee leaves is still short, by that grain.
    expect(() =>
      payFromAccount(account, { ...options, recipients: [{ address: recipient, amount: coin!.value - short.fee + 1n }] }),
    ).toThrowError(expect.objectContaining({ name: 'InsufficientFundsError', missing: 1n }));
    const exact = payFromAccount(account, { ...options, recipients: [{ address: recipient, amount: coin!.value - short.fee }] });
    expect(exact).toMatchObject({ fee: short.fee, change: 0n, changeIndex: -1 });
    await expectAccepted(exact);

    // An unconfirmed coin is not offered, and the error says one was left out.
    const unconfirmed = { ...coin!, txid: 'ab'.repeat(32), confirmations: 0 };
    expect(() =>
      payFromAccount(account, { ...options, utxos: [coin!, unconfirmed], recipients: [{ address: recipient, amount: coin!.value }] }),
    ).toThrow('1 unspent outputs were left out as unconfirmed, immature or empty');
  });

  it('holds a coinbase back at 99 confirmations, as pearld does, and spends it at 100', async () => {
    const tip = await pearld.getBlockCount();
    const height = tip - (COINBASE_MATURITY - 2);
    const block = parseBlock(await pearld.getRawBlock(await pearld.getBlockHash(height)));
    const coinbase = block.transactions[0]!;
    const vout = coinbase.outs.findIndex((out) => Buffer.from(out.script).equals(minerScript));
    const txid = transactionId(coinbase);
    const utxo = (confirmations: number): AccountUtxo => ({
      txid,
      vout,
      value: coinbase.outs[vout]!.value,
      script: minerScript,
      confirmations,
      coinbase: true,
      index: 0,
    });
    const options = { network, recipients: [{ address: recipient, amount: 'max' as const }], feeRate: FEE_RATE };

    expect((await pearld.getTxOut(txid, vout))!.confirmations).toBe(COINBASE_MATURITY - 1);
    const young = utxo(COINBASE_MATURITY - 1);
    expect(spendableUtxos([young])).toEqual([]);
    expect(() => payFromAccount(miner, { ...options, utxos: [young] })).toThrow(InsufficientFundsError);
    // Built anyway, pearld refuses it for the same reason.
    const early = payFromAccount(miner, { ...options, utxos: [young], coinbaseMaturity: COINBASE_MATURITY - 1 });
    expect(await testMempoolAccept(early.transaction)).toMatchObject({
      allowed: false,
      'reject-reason': `tried to spend coinbase transaction output ${txid}:${vout} from height ${height} at height ${tip + 1} before required maturity of ${COINBASE_MATURITY} blocks`,
    });

    await mine(1);
    expect((await pearld.getTxOut(txid, vout))!.confirmations).toBe(COINBASE_MATURITY);
    const mature = utxo(COINBASE_MATURITY);
    expect(spendableUtxos([mature])).toEqual([mature]);
    const payment = payFromAccount(miner, { ...options, utxos: [mature] });
    expect(payment.txid).toBe(early.txid);
    await expectAccepted(payment);
    await broadcast(payment.transaction);
    await confirm(payment.transaction);
  });

  it('refuses to build what pearld would not relay: a fee rate under the relay minimum', () => {
    expect(() =>
      buildPayment({ network, utxos: coins, recipients: [{ address: recipient, amount: 1_000_000n }], feeRate: 500n, changeAddress: change }),
    ).toThrow(/under the \d+ grain pearld requires to relay/);
  });
});
