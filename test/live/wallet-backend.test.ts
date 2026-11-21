// The wallet backends and address discovery on a regtest pearld and Oyster:
// pearldBackend's unspent outputs and balance across a mempool spend and an
// immature coinbase, the spend status of an output in each state,
// oysterBackend agreeing with pearldBackend about Oyster's own addresses,
// and the README's end to end example: discoverAccount on the Oyster
// mnemonic, payFromAccount and backend.broadcast, mined by pearld.

import { beforeAll, expect, it } from 'vitest';
import {
  COINBASE_MATURITY,
  deriveSigningAccountFromSeed,
  discoverAccount,
  mnemonicToSeed,
  oysterBackend,
  parseBlock,
  payFromAccount,
  pearldBackend,
  PearldClient,
  spendableUtxos,
  toOutputScript,
} from '../../src/index.js';
import type { AccountUtxo, Transaction, WalletUtxo } from '../../src/index.js';
import { clientOptions, OYSTER_MNEMONIC, OYSTER_PASSPHRASE } from './context.js';
import { describeLive, describeOyster, eventually, FEE_RATE, fund, live, mine, miner, minerScript, network, nowhere, oyster, pearld } from './chain.js';

const account = deriveSigningAccountFromSeed(mnemonicToSeed('zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong'), network, 7);
const backend = pearldBackend(pearld, { network });
const key = (utxo: { txid: string; vout: number }): string => `${utxo.txid}:${utxo.vout}`;
const byOutpoint = (utxos: readonly WalletUtxo[]): WalletUtxo[] => [...utxos].sort((a, b) => key(a).localeCompare(key(b)));

describeLive('pearldBackend', () => {
  const addresses = [0, 1, 2].map((i) => account.deriveAddress(i));
  let funding: Transaction;
  beforeAll(async () => {
    funding = await fund([
      { script: toOutputScript(addresses[0]!, network), value: 30_000_000n },
      { script: toOutputScript(addresses[1]!, network), value: 20_000_000n },
    ]);
  });

  it('lists unspent outputs and balances before, during and after a mempool spend', async () => {
    const confirmed = [0, 1].map((vout) => ({
      txid: funding.getId(),
      vout,
      value: funding.outs[vout]!.value,
      script: funding.outs[vout]!.script,
      address: addresses[vout]!,
      confirmations: 1,
      coinbase: false,
    }));
    expect(byOutpoint(await backend.getUtxos(addresses))).toEqual(byOutpoint(confirmed));
    // A script works where an address does, and a repeated one counts once.
    expect(await backend.getUtxos([funding.outs[1]!.script, addresses[1]!])).toEqual([confirmed[1]]);
    expect(await backend.getBalance(addresses)).toEqual({ confirmed: 50_000_000n, unconfirmed: 0n, immature: 0n });
    expect(await backend.getSpendStatus({ txid: funding.getId(), vout: 0 })).toEqual({ status: 'unspent', confirmations: 1 });

    // Address 0 pays address 2, with change back to itself, and the payment waits in the mempool.
    const payment = payFromAccount(account, {
      network,
      utxos: [{ ...confirmed[0]!, index: 0 }],
      recipients: [{ address: addresses[2]!, amount: 12_000_000n }],
      feeRate: FEE_RATE,
      changeAddress: addresses[0]!,
    });
    expect(await backend.broadcast(payment.hex)).toBe(payment.txid);
    const pending = [
      confirmed[1]!,
      { txid: payment.txid, vout: 0, value: 12_000_000n, script: toOutputScript(addresses[2]!, network), address: addresses[2]!, confirmations: 0, coinbase: false },
      { txid: payment.txid, vout: 1, value: payment.change, script: toOutputScript(addresses[0]!, network), address: addresses[0]!, confirmations: 0, coinbase: false },
    ];
    expect(byOutpoint(await backend.getUtxos(addresses))).toEqual(byOutpoint(pending));
    expect(await backend.getBalance(addresses)).toEqual({ confirmed: 20_000_000n, unconfirmed: 30_000_000n - payment.fee, immature: 0n });
    expect(spendableUtxos(await backend.getUtxos(addresses)).map(key)).toEqual([key(confirmed[1]!)]);
    expect(await backend.getSpendStatus({ txid: funding.getId(), vout: 0 })).toEqual({ status: 'spent', spender: payment.txid, confirmed: false });
    expect(await backend.getSpendStatus({ txid: payment.txid, vout: 0 })).toEqual({ status: 'unspent', confirmations: 0 });
    expect(await backend.getHistory(addresses[0]!)).toEqual([
      { txid: funding.getId(), block: expect.objectContaining({ hash: await pearld.getBestBlockHash() }) as unknown, received: 30_000_000n, spent: 0n },
      { txid: payment.txid, block: null, received: payment.change, spent: 30_000_000n },
    ]);

    await mine(1);
    expect(await backend.getBalance(addresses)).toEqual({ confirmed: 50_000_000n - payment.fee, unconfirmed: 0n, immature: 0n });
    expect(await backend.getSpendStatus({ txid: funding.getId(), vout: 0 })).toEqual({ status: 'spent', spender: payment.txid, confirmed: true });
    expect(await backend.getSpendStatus({ txid: payment.txid, vout: 0 })).toEqual({ status: 'unspent', confirmations: 1 });
    // Outputs that never existed: an unknown transaction, and an index past a real one's outputs.
    expect(await backend.getSpendStatus({ txid: 'ab'.repeat(32), vout: 0 })).toEqual({ status: 'unknown' });
    expect(await backend.getSpendStatus({ txid: payment.txid, vout: 2 })).toEqual({ status: 'unknown' });
  });

  it('counts coinbase outputs as immature until they are 100 blocks deep', async () => {
    const address = miner.deriveAddress(0);
    const tip = await pearld.getBlockCount();
    const utxos = await backend.getUtxos([address]);
    const coinbases = utxos.filter((utxo) => utxo.coinbase);
    // Every block since the one 99 back pays the miner a coinbase that cannot be spent yet.
    let immature = 0n;
    for (let height = tip - (COINBASE_MATURITY - 2); height <= tip; height++) {
      const [coinbase] = parseBlock(await pearld.getRawBlock(await pearld.getBlockHash(height))).transactions;
      immature += coinbase!.outs.filter((out) => Buffer.from(out.script).equals(minerScript)).reduce((sum, out) => sum + out.value, 0n);
    }
    const young = coinbases.filter((utxo) => utxo.confirmations < COINBASE_MATURITY);
    expect(young).toHaveLength(COINBASE_MATURITY - 1);
    expect(young.reduce((sum, utxo) => sum + utxo.value, 0n)).toBe(immature);
    const balance = await backend.getBalance([address]);
    expect(balance.immature).toBe(immature);
    expect(balance.confirmed + balance.unconfirmed + balance.immature).toBe(utxos.reduce((sum, utxo) => sum + utxo.value, 0n));
    expect(spendableUtxos(utxos).some((utxo) => utxo.coinbase === true && (utxo.confirmations ?? 0) < COINBASE_MATURITY)).toBe(false);
    // pearld agrees about every output listed: each is unspent, with that many confirmations.
    for (const utxo of [...young.slice(0, 3), ...utxos.filter((entry) => !entry.coinbase).slice(0, 3)]) {
      expect(await pearld.getTxOut(utxo.txid, utxo.vout)).toMatchObject({ value: utxo.value, confirmations: utxo.confirmations, coinbase: utxo.coinbase });
    }
  });
});

describeOyster('oysterBackend and discovery', () => {
  const wallet = oysterBackend(oyster, { network });
  const watching = deriveSigningAccountFromSeed(mnemonicToSeed(OYSTER_MNEMONIC), network);

  async function synced(): Promise<void> {
    const tip = await pearld.getBlockCount();
    expect((await eventually(() => oyster.getBestBlock(), (best) => best.height === tip)).height).toBe(tip);
  }

  beforeAll(async () => {
    await oyster.walletPassphrase(OYSTER_PASSPHRASE, 3600);
    const outputs = [];
    for (const value of [25_000_000n, 8_000_000n, 6_000_000n]) outputs.push({ script: toOutputScript(await oyster.getNewAddress(), network), value });
    await fund(outputs);
    await synced();
  });

  it('gives the balances and unspent outputs pearldBackend gives for the same addresses', async () => {
    const addresses = await oyster.getAddressesByAccount('default');
    expect(addresses.length).toBeGreaterThanOrEqual(3);
    const compare = async (): Promise<void> => {
      const [fromNode, fromWallet] = [await backend.getUtxos(addresses), await wallet.getUtxos(addresses)];
      expect(byOutpoint(fromWallet)).toEqual(byOutpoint(fromNode));
      expect(await wallet.getBalance(addresses)).toEqual(await backend.getBalance(addresses));
    };
    await compare();
    expect((await wallet.getBalance(addresses)).confirmed).toBe(await oyster.getBalance('default'));
    expect(await wallet.getTip()).toEqual(await backend.getTip());

    // With a send of Oyster's own waiting in the mempool, its change is unconfirmed for both.
    const txid = await oyster.sendToAddress(miner.deriveAddress(600), 2_000_000n, 1000n);
    await eventually(() => oyster.getUnconfirmedBalance(), (balance) => balance > 0n);
    await compare();
    expect((await wallet.getBalance(await oyster.getAddressesByAccount('default'))).unconfirmed).toBeGreaterThan(0n);
    await mine(1);
    await synced();
    expect((await pearld.getRawTransaction(txid)).confirmations).toBe(1);
    await compare();
  });

  it('discovers the Oyster account from its mnemonic, pays from it and has pearld mine the payment', async () => {
    const node = new PearldClient({ ...clientOptions(live?.pearld ?? nowhere), batch: true });
    const batched = pearldBackend(node, { network });
    const discovered = await discoverAccount(watching, batched);

    // Every address found is one Oyster handed out, on the chain it says.
    const listed = new Set(await oyster.getAddressesByAccount('default'));
    expect(discovered.receive.used.length).toBeGreaterThanOrEqual(3);
    for (const child of [...discovered.receive.used, ...discovered.change.used]) {
      expect(child.address).toBe(watching.deriveAddress(child.index, child.change));
      expect(listed.has(child.address)).toBe(true);
    }
    // Oyster's next change address is the one discovery says is next.
    const nextChange = await oyster.getRawChangeAddress();
    expect(nextChange).toBe(watching.deriveAddress(discovered.change.nextIndex, true));
    // And it holds what Oyster holds.
    const own = (await oyster.listUnspent(0)).filter((entry) => entry.account === 'default');
    expect(discovered.utxos.map(key).sort()).toEqual(own.map(key).sort());
    expect(discovered.balance).toEqual({ confirmed: await oyster.getBalance('default'), unconfirmed: 0n, immature: 0n });
    // The same scan through Oyster's own wallet finds the same receive addresses.
    const viaWallet = await discoverAccount(watching, wallet);
    expect(viaWallet.receive.used).toEqual(discovered.receive.used);
    expect(viaWallet.balance).toEqual(discovered.balance);

    const recipient = miner.deriveAddress(601);
    const utxos: AccountUtxo[] = discovered.utxos;
    const payment = payFromAccount(watching, {
      network,
      utxos,
      recipients: [{ address: recipient, amount: 15_000_000n }],
      feeRate: await batched.estimateFeeRate(),
      changeAddress: nextChange,
    });
    expect(await batched.broadcast(payment.hex)).toBe(payment.txid);
    const [blockHash] = await mine(1);
    expect(await pearld.getRawTransaction(payment.txid)).toMatchObject({ blockhash: blockHash, confirmations: 1 });
    await synced();
    // Oyster sees its own coins spent by pearljs and the change come back.
    expect(await eventually(() => oyster.getBalance('default'), (balance) => balance === discovered.balance.confirmed - 15_000_000n - payment.fee)).toBe(
      discovered.balance.confirmed - 15_000_000n - payment.fee,
    );
    const after = await discoverAccount(watching, batched);
    expect(after.balance.confirmed).toBe(discovered.balance.confirmed - 15_000_000n - payment.fee);
    expect(after.change.nextIndex).toBe(discovered.change.nextIndex + 1);
  });
});
