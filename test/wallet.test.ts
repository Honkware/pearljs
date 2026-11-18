// Wallet state over a scripted chain: payments arriving and confirming,
// sends that record their change and keep their coins from being chosen
// twice, a reorg that unconfirms and reconfirms, coinbase maturity and
// orphaning, a double spend that conflicts a pending send, replacement by
// fee, locked outputs, labels, watch-only accounts, imported keys,
// sweeping, notifications, events, and backup and restore.

import { describe, expect, it } from 'vitest';
import {
  PearlWallet,
  createMemoryStore,
  deriveAccountFromSeed,
  encodeWif,
  keyPathAddress,
  mnemonicToSeed,
  networks,
  parsePearl,
  parseTransaction,
} from '../src/index.js';
import type { BlockEvent, JsonValue, PearlWsEvents, WalletEvents, WalletNotifier } from '../src/index.js';
import { FAST_KDF, FakeChain, MNEMONIC, PASSPHRASE, STRANGER, newWallet } from './wallet-chain.js';

const network = networks.regtest;
const prl = (text: string): bigint => parsePearl(text);

/** A wallet holding one confirmed coin of `amount` per entry. */
async function funded(amounts: string[] = ['10']): Promise<{ chain: FakeChain; wallet: PearlWallet }> {
  const chain = new FakeChain();
  const wallet = await newWallet(chain);
  for (const amount of amounts) chain.pay(await wallet.receiveAddress(), prl(amount));
  chain.mine();
  await wallet.sync();
  return { chain, wallet };
}


describe('wallet: receiving', () => {
  it('sees a payment as unconfirmed, then confirmed, with its history entry', async () => {
    const chain = new FakeChain();
    const wallet = await newWallet(chain);
    const address = await wallet.receiveAddress({ label: 'invoice 7' });
    const payment = chain.pay(address, prl('2.5'));
    await wallet.sync();
    expect(wallet.balance()).toMatchObject({ confirmed: 0n, unconfirmed: prl('2.5'), total: prl('2.5') });
    chain.mine();
    await wallet.sync();
    expect(wallet.balance()).toMatchObject({ confirmed: prl('2.5'), unconfirmed: 0n });
    const [entry] = wallet.history();
    expect(entry).toMatchObject({ txid: payment.getId(), status: 'confirmed', direction: 'incoming', amount: prl('2.5'), confirmations: 1 });
    expect(wallet.addresses()).toEqual([expect.objectContaining({ address, label: 'invoice 7', used: true, index: 0 })]);
  });

  it('finds payments to addresses it never handed out, within the lookahead', async () => {
    const chain = new FakeChain();
    const wallet = await newWallet(chain);
    const account = deriveAccountFromSeed(mnemonicToSeed(MNEMONIC), network);
    chain.pay(account.deriveAddress(7), prl('1'));
    chain.mine();
    await wallet.sync();
    expect(wallet.balance().confirmed).toBe(prl('1'));
    expect(wallet.accounts()[0]!.nextReceiveIndex).toBe(8);
    expect(await wallet.receiveAddress()).toBe(account.deriveAddress(8));
  });

  it('refuses to hand out more unused addresses in a row than the gap limit', async () => {
    const chain = new FakeChain();
    const wallet = await newWallet(chain, { gapLimit: 3 });
    for (let i = 0; i < 3; i += 1) await wallet.receiveAddress();
    await expect(wallet.receiveAddress()).rejects.toThrow('already has 3 unused receive addresses in a row');
    // currentAddress reuses the last unused one instead.
    expect(await wallet.currentAddress()).toBe(wallet.addresses()[2]!.address);
  });

  it('holds a coinbase output as immature until it has matured', async () => {
    const chain = new FakeChain();
    const wallet = await newWallet(chain);
    chain.mine(1, { coinbaseTo: await wallet.receiveAddress(), value: prl('50') });
    await wallet.sync();
    expect(wallet.balance()).toMatchObject({ immature: prl('50'), confirmed: 0n });
    chain.mine(network.coinbaseMaturity - 1);
    await wallet.sync();
    expect(wallet.balance()).toMatchObject({ immature: 0n, confirmed: prl('50') });
  });

  it('keeps every coinbase it was paid, though each has the same null input', async () => {
    const chain = new FakeChain();
    const wallet = await newWallet(chain);
    const address = await wallet.receiveAddress();
    chain.mine(1, { coinbaseTo: address, value: prl('50') });
    chain.mine(1, { coinbaseTo: address, value: prl('50') });
    await wallet.sync();
    chain.mine(1, { coinbaseTo: address, value: prl('50') });
    await wallet.sync();
    expect(wallet.history().map((entry) => entry.status)).toEqual(['confirmed', 'confirmed', 'confirmed']);
    expect(wallet.balance().total).toBe(prl('150'));
  });
});

describe('wallet: sending', () => {
  it('records the send and its change before it confirms', async () => {
    const { chain, wallet } = await funded(['10']);
    const result = await wallet.send({ recipients: [{ address: STRANGER, amount: prl('3') }], feeRate: 2000n, label: 'rent' });
    expect(chain.mempool.has(result.txid)).toBe(true);
    expect(result.changeAddress).toBe(deriveAccountFromSeed(mnemonicToSeed(MNEMONIC), network).deriveAddress(0, true));
    expect(wallet.balance()).toMatchObject({ confirmed: 0n, unconfirmed: result.change, total: result.change });
    expect(result.change).toBe(prl('10') - prl('3') - result.fee);
    const entry = wallet.history()[0]!;
    expect(entry).toMatchObject({ txid: result.txid, status: 'pending', direction: 'outgoing', amount: -(prl('3') + result.fee), fee: result.fee, counterparties: [STRANGER], label: 'rent' });
    chain.mine();
    await wallet.sync();
    expect(wallet.balance()).toMatchObject({ confirmed: result.change, unconfirmed: 0n });
    expect(wallet.accounts()[0]!.nextChangeIndex).toBe(1);
  });

  it('never selects one coin for two sends made at once', async () => {
    const { chain, wallet } = await funded(['5', '5', '5']);
    const sends = await Promise.all([1, 2, 3].map(() => wallet.send({ recipients: [{ address: STRANGER, amount: prl('4') }], feeRate: 2000n })));
    const inputs = sends.flatMap((send) => send.inputs.map((input) => `${input.txid}:${input.vout}`));
    expect(new Set(inputs).size).toBe(inputs.length);
    expect(sends.every((send) => chain.mempool.has(send.txid))).toBe(true);
    await expect(wallet.send({ recipients: [{ address: STRANGER, amount: prl('4') }], feeRate: 2000n })).rejects.toThrow('insufficient funds');
  });

  it('sends while a sync waits on the network, and the sync then counts the send', async () => {
    const { chain, wallet } = await funded(['10']);
    chain.pay(await wallet.receiveAddress(), prl('1'));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const getHistory = chain.getHistory.bind(chain);
    let waiting!: () => void;
    const reached = new Promise<void>((resolve) => (waiting = resolve));
    chain.getHistory = async (watched) => {
      waiting();
      await gate;
      return getHistory(watched);
    };
    const syncing = wallet.sync();
    await reached;
    const sent = await wallet.send({ recipients: [{ address: STRANGER, amount: prl('2') }], feeRate: 2000n });
    release();
    await syncing;
    expect(wallet.transaction(sent.txid)).toMatchObject({ status: 'pending', missing: false });
    expect(wallet.balance()).toMatchObject({ unconfirmed: sent.change + prl('1'), confirmed: 0n });
    expect(wallet.balance().total).toBe(wallet.coins().reduce((sum, coin) => sum + coin.value, 0n));
  });

  it('spends unconfirmed change only when asked to', async () => {
    const { wallet } = await funded(['10']);
    await wallet.send({ recipients: [{ address: STRANGER, amount: prl('1') }], feeRate: 2000n });
    await expect(wallet.send({ recipients: [{ address: STRANGER, amount: prl('1') }], feeRate: 2000n })).rejects.toThrow('left out as unconfirmed');
    const second = await wallet.send({ recipients: [{ address: STRANGER, amount: prl('1') }], feeRate: 2000n, minConfirmations: 0 });
    expect(second.inputs).toHaveLength(1);
  });

  it('needs the keystore unlocked to send', async () => {
    const { wallet } = await funded(['10']);
    wallet.lock();
    await expect(wallet.send({ recipients: [{ address: STRANGER, amount: prl('1') }] })).rejects.toThrow('the wallet is locked');
    await wallet.unlock(PASSPHRASE);
    await expect(wallet.send({ recipients: [{ address: STRANGER, amount: prl('1') }] })).resolves.toMatchObject({ fee: expect.any(BigInt) });
  });

  it('takes a send the node refuses back out, so its coins are free again', async () => {
    const { chain, wallet } = await funded(['10']);
    const before = wallet.balance();
    chain.broadcast = async () => {
      const { PearlRpcError } = await import('../src/index.js');
      throw new PearlRpcError('rpc', 'sendrawtransaction', 'rejected', { rpcCode: -26 });
    };
    await expect(wallet.send({ recipients: [{ address: STRANGER, amount: prl('1') }], feeRate: 2000n })).rejects.toThrow('the node refused');
    expect(wallet.balance()).toEqual(before);
    expect(wallet.history()).toHaveLength(1);
  });

  it('keeps a send whose broadcast may have happened, and rebroadcasts it', async () => {
    const { chain, wallet } = await funded(['10']);
    chain.failNextBroadcast = true;
    await expect(wallet.send({ recipients: [{ address: STRANGER, amount: prl('1') }], feeRate: 2000n })).rejects.toThrow('stays recorded as not broadcast');
    const pending = wallet.history()[0]!;
    expect(wallet.transaction(pending.txid)).toMatchObject({ broadcast: false, status: 'pending' });
    expect(await wallet.rebroadcast()).toEqual({ accepted: [pending.txid], refused: [], failed: [] });
    expect(chain.mempool.has(pending.txid)).toBe(true);
  });

  it('keeps locked outputs out of sends and counts them as locked, across a restart', async () => {
    const store = createMemoryStore();
    const chain = new FakeChain();
    const wallet = await newWallet(chain, { store });
    chain.pay(await wallet.receiveAddress(), prl('4'));
    chain.pay(await wallet.receiveAddress(), prl('6'));
    chain.mine();
    await wallet.sync();
    const big = wallet.coins().find((coin) => coin.value === prl('6'))!;
    await wallet.lockOutpoint(big);
    expect(wallet.balance()).toMatchObject({ confirmed: prl('4'), locked: prl('6'), total: prl('10') });
    const reopened = await PearlWallet.open({ store, backend: chain, transactions: chain });
    expect(reopened.lockedOutpoints()).toEqual([{ txid: big.txid, vout: big.vout, until: null }]);
    await reopened.unlock(PASSPHRASE);
    await expect(reopened.send({ recipients: [{ address: STRANGER, amount: prl('5') }], feeRate: 2000n })).rejects.toThrow('insufficient funds');
    await reopened.unlockOutpoint(big);
    await expect(reopened.send({ recipients: [{ address: STRANGER, amount: prl('5') }], feeRate: 2000n })).resolves.toBeDefined();
  });

  it('sends everything with amount max and no change', async () => {
    const { chain, wallet } = await funded(['3', '4']);
    const result = await wallet.send({ recipients: [{ address: STRANGER, amount: 'max' }], feeRate: 2000n });
    expect(result).toMatchObject({ change: 0n, changeAddress: null });
    expect(wallet.balance().total).toBe(0n);
    expect(parseTransaction(result.hex).outs[0]!.value).toBe(prl('7') - result.fee);
    expect(chain.mempool.size).toBe(1);
  });
});

describe('wallet: chain events', () => {
  it('unconfirms a payment a reorg takes out, then confirms it again', async () => {
    const chain = new FakeChain();
    const wallet = await newWallet(chain);
    const reorgs: WalletEvents['reorg'][] = [];
    wallet.on('reorg', (event) => reorgs.push(event));
    const payment = chain.pay(await wallet.receiveAddress(), prl('1'));
    const [block] = chain.mine();
    chain.mine(2);
    await wallet.sync();
    expect(wallet.history()[0]!.block).toEqual(block);
    chain.reorg(3, { keepInMempool: true });
    await wallet.sync();
    expect(reorgs).toEqual([expect.objectContaining({ forkHeight: block!.height })]);
    expect(wallet.history()[0]).toMatchObject({ txid: payment.getId(), status: 'pending', block: null });
    expect(wallet.balance()).toMatchObject({ confirmed: 0n, unconfirmed: prl('1') });
    const [again] = chain.mine();
    await wallet.sync();
    expect(wallet.history()[0]).toMatchObject({ status: 'confirmed', block: again });
  });

  it('follows a transaction into another block in a reorg', async () => {
    const chain = new FakeChain();
    const wallet = await newWallet(chain);
    chain.pay(await wallet.receiveAddress(), prl('1'));
    chain.mine();
    await wallet.sync();
    const before = wallet.history()[0]!.block!;
    chain.reorg(1);
    await wallet.sync();
    const after = wallet.history()[0]!.block!;
    expect(after.height).toBe(before.height);
    expect(after.hash).not.toBe(before.hash);
    expect(wallet.balance().confirmed).toBe(prl('1'));
  });

  it('orphans a coinbase a reorg removes, and what spent it', async () => {
    const chain = new FakeChain();
    const wallet = await newWallet(chain);
    chain.mine(1, { coinbaseTo: await wallet.receiveAddress(), value: prl('50') });
    await wallet.sync();
    chain.reorg(1);
    await wallet.sync();
    expect(wallet.balance().total).toBe(0n);
    expect(wallet.history()[0]).toMatchObject({ status: 'orphaned', coinbase: true });
  });

  it('marks a pending send conflicted when a double spend confirms, and counts what really happened', async () => {
    const { chain, wallet } = await funded(['10']);
    const conflicts: WalletEvents['conflict'][] = [];
    wallet.on('conflict', (event) => conflicts.push(event));
    const send = await wallet.send({ recipients: [{ address: STRANGER, amount: prl('3') }], feeRate: 2000n });
    const rival = chain.doubleSpend(send.txid);
    await wallet.sync();
    expect(wallet.transaction(send.txid)).toMatchObject({ status: 'conflicted', by: rival.getId() });
    expect(conflicts).toContainEqual({ txid: send.txid, status: 'conflicted', by: rival.getId() });
    expect(wallet.history().find((entry) => entry.txid === rival.getId())).toMatchObject({ status: 'confirmed', direction: 'outgoing' });
    expect(wallet.balance().total).toBe(0n);
  });

  it('drops a payment whose funding a reorg replaced, with everything spending it', async () => {
    const chain = new FakeChain();
    const wallet = await newWallet(chain);
    const payment = chain.pay(await wallet.receiveAddress(), prl('10'));
    chain.mine();
    await wallet.sync();
    const send = await wallet.send({ recipients: [{ address: STRANGER, amount: prl('1') }], feeRate: 2000n });
    chain.reorg(1, { replace: [payment.getId()] });
    await wallet.sync();
    expect(wallet.transaction(payment.getId())!.status).toBe('conflicted');
    expect(wallet.transaction(send.txid)!.status).toBe('conflicted');
    expect(wallet.balance().total).toBe(0n);
  });

  it('reports a pending transaction the backend lost as missing, and abandons it on request', async () => {
    const { chain, wallet } = await funded(['10']);
    const send = await wallet.send({ recipients: [{ address: STRANGER, amount: prl('1') }], feeRate: 2000n });
    chain.drop(send.txid);
    await wallet.sync();
    expect(wallet.transaction(send.txid)).toMatchObject({ status: 'pending', missing: true });
    await wallet.abandon(send.txid);
    expect(wallet.balance().confirmed).toBe(prl('10'));
  });

  it('emits transaction, confirmation and balance events once each', async () => {
    const chain = new FakeChain();
    const wallet = await newWallet(chain);
    const seen: string[] = [];
    wallet.on('transaction', (entry) => seen.push(`transaction ${entry.direction}`));
    wallet.on('confirmation', () => seen.push('confirmation'));
    wallet.on('balance', (balance) => seen.push(`balance ${balance.confirmed}/${balance.unconfirmed}`));
    chain.pay(await wallet.receiveAddress(), 1000n);
    await wallet.sync();
    chain.mine();
    await wallet.sync();
    await wallet.sync();
    expect(seen).toEqual(['transaction incoming', 'balance 0/1000', 'confirmation', 'balance 1000/0']);
  });
});

describe('wallet: replacement', () => {
  it('bumps the fee of a send that signalled replacement', async () => {
    const { chain, wallet } = await funded(['10']);
    const first = await wallet.send({ recipients: [{ address: STRANGER, amount: prl('3') }], feeRate: 2000n, rbf: true });
    const bumped = await wallet.bumpFee(first.txid, { feeRate: 10_000n });
    expect(bumped.replaces).toBe(first.txid);
    expect(bumped.fee).toBeGreaterThan(first.fee);
    expect(chain.mempool.has(first.txid)).toBe(false);
    expect(chain.mempool.has(bumped.txid)).toBe(true);
    expect(wallet.transaction(first.txid)).toMatchObject({ status: 'replaced', by: bumped.txid });
    expect(parseTransaction(bumped.hex).outs.find((out) => out.value === prl('3'))).toBeDefined();
    expect(wallet.balance().total).toBe(prl('10') - prl('3') - bumped.fee);
    chain.mine();
    await wallet.sync();
    expect(wallet.transaction(bumped.txid)!.status).toBe('confirmed');
    expect(wallet.transaction(first.txid)!.status).toBe('replaced');
  });

  it('raises the fee to what the replacement rules need', async () => {
    const { wallet } = await funded(['10']);
    const first = await wallet.send({ recipients: [{ address: STRANGER, amount: prl('3') }], feeRate: 5000n, rbf: true });
    const bumped = await wallet.bumpFee(first.txid, { feeRate: 5000n });
    expect(bumped.fee).toBeGreaterThanOrEqual(first.fee + BigInt(bumped.vsize));
  });

  it('refuses to bump a send that did not signal replacement', async () => {
    const { wallet } = await funded(['10']);
    const first = await wallet.send({ recipients: [{ address: STRANGER, amount: prl('3') }], feeRate: 2000n });
    await expect(wallet.bumpFee(first.txid, { feeRate: 10_000n })).rejects.toThrow('did not signal replace-by-fee');
  });

  it('never pays a recipient less: a send without change is bumped with another coin, and what it leaves is change', async () => {
    const { chain, wallet } = await funded(['1', '5']);
    // What is left of the 1 PRL coin after the fee is dust, so it joins the fee and there is no change output.
    const amount = prl('1') - 400n;
    const first = await wallet.send({ recipients: [{ address: STRANGER, amount }], feeRate: 2000n, rbf: true, strategy: (coins) => [...coins].sort((a, b) => (a.value < b.value ? -1 : 1)) });
    expect(first).toMatchObject({ change: 0n, changeAddress: null });
    expect(first.inputs).toHaveLength(1);
    const bumped = await wallet.bumpFee(first.txid, { feeRate: 20_000n });
    const outputs = parseTransaction(bumped.hex).outs;
    expect(outputs[0]!.value).toBe(amount);
    expect(bumped.inputs.map((input) => input.txid)).toContain(first.inputs[0]!.txid);
    expect(bumped.inputs).toHaveLength(2);
    expect(bumped.change).toBe(prl('6') - amount - bumped.fee);
    expect(bumped.changeAddress).toBe(wallet.addresses().find((address) => address.change)!.address);
    expect(bumped.fee).toBeGreaterThan(first.fee);
    expect(chain.mempool.has(bumped.txid)).toBe(true);
    expect(wallet.balance().total).toBe(prl('6') - amount - bumped.fee);
    // The replacement has change now, and is bumped again out of it.
    const again = await wallet.bumpFee(bumped.txid, { feeRate: 40_000n });
    expect(parseTransaction(again.hex).outs[0]!.value).toBe(amount);
    expect(again.changeAddress).toBe(bumped.changeAddress);
  });

  it('refuses to bump a send without change when there is no other coin, and leaves it as it was', async () => {
    const { chain, wallet } = await funded(['1']);
    const amount = prl('1') - 400n;
    const first = await wallet.send({ recipients: [{ address: STRANGER, amount }], feeRate: 2000n, rbf: true });
    await expect(wallet.bumpFee(first.txid, { feeRate: 20_000n })).rejects.toMatchObject({ code: 'WALLET_NOT_REPLACEABLE', message: expect.stringContaining('its recipients are not paid less') });
    expect(chain.mempool.has(first.txid)).toBe(true);
    expect(wallet.transaction(first.txid)!.status).toBe('pending');
    expect(wallet.accounts()[0]!.nextChangeIndex).toBe(0);
  });

  it('takes the higher fee from the recipient that was sent the maximum, and from no other', async () => {
    const { wallet } = await funded(['10']);
    const other = 'rprl1p6uav7en8k7zsumsqugdmg5j6930zmzy4dg7jcddshsr0fvxlqx7qqv0pfk';
    const first = await wallet.send({ recipients: [{ address: other, amount: prl('2') }, { address: STRANGER, amount: 'max' }], feeRate: 2000n, rbf: true });
    const before = parseTransaction(first.hex).outs;
    const bumped = await wallet.bumpFee(first.txid, { feeRate: 20_000n });
    const after = parseTransaction(bumped.hex).outs;
    expect(after).toHaveLength(2);
    expect(after[0]!.value).toBe(prl('2'));
    expect(after[1]!.value).toBe(before[1]!.value - (bumped.fee - first.fee));
    expect(bumped.inputs).toHaveLength(1);
    // And across a restart, where the wallet only has what it stored.
    const again = await wallet.bumpFee(bumped.txid, { feeRate: 40_000n });
    expect(parseTransaction(again.hex).outs[0]!.value).toBe(prl('2'));
  });

  it('adds a confirmed input when the change cannot pay the higher fee', async () => {
    const { wallet } = await funded(['1', '5']);
    const first = await wallet.send({ recipients: [{ address: STRANGER, amount: 'max' }], feeRate: 2000n, rbf: true, from: { account: '0' } });
    expect(first.inputs).toHaveLength(2);
    const bumped = await wallet.bumpFee(first.txid, { feeRate: 20_000n });
    expect(bumped.inputs).toHaveLength(2);
    expect(bumped.fee).toBeGreaterThan(first.fee);
  });
});

describe('wallet: keys and accounts', () => {
  it('watches an extended public key without being able to spend', async () => {
    const chain = new FakeChain();
    const xpub = deriveAccountFromSeed(mnemonicToSeed(MNEMONIC), network).extendedPublicKey();
    const wallet = await PearlWallet.create({ store: createMemoryStore(), backend: chain, transactions: chain, watchOnly: xpub, gapLimit: 10 });
    chain.pay(await wallet.receiveAddress(), prl('2'));
    chain.mine();
    await wallet.sync();
    expect(wallet.watchOnly).toBe(true);
    expect(wallet.balance().confirmed).toBe(prl('2'));
    await expect(wallet.send({ recipients: [{ address: STRANGER, amount: prl('1') }] })).rejects.toThrow('watch-only');
  });

  it('spends from an imported WIF key', async () => {
    const chain = new FakeChain();
    const wallet = await newWallet(chain);
    const wif = encodeWif(new Uint8Array(32).fill(5), network);
    const address = await wallet.importKey(wif);
    chain.pay(address, prl('2'));
    chain.mine();
    await wallet.sync();
    const result = await wallet.send({ recipients: [{ address: STRANGER, amount: prl('1') }], feeRate: 2000n, from: { imported: address } });
    expect(result.inputs).toHaveLength(1);
    expect(chain.mempool.has(result.txid)).toBe(true);
    expect(wallet.coins().map((coin) => coin.owner.type)).toEqual(['account']);
  });

  it('sweeps a key it does not hold into a new receive address', async () => {
    const chain = new FakeChain();
    const wallet = await newWallet(chain);
    const key = new Uint8Array(32).fill(6);
    chain.pay(keyPathAddress(key, network), prl('3'));
    chain.mine();
    const result = await wallet.sweep({ wif: encodeWif(key, network), feeRate: 2000n });
    expect(wallet.balance().unconfirmed).toBe(prl('3') - result.fee);
    expect(wallet.addresses()[0]).toMatchObject({ label: 'sweep', used: true });
    expect(wallet.history()[0]).toMatchObject({ direction: 'incoming', fee: result.fee });
  });

  it('adds a second account with its own addresses and balance', async () => {
    const chain = new FakeChain();
    const wallet = await newWallet(chain);
    await wallet.addAccount(1);
    chain.pay(await wallet.receiveAddress({ account: '1' }), prl('1'));
    chain.mine();
    await wallet.sync();
    expect(wallet.balance({ account: '1' }).confirmed).toBe(prl('1'));
    expect(wallet.balance({ account: '0' }).confirmed).toBe(0n);
    expect(await wallet.receiveAddress({ account: '1' })).toBe(deriveAccountFromSeed(mnemonicToSeed(MNEMONIC), network, 1).deriveAddress(1));
  });

  it('changes the passphrase, encrypting the secrets again under a new key', async () => {
    const chain = new FakeChain();
    const store = createMemoryStore();
    const wallet = await newWallet(chain, { store });
    const before = wallet.exportKeystore();
    await wallet.changePassphrase(PASSPHRASE, 'new passphrase', { kdf: FAST_KDF });
    const after = wallet.exportKeystore();
    expect(after.secrets.seed).not.toEqual(before.secrets.seed);
    expect(after.kdf.salt).not.toBe(before.kdf.salt);
    const reopened = await PearlWallet.open({ store, backend: chain, transactions: chain });
    await expect(reopened.unlock(PASSPHRASE)).rejects.toThrow('wrong passphrase');
    await reopened.unlock('new passphrase');
    expect(await reopened.mnemonic()).toBe(MNEMONIC);
  });
});

describe('wallet: restart and restore', () => {
  it('reopens from its store with the same state and a locked keystore', async () => {
    const store = createMemoryStore();
    const chain = new FakeChain();
    const wallet = await newWallet(chain, { store });
    chain.pay(await wallet.receiveAddress({ label: 'a' }), prl('5'));
    chain.mine();
    await wallet.sync();
    await wallet.send({ recipients: [{ address: STRANGER, amount: prl('1') }], feeRate: 2000n });
    const reopened = await PearlWallet.open({ store, backend: chain, transactions: chain });
    expect(reopened.locked).toBe(true);
    expect(reopened.balance()).toEqual(wallet.balance());
    expect(reopened.history()).toEqual(wallet.history());
    expect(reopened.addresses()).toEqual(wallet.addresses());
    expect(reopened.tip).toEqual(wallet.tip);
  });

  it('restores from the keystore alone by scanning the chain', async () => {
    const { chain, wallet } = await funded(['1', '2']);
    await wallet.send({ recipients: [{ address: STRANGER, amount: prl('1.5') }], feeRate: 2000n });
    chain.mine();
    await wallet.sync();
    const restored = await PearlWallet.restore({ store: createMemoryStore(), backend: chain, transactions: chain, keystore: wallet.exportKeystore(), passphrase: PASSPHRASE, gapLimit: 10 });
    await restored.sync();
    expect(restored.balance()).toEqual(wallet.balance());
    expect(restored.accounts()[0]).toMatchObject({ nextReceiveIndex: 2, nextChangeIndex: 1 });
  });

  it('restores labels and locks from a state backup', async () => {
    const { chain, wallet } = await funded(['1']);
    await wallet.lockOutpoint(wallet.coins()[0]!);
    const backup = await wallet.exportState();
    expect(JSON.stringify(backup)).not.toContain('ciphertext');
    const restored = await PearlWallet.restore({ store: createMemoryStore(), backend: chain, transactions: chain, keystore: wallet.exportKeystore(), passphrase: PASSPHRASE, backup });
    await restored.sync();
    expect(restored.addresses()).toEqual(wallet.addresses());
    expect(restored.balance()).toEqual(wallet.balance());
  });

  it('refuses a store of another network or a newer schema, and migrates an older one', async () => {
    const chain = new FakeChain();
    const store = createMemoryStore();
    await newWallet(chain, { store });
    const meta = (await store.get('meta')) as Record<string, JsonValue>;
    await store.set('meta', { ...meta, version: 2 });
    await expect(PearlWallet.open({ store, backend: chain, transactions: chain })).rejects.toThrow('newer pearljs');
    await store.set('meta', { ...meta, version: 0 });
    await expect(PearlWallet.open({ store, backend: chain, transactions: chain })).rejects.toThrow('needs migrating');
    const migrations: string[] = [];
    await PearlWallet.open({ store, backend: chain, transactions: chain, migrate: async ({ from, to }) => void migrations.push(`${from}->${to}`) });
    expect(migrations).toEqual(['0->1']);
    expect(((await store.get('meta')) as Record<string, JsonValue>).version).toBe(1);
    await store.set('meta', { ...meta, network: 'mainnet' });
    await expect(PearlWallet.open({ store, backend: chain, transactions: chain })).rejects.toThrow('the wallet is for mainnet');
  });
});

function fakeNotifier() {
  const listeners = new Map<string, (value: never) => void>();
  let onBlock: ((event: BlockEvent) => void) | undefined;
  const watched: string[] = [];
  const notifier: WalletNotifier = {
    on: (<K extends keyof PearlWsEvents>(event: K, listener: (value: PearlWsEvents[K]) => void) => {
      listeners.set(event, listener as (value: never) => void);
      return () => listeners.delete(event);
    }) as WalletNotifier['on'],
    watchBlocks: (options) => {
      onBlock = options.onBlock;
      return () => undefined;
    },
    notifyReceived: async (addresses) => void watched.push(...addresses),
  };
  const send = (event: 'recvtx' | 'redeemingtx', value: PearlWsEvents['recvtx']): void => (listeners.get(event) as (value: PearlWsEvents['recvtx']) => void)(value);
  return { notifier, listeners, watched, send, block: (event: BlockEvent) => onBlock!(event) };
}

describe('wallet: notifications', () => {
  it('takes payments and blocks from a notifier as they happen', async () => {
    const chain = new FakeChain();
    const wallet = await newWallet(chain);
    const { notifier, listeners, watched, block } = fakeNotifier();
    const stop = wallet.watch({ notifier, pollInterval: 3_600_000 });
    const address = await wallet.receiveAddress();
    expect(watched).toContain(address);
    const confirmed = new Promise<void>((resolve) => wallet.on('confirmation', () => resolve()));
    const received = new Promise<void>((resolve) => wallet.on('transaction', () => resolve()));
    const payment = chain.pay(address, prl('1'));
    (listeners.get('recvtx') as (value: PearlWsEvents['recvtx']) => void)({ transaction: payment.toHex(), block: null });
    await received;
    expect(wallet.balance().unconfirmed).toBe(prl('1'));
    const [mined] = chain.mine();
    block({ type: 'connected', hash: mined!.hash, height: mined!.height, time: 0 });
    await confirmed;
    expect(wallet.balance().confirmed).toBe(prl('1'));
    expect(chain.calls.get('getHistory') ?? 0).toBe(0);
    stop();
    await wallet.close();
  });

  it('conflicts a pending send at once when a notification shows its double spend confirmed', async () => {
    const { chain, wallet } = await funded(['10']);
    const { notifier, send } = fakeNotifier();
    const stop = wallet.watch({ notifier, pollInterval: 3_600_000 });
    const sent = await wallet.send({ recipients: [{ address: STRANGER, amount: prl('3') }], feeRate: 2000n });
    const rival = chain.doubleSpend(sent.txid);
    const block = chain.blocks[chain.height]!;
    const conflicts: WalletEvents['conflict'][] = [];
    wallet.on('conflict', (event) => conflicts.push(event));
    send('redeemingtx', { transaction: rival.toHex(), block: { hash: block.hash, height: block.height, index: 1, time: 0 } });
    // Queued behind the notification, so it has been handled once this returns.
    await wallet.exportState();
    expect(conflicts).toEqual([{ txid: sent.txid, status: 'conflicted', by: rival.getId() }]);
    expect(wallet.balance().total).toBe(0n);
    stop();
  });
});
