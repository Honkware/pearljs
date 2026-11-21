// pearljs's wallet code beside a running Oyster: buildPayment fed Oyster's
// own listunspent picks the inputs, fee and change Oyster's sendtoaddress
// picks at the same rate; inspectTransaction reads what Oyster built;
// sweepWif empties a key Oyster imported; and Oyster has no way to hold a
// P2MR coin, so its key-path pricing of P2MR inputs is never reached.

import { randomBytes } from 'node:crypto';
import { beforeAll, expect, it } from 'vitest';
import {
  assembleScriptTree,
  buildPayment,
  checksigScript,
  deriveSigningAccountFromSeed,
  encodeWif,
  fromOutputScript,
  inspectTransaction,
  keyPathAddress,
  mnemonicToSeed,
  p2mr,
  parseTransaction,
  PearlRpcError,
  sweepWif,
  toOutputScript,
} from '../../src/index.js';
import type { ListUnspentResult, Utxo } from '../../src/index.js';
import { OYSTER_MNEMONIC, OYSTER_PASSPHRASE } from './context.js';
import { confirm, describeOyster, eventually, fund, miner, network, oyster, pearld, spentOutputs, testMempoolAccept } from './chain.js';

const recipient = miner.deriveAddress(400);
const outpoint = (utxo: { txid: string; vout: number }): string => `${utxo.txid}:${utxo.vout}`;
const asUtxo = (unspent: ListUnspentResult): Utxo => ({
  txid: unspent.txid,
  vout: unspent.vout,
  value: unspent.amount,
  script: Buffer.from(unspent.scriptPubKey, 'hex'),
  confirmations: unspent.confirmations,
});

/** What Oyster would send from: confirmed outputs of its default account. */
async function spendable(): Promise<ListUnspentResult[]> {
  return (await oyster.listUnspent()).filter((unspent) => unspent.account === 'default');
}

/** Waits until Oyster has seen pearld's tip, mempool left behind. */
async function synced(): Promise<void> {
  const tip = await pearld.getBlockCount();
  expect(await eventually(() => oyster.call<number>('getblockcount'), (height) => height === tip)).toBe(tip);
  expect(await eventually(() => oyster.getUnconfirmedBalance(), (balance) => balance === 0n)).toBe(0n);
}

describeOyster('Oyster parity', () => {
  beforeAll(async () => {
    await oyster.walletPassphrase(OYSTER_PASSPHRASE, 3600);
    const values = [70_000_000n, 50_000_000n, 30_000_000n, 11_000_000n, 7_000_000n];
    const outputs = [];
    for (const value of values) outputs.push({ script: toOutputScript(await oyster.getNewAddress(), network), value });
    await fund(outputs);
    await synced();
  });

  /** Sends with Oyster and checks pearljs chose the same inputs, fee and change from the same unspent outputs. */
  async function expectSameSend(amount: bigint, feeRate: bigint): Promise<{ inputs: number; change: bigint }> {
    const unspent = await spendable();
    const predicted = buildPayment({
      network,
      utxos: unspent.map(asUtxo),
      recipients: [{ address: recipient, amount }],
      feeRate,
      // Any P2TR address: Oyster's change script has the same size.
      changeAddress: miner.deriveAddress(401),
    });
    const txid = await oyster.sendToAddress(recipient, amount, feeRate);
    const tx = parseTransaction(await pearld.getRawTransactionHex(txid));
    const prevouts = await spentOutputs(tx);
    const inspected = inspectTransaction(tx, prevouts, network);

    // Oyster adds inputs in the order it selected them.
    expect(inspected.inputs.map(outpoint)).toEqual(predicted.inputs.map(outpoint));
    expect(inspected.fee).toBe(predicted.fee);
    expect(inspected.vsize).toBe(predicted.vsize);
    // Oyster puts its change at a random position.
    expect(inspected.outputs.map((out) => out.value).sort()).toEqual(
      [amount, ...(predicted.change > 0n ? [predicted.change] : [])].sort(),
    );
    expect(inspected.outputs.find((out) => out.value === amount)!.address).toBe(recipient);

    // And inspectTransaction reads Oyster's transaction as pearld does.
    expect(inspected).toMatchObject({ txid, version: 1, locktime: 0, rbf: false });
    expect((await pearld.getRawMempoolVerbose())[txid]).toMatchObject({ fee: inspected.fee, vsize: inspected.vsize, size: inspected.size });
    const info = await pearld.getRawTransaction(txid);
    expect(info).toMatchObject({ hash: inspected.wtxid, size: inspected.size, vsize: inspected.vsize });
    for (const input of inspected.inputs) expect(input.spend).toEqual({ type: 'keyPath', sighashType: 0 });
    expect(inspected.inputs.map((input) => input.address)).toEqual(
      predicted.inputs.map((utxo) => fromOutputScript(utxo.script, network)),
    );
    expect(info.vout.map((out) => out.scriptPubKey.address)).toEqual(inspected.outputs.map((out) => out.address));

    await confirm(tx);
    await synced();
    return { inputs: tx.ins.length, change: predicted.change };
  }

  it('picks the one input and the fee Oyster picks for a small payment', async () => {
    expect(await expectSameSend(5_000_000n, 2000n)).toMatchObject({ inputs: 1 });
  });

  it('picks the same several inputs, largest first, at the relay minimum', async () => {
    const unspent = await spendable();
    const largest = unspent.map((utxo) => utxo.amount).sort((a, b) => (a > b ? -1 : 1));
    const { inputs } = await expectSameSend(largest[0]! + largest[1]! + 1_000_000n, 1000n);
    expect(inputs).toBe(3);
  });

  it('gives a dust remainder to the fee, as Oyster does', async () => {
    const unspent = await spendable();
    const largest = unspent.reduce((max, utxo) => (utxo.amount > max ? utxo.amount : max), 0n);
    const feeRate = 12_345n;
    const withChange = buildPayment({
      network,
      utxos: unspent.map(asUtxo),
      recipients: [{ address: recipient, amount: largest / 2n }],
      feeRate,
      changeAddress: miner.deriveAddress(401),
    });
    expect(withChange.inputs).toHaveLength(1);
    // 200 grain over the fee would be change, and 200 grain is dust.
    expect(await expectSameSend(largest - withChange.fee - 200n, feeRate)).toEqual({ inputs: 1, change: 0n });
  });

  it('never lists a P2MR coin, so Oyster cannot be made to spend one', async () => {
    const account = deriveSigningAccountFromSeed(mnemonicToSeed(OYSTER_MNEMONIC), network);
    // A P2MR output whose only leaf checks a key the wallet holds.
    const tree = assembleScriptTree([checksigScript(account.derivePublicKey(0))]);
    const { output } = p2mr({ merkleRoot: tree.root });
    const address = fromOutputScript(output, network);
    const before = await spendable();
    const funding = await fund([{ script: output, value: 9_000_000n }]);
    await synced();
    expect((await oyster.listUnspent(0)).map(outpoint)).not.toContain(`${funding.getId()}:0`);
    expect((await spendable()).map(outpoint)).toEqual(before.map(outpoint));
    // validateaddress leaves ismine out when it is false.
    expect(await oyster.call('validateaddress', [address])).toEqual({ isvalid: true, address });
    expect(await oyster.call('validateaddress', [account.deriveAddress(0)])).toMatchObject({ isvalid: true, ismine: true });
    const refused = await oyster.dumpPrivKey(address).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(PearlRpcError);
    // Oyster does pay to a P2MR address.
    const txid = await oyster.sendToAddress(address, 1_000_000n, 1000n);
    const tx = parseTransaction(await pearld.getRawTransactionHex(txid));
    expect(tx.outs.some((out) => Buffer.from(out.script).equals(output))).toBe(true);
    await confirm(tx);
    await synced();
    expect((await oyster.listUnspent(0)).some((unspent) => unspent.scriptPubKey === Buffer.from(output).toString('hex'))).toBe(false);
  });

  it('sweeps a key Oyster imported, from the WIF Oyster dumps and the outputs Oyster lists', async () => {
    const key = Uint8Array.from(randomBytes(32));
    const address = keyPathAddress(key, network);
    await oyster.importPrivKey(encodeWif(key, network), false);
    const script = toOutputScript(address, network);
    await fund([
      { script, value: 4_000_000n },
      { script, value: 6_000_000n },
    ]);
    await synced();
    const listed = (await oyster.listUnspent()).filter((unspent) => unspent.address === address);
    expect(listed.map((unspent) => [unspent.account, unspent.amount]).sort()).toEqual([
      ['imported', 4_000_000n],
      ['imported', 6_000_000n],
    ]);

    const destination = await oyster.getNewAddress();
    const sweep = sweepWif(await oyster.dumpPrivKey(address), {
      network,
      utxos: listed.map(asUtxo),
      destination,
      feeRate: 2000n,
    });
    expect(sweep.transaction.ins).toHaveLength(2);
    expect(sweep.transaction.outs.map((out) => out.value)).toEqual([10_000_000n - sweep.fee]);
    expect(await testMempoolAccept(sweep.transaction)).toMatchObject({ allowed: true, vsize: sweep.vsize, fees: { base: sweep.fee } });
    expect(await pearld.sendRawTransaction(sweep.hex)).toBe(sweep.txid);
    await confirm(sweep.transaction);
    await synced();
    const after = await oyster.listUnspent();
    expect(after.filter((unspent) => unspent.address === address)).toEqual([]);
    expect(after.find((unspent) => unspent.txid === sweep.txid)).toMatchObject({
      address: destination,
      account: 'default',
      amount: 10_000_000n - sweep.fee,
    });
  });
});
