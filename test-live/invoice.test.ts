// pearldChainClient and the invoice monitor against a regtest pearld running
// with --addrindex and --txindex: an invoice that is unpaid, underpaid, seen
// in the mempool, confirming, confirmed and overpaid, one that expires, and
// address activity spread over more searchrawtransactions pages than one.

import { beforeAll, expect, it } from 'vitest';
import {
  createPsbt,
  createTransaction,
  deriveSigningAccountFromSeed,
  finalizePsbt,
  InvoiceMonitor,
  mnemonicToSeed,
  parseBlock,
  pearldChainClient,
  toOutputScript,
  transactionId,
} from '../src/index.js';
import type { TxOutput, Transaction } from '../src/index.js';
import { addChange, broadcast, describeLive, fund, mine, network, pearld } from './chain.js';

const account = deriveSigningAccountFromSeed(mnemonicToSeed('zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong'), network);
const VALUE = 100_000_000n;
const PAYER_BASE = 130;
const PAYERS = 13;
const address = (index: number): string => account.deriveAddress(index);
const script = (index: number): Uint8Array => toOutputScript(address(index), network);

describeLive('invoices over pearld', () => {
  const chain = pearldChainClient(pearld);
  const monitor = new InvoiceMonitor(chain, network);
  let funding: Transaction;
  let nextPayer = 0;

  beforeAll(async () => {
    funding = await fund(Array.from({ length: PAYERS }, (_, i) => ({ script: script(PAYER_BASE + i), value: VALUE })));
  });

  /** Broadcasts a payment of outputs from the next unspent payer output. */
  async function pay(outputs: readonly TxOutput[]): Promise<Transaction> {
    const vout = nextPayer++;
    const tx = createTransaction(2);
    tx.addInput(funding.getHash(), vout);
    for (const output of outputs) tx.addOutput(output.script, output.value);
    addChange(tx, VALUE, [{ type: 'keyPath' }]);
    const psbt = createPsbt(tx);
    account.prepareInput(psbt, 0, { index: PAYER_BASE + vout, value: VALUE });
    account.signInput(psbt, 0, { index: PAYER_BASE + vout });
    const signed = finalizePsbt(psbt);
    await broadcast(signed);
    return signed;
  }

  it('reads the tip, known and unknown transactions, and an unused address', async () => {
    const info = await pearld.getBlockchainInfo();
    expect(await chain.getTip()).toEqual({ height: info.blocks, hash: info.bestblockhash });
    expect(await chain.getTransaction(funding.getId())).toEqual({
      txid: funding.getId(),
      block: { height: info.blocks, hash: info.bestblockhash },
    });
    expect(await chain.getTransaction('00'.repeat(32))).toBeNull();
    expect(await chain.getAddressActivity(address(160))).toEqual([]);
    await expect(chain.getAddressActivity('not an address')).rejects.toMatchObject({ kind: 'rpc', rpcCode: -5 });
  });

  it('follows an invoice from unpaid through the mempool to confirmed and overpaid', async () => {
    const config = { id: 'live-1', address: address(161), amount: 5_000_000n, createdAt: 1000, expiresAt: 2000, requiredConfirmations: 2 };
    let invoice = monitor.createInvoice(config);
    const refresh = async (): Promise<typeof invoice> => (invoice = await monitor.refreshInvoice(invoice, 1500));

    expect(await refresh()).toMatchObject({ state: 'awaiting', paidAmount: 0n, confirmations: 0, observedPayments: [] });

    const part = await pay([{ script: script(161), value: 2_000_000n }]);
    expect(await refresh()).toMatchObject({ state: 'awaiting', paidAmount: 2_000_000n, confirmations: 0 });
    expect(invoice.observedPayments).toEqual([{ txid: transactionId(part), firstSeenAt: 1500 }]);
    expect(await chain.getTransaction(transactionId(part))).toEqual({ txid: transactionId(part), block: null });

    const rest = await pay([{ script: script(161), value: 3_000_000n }]);
    expect(await refresh()).toMatchObject({ state: 'pending', paidAmount: 5_000_000n, confirmations: 0 });

    const [first] = await mine(1);
    expect(await refresh()).toMatchObject({ state: 'confirming', paidAmount: 5_000_000n, confirmations: 1 });
    const tip = await chain.getTip();
    expect(tip.hash).toBe(first);
    expect(await chain.getAddressActivity(address(161))).toEqual(
      expect.arrayContaining([
        { txid: transactionId(part), amount: 2_000_000n, block: tip },
        { txid: transactionId(rest), amount: 3_000_000n, block: tip },
      ]),
    );

    await mine(1);
    expect(await refresh()).toMatchObject({ state: 'confirmed', paidAmount: 5_000_000n, confirmations: 2 });

    // A further payment overpays; the invoice waits for it to confirm too.
    await pay([{ script: script(161), value: 1_000_000n }]);
    expect(await refresh()).toMatchObject({ state: 'pending', paidAmount: 6_000_000n, confirmations: 0 });
    await mine(2);
    expect(await refresh()).toMatchObject({ state: 'confirmed', paidAmount: 6_000_000n, confirmations: 2 });
    expect(invoice.observedPayments).toHaveLength(3);
  });

  it('expires an underpaid invoice and ignores a payment first seen after expiry', async () => {
    const config = { id: 'live-2', address: address(162), amount: 5_000_000n, createdAt: 1000, expiresAt: 2000, requiredConfirmations: 1 };
    let invoice = monitor.createInvoice(config);
    await pay([{ script: script(162), value: 4_999_999n }]);
    invoice = await monitor.refreshInvoice(invoice, 1999);
    expect(invoice).toMatchObject({ state: 'awaiting', paidAmount: 4_999_999n });
    await pay([{ script: script(162), value: 1_000_000n }]);
    invoice = await monitor.refreshInvoice(invoice, 2000);
    expect(invoice).toMatchObject({ state: 'expired', paidAmount: 4_999_999n });
    await mine(1);
  });

  it('finds every payment when an address has more transactions than one page, in the chain and the mempool', async () => {
    const target = script(163);
    const confirmed: Transaction[] = [];
    for (let i = 0; i < 4; i++) confirmed.push(await pay([{ script: target, value: BigInt(1_000_000 + i) }]));
    const [blockHash] = await mine(1);
    const block = { height: await pearld.getBlockCount(), hash: blockHash! };
    // The miner orders a block by fee, not by arrival, and the index follows the block.
    const blockOrder = parseBlock(await pearld.getRawBlock(blockHash!)).transactions.slice(1).map(transactionId);
    expect([...blockOrder].sort()).toEqual(confirmed.map(transactionId).sort());
    const unconfirmed: Transaction[] = [];
    // One of them pays the address twice, which is still one payment.
    unconfirmed.push(
      await pay([
        { script: target, value: 2_000_000n },
        { script: target, value: 500_000n },
      ]),
    );
    for (let i = 1; i < 4; i++) unconfirmed.push(await pay([{ script: target, value: BigInt(2_000_000 + i) }]));

    const expected = [
      ...confirmed.map((tx, i) => ({ txid: transactionId(tx), amount: BigInt(1_000_000 + i), block })),
      { txid: transactionId(unconfirmed[0]!), amount: 2_500_000n, block: null },
      ...unconfirmed.slice(1).map((tx, i) => ({ txid: transactionId(tx), amount: BigInt(2_000_001 + i), block: null })),
    ];
    const byTxid = (a: { txid: string }, b: { txid: string }): number => a.txid.localeCompare(b.txid);
    // pearld lists mempool transactions in a different order on every call,
    // so a client that pages through them blindly misses some now and then.
    for (let attempt = 0; attempt < 10; attempt++) {
      for (const pageSize of [1, 3, 100]) {
        const activity = await pearldChainClient(pearld, { pageSize }).getAddressActivity(address(163));
        expect([...activity].sort(byTxid)).toEqual([...expected].sort(byTxid));
      }
    }

    // The pages themselves: confirmed transactions in block order, then the mempool.
    const all = await pearld.searchRawTransactions(address(163));
    expect(all.slice(0, 4).map((tx) => tx.txid)).toEqual(blockOrder);
    expect(all.slice(4).map((tx) => tx.txid).sort()).toEqual(unconfirmed.map(transactionId).sort());
    const page = await pearld.searchRawTransactions(address(163), { skip: 1, count: 2 });
    expect(page.map((tx) => tx.txid)).toEqual(blockOrder.slice(1, 3));
    const newestFirst = await pearld.searchRawTransactions(address(163), { count: 6, reverse: true });
    expect(newestFirst.slice(4).map((tx) => tx.txid)).toEqual([blockOrder[3], blockOrder[2]]);

    const mined = all.find((tx) => tx.txid === transactionId(confirmed[0]!))!;
    expect(mined).toMatchObject({ blockhash: blockHash, confirmations: 1, version: 2, locktime: 0 });
    expect(mined.vin[0]).toMatchObject({ txid: funding.getId(), vout: 5 });
    expect(mined.vin[0]).not.toHaveProperty('prevOut');
    // vinExtra adds what each input spent.
    const [withPrevOut] = await pearld.searchRawTransactions(address(PAYER_BASE + 5), { skip: 1, count: 1, vinExtra: true });
    expect(withPrevOut).toMatchObject({
      txid: mined.txid,
      hash: '',
      size: '',
      vsize: '',
      vin: [{ txid: funding.getId(), vout: 5, prevOut: { addresses: [address(PAYER_BASE + 5)], value: VALUE } }],
    });
    expect(mined.vout[0]).toMatchObject({ value: 1_000_000n, n: 0, scriptPubKey: { address: address(163), type: 'witness_v1_taproot' } });
    expect(typeof mined.vout[1]!.value).toBe('bigint');
    expect(all[4]).not.toHaveProperty('blockhash');
    expect(all[4]).not.toHaveProperty('confirmations');
    await mine(1);
  });
});
