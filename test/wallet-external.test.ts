// Payments signed outside the wallet. prepareSend builds the transaction
// and hands it out as a PSBT without signing, recording a send or
// broadcasting; the coins and the change address it chose are held until
// submitSigned brings the signed transaction back, cancelPrepared lets go,
// or the hold runs out. A watch-only wallet prepares for the holder of its
// account's keys, with the key origin that signer expects.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PREPARE_HOLD_MS,
  PearlWallet,
  addInputByTxid,
  createMemoryStore,
  createTransaction,
  deriveAccountFromSeed,
  deriveSigningAccountFromSeed,
  finalizePsbt,
  mnemonicToSeed,
  networks,
  parsePearl,
  parsePsbt,
  parseTransaction,
  toOutputScript,
} from '../src/index.js';
import type { PreparedSend, Transaction } from '../src/index.js';
import { FAST_KDF, FakeChain, MNEMONIC, PASSPHRASE, STRANGER, newWallet, signWithTestWallet } from './wallet-chain.js';

const network = networks.regtest;
const prl = (text: string): bigint => parsePearl(text);
const seed = mnemonicToSeed(MNEMONIC);
const account = deriveAccountFromSeed(seed, network, 0);
const origin = { masterFingerprint: account.masterFingerprint!, path: account.path! };
const payment = { recipients: [{ address: STRANGER, amount: prl('1') }], feeRate: 2000n };

/** What the device does: signs every input of the PSBT with the account's keys and finalizes it. */
function signElsewhere(prepared: PreparedSend): Transaction {
  const psbt = parsePsbt(prepared.psbt);
  const signer = deriveSigningAccountFromSeed(seed, network, 0);
  try {
    for (let i = 0; i < psbt.inputCount; i += 1) signer.signInput(psbt, i);
  } finally {
    signer.destroy();
  }
  return finalizePsbt(psbt);
}

/** A watch-only wallet over the test seed's account 0, with coins. */
async function watching(amounts: string[] = ['3', '2'], now?: () => number) {
  const chain = new FakeChain();
  const store = createMemoryStore();
  const wallet = await PearlWallet.create({ store, backend: chain, transactions: chain, watchOnly: account.extendedPublicKey(), watchOnlyOrigin: origin, gapLimit: 10, ...(now === undefined ? {} : { now }) });
  for (const amount of amounts) chain.pay(await wallet.receiveAddress(), prl(amount));
  chain.mine();
  await wallet.sync();
  return { chain, store, wallet };
}

describe('wallet: payments signed elsewhere', () => {
  it('prepares a payment from a watch-only account, takes it back signed and broadcasts it', async () => {
    const { chain, wallet } = await watching();
    const before = wallet.getSnapshot();
    const prepared = await wallet.prepareSend({ ...payment, rbf: true, label: 'from the device' });
    expect(chain.mempool.size).toBe(0);
    expect(wallet.history()).toHaveLength(2);
    expect(prepared).toMatchObject({ fee: expect.any(BigInt), feeRate: 2000n, changeAddress: account.deriveAddress(0, true), expiresAt: expect.any(Number) });
    expect(prepared.inputs).toHaveLength(1);
    expect(prepared.outputs).toEqual([
      { address: STRANGER, value: prl('1'), change: false },
      { address: account.deriveAddress(0, true), value: prepared.change, change: true },
    ]);
    expect(prepared.inputs[0]!.value - prl('1') - prepared.change).toBe(prepared.fee);
    expect(parseTransaction(prepared.hex).getId()).toBe(prepared.txid);
    expect(prepared.previousTransactions.map((hex) => parseTransaction(hex).getId())).toEqual([prepared.inputs[0]!.txid]);
    // The PSBT names the key the way its signer knows it: by the master fingerprint and the full path.
    const derivation = parsePsbt(prepared.psbt).data.inputs[0]!.tapBip32Derivation![0]!;
    expect(Buffer.from(derivation.masterFingerprint).toString('hex')).toBe(origin.masterFingerprint);
    expect(derivation.path).toMatch(/^m\/86'\/1'\/0'\/0\/[01]$/);
    // The coin is held, and shown as locked.
    expect(wallet.balance()).toMatchObject({ confirmed: prl('5') - prepared.inputs[0]!.value, locked: prepared.inputs[0]!.value, total: prl('5') });
    expect(wallet.getSnapshot().version).toBeGreaterThan(before.version);
    expect(wallet.preparedSends()).toEqual([{ id: prepared.id, txid: prepared.txid, inputs: [{ txid: prepared.inputs[0]!.txid, vout: prepared.inputs[0]!.vout }], expiresAt: prepared.expiresAt }]);

    const sent = await wallet.submitSigned(signElsewhere(prepared));
    expect(sent).toMatchObject({ txid: prepared.txid, fee: prepared.fee, change: prepared.change, changeAddress: prepared.changeAddress });
    expect(chain.mempool.has(prepared.txid)).toBe(true);
    expect(wallet.transaction(prepared.txid)).toMatchObject({ status: 'pending', direction: 'outgoing', broadcast: true, label: 'from the device' });
    expect(wallet.preparedSends()).toEqual([]);
    expect(wallet.balance()).toMatchObject({ locked: 0n, total: prl('5') - prl('1') - prepared.fee });
    expect(wallet.accounts()[0]!.nextChangeIndex).toBe(1);
    chain.mine();
    await wallet.sync();
    expect(wallet.transaction(prepared.txid)!.status).toBe('confirmed');
  });

  it('gives two prepared sends different coins and different change addresses, and a send neither', async () => {
    const chain = new FakeChain();
    const wallet = await newWallet(chain);
    for (const amount of ['3', '2', '4']) chain.pay(await wallet.receiveAddress(), prl(amount));
    chain.mine();
    await wallet.sync();
    wallet.lock();
    expect(wallet.peekChangeAddress()).toBe(account.deriveAddress(0, true));
    const [first, second] = await Promise.all([wallet.prepareSend(payment), wallet.prepareSend(payment)]);
    expect(first!.inputs[0]!.txid).not.toBe(second!.inputs[0]!.txid);
    expect([first!.changeAddress, second!.changeAddress]).toEqual([account.deriveAddress(0, true), account.deriveAddress(1, true)]);
    expect(wallet.peekChangeAddress()).toBe(account.deriveAddress(2, true));
    await wallet.unlock(PASSPHRASE);
    const sent = await wallet.send(payment);
    expect([first!.inputs[0]!.txid, second!.inputs[0]!.txid]).not.toContain(sent.inputs[0]!.txid);
    expect(sent.changeAddress).toBe(account.deriveAddress(2, true));
    // With every coin taken, the next one says what is in the way.
    await expect(wallet.prepareSend(payment)).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS', locked: first!.inputs[0]!.value + second!.inputs[0]!.value });
    await wallet.submitSigned(signElsewhere(second!));
    await wallet.submitSigned(signElsewhere(first!));
    expect(chain.mempool.size).toBe(3);
  });

  it('lets go of the coins and the change address on cancel, and when the hold runs out', async () => {
    let now = 1_000_000;
    const { wallet } = await watching(['3'], () => now);
    const prepared = await wallet.prepareSend(payment);
    expect(prepared.expiresAt).toBe(now + DEFAULT_PREPARE_HOLD_MS);
    await expect(wallet.prepareSend(payment)).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS', locked: prl('3') });
    expect(await wallet.cancelPrepared(prepared.id!)).toBe(true);
    expect(await wallet.cancelPrepared(prepared.id!)).toBe(false);
    expect(wallet.balance()).toMatchObject({ confirmed: prl('3'), locked: 0n });
    await expect(wallet.submitSigned(signElsewhere(prepared))).rejects.toMatchObject({ code: 'WALLET_NOT_PREPARED', message: expect.stringContaining('cancelled') });

    const brief = await wallet.prepareSend({ ...payment, hold: 5_000 });
    expect(brief.changeAddress).toBe(prepared.changeAddress);
    now += 4_999;
    expect(wallet.balance().locked).toBe(prl('3'));
    now += 1;
    expect(wallet.balance()).toMatchObject({ confirmed: prl('3'), locked: 0n });
    expect(wallet.preparedSends()).toEqual([]);
    await expect(wallet.submitSigned(signElsewhere(brief))).rejects.toMatchObject({ code: 'WALLET_NOT_PREPARED', message: expect.stringContaining('ran out') });
    const again = await wallet.prepareSend(payment);
    expect(again.inputs).toEqual(brief.inputs);
  });

  it('keeps holding a prepared send the signer broadcast itself, and records it at the next sync', async () => {
    const { chain, wallet } = await watching(['3']);
    const prepared = await wallet.prepareSend(payment);
    await chain.broadcast(signElsewhere(prepared).toHex());
    await expect(wallet.cancelPrepared(prepared.id!)).rejects.toMatchObject({ code: 'WALLET_TRANSACTION_KNOWN' });
    expect(wallet.balance().locked).toBe(prl('3'));
    await wallet.sync();
    expect(wallet.transaction(prepared.txid)).toMatchObject({ status: 'pending', direction: 'outgoing' });
    expect(wallet.balance().confirmed).toBe(0n);
  });

  it('keeps a hold across a restart', async () => {
    const { chain, store, wallet } = await watching(['3']);
    const prepared = await wallet.prepareSend(payment);
    const reopened = await PearlWallet.open({ store: createMemoryStore(await store.list('')), backend: chain, transactions: chain });
    expect(reopened.balance().locked).toBe(prl('3'));
    expect(reopened.preparedSends()).toHaveLength(1);
    const sent = await reopened.submitSigned(signElsewhere(prepared).toHex());
    expect(chain.mempool.has(sent.txid)).toBe(true);
  });

  it('refuses a signed transaction that is not the prepared one, is not fully signed, or does not verify', async () => {
    const { chain, wallet } = await watching(['3', '2']);
    const prepared = await wallet.prepareSend({ recipients: [{ address: STRANGER, amount: prl('4') }], feeRate: 2000n });
    expect(prepared.inputs).toHaveLength(2);
    const good = signElsewhere(prepared);

    // The same inputs paying a grain less: its id is not the prepared one.
    const redirected = good.clone();
    redirected.outs[0]!.value -= 1n;
    await expect(wallet.submitSigned(redirected)).rejects.toMatchObject({ code: 'WALLET_NOT_PREPARED' });

    const half = good.clone();
    half.setWitness(1, []);
    await expect(wallet.submitSigned(half)).rejects.toMatchObject({ code: 'SIGNATURES_MISSING' });

    const forged = good.clone();
    const signature = Uint8Array.from(forged.ins[0]!.witness[0]!);
    signature[10]! ^= 1;
    forged.setWitness(0, [signature]);
    await expect(wallet.submitSigned(forged)).rejects.toMatchObject({ code: 'SIGNATURE_INVALID', message: expect.stringContaining('input 0') });

    const swapped = good.clone();
    swapped.setWitness(0, good.ins[1]!.witness);
    await expect(wallet.submitSigned(swapped)).rejects.toMatchObject({ code: 'SIGNATURE_INVALID' });

    // None of that cost the hold, recorded anything, or reached the node.
    expect(chain.mempool.size).toBe(0);
    expect(wallet.history()).toHaveLength(2);
    expect(wallet.preparedSends()).toHaveLength(1);
    await wallet.submitSigned(good);
    expect(chain.mempool.has(prepared.txid)).toBe(true);
    await expect(wallet.submitSigned(good)).rejects.toMatchObject({ code: 'WALLET_NOT_PREPARED' });
  });

  it('refuses a prepared send whose coin was spent meanwhile, and drops the hold', async () => {
    const { chain, wallet } = await watching(['3']);
    const prepared = await wallet.prepareSend(payment);
    // The key's holder spends the coin some other way.
    const coin = prepared.inputs[0]!;
    const spend = createTransaction(2);
    addInputByTxid(spend, coin.txid, coin.vout);
    spend.addOutput(toOutputScript(STRANGER, network), coin.value - 1000n);
    chain.mine(1, { include: [signWithTestWallet(spend, chain.prevouts(spend)!)] });
    await wallet.sync();
    expect(wallet.coins()).toEqual([]);
    await expect(wallet.submitSigned(signElsewhere(prepared))).rejects.toMatchObject({ code: 'WALLET_NOT_PREPARED', message: expect.stringContaining('no longer') });
    expect(wallet.preparedSends()).toEqual([]);
  });

  it('holds a prepared send to the fee ceiling, and previews without holding anything', async () => {
    const { chain, wallet } = await watching(['3']);
    chain.feeRate = prl('5');
    await expect(wallet.prepareSend({ recipients: payment.recipients })).rejects.toMatchObject({ code: 'FEE_TOO_HIGH' });
    await expect(wallet.prepareSend({ ...payment, hold: -1 })).rejects.toThrow(RangeError);
    const preview = await wallet.prepareSend({ ...payment, hold: 0 });
    expect(preview).toMatchObject({ id: null, expiresAt: null });
    expect(wallet.balance().locked).toBe(0n);
    expect(wallet.preparedSends()).toEqual([]);
    await expect(wallet.submitSigned(signElsewhere(preview))).rejects.toMatchObject({ code: 'WALLET_NOT_PREPARED' });
  });

  it('estimates a send at several fee rates without asking anyone or holding anything', async () => {
    const { chain, wallet } = await watching(['3', '2']);
    chain.calls.clear();
    const version = wallet.version;
    const estimates = wallet.estimateSend({ recipients: [{ address: STRANGER, amount: prl('4') }] }, [1000n, 2000n, 50_000n, 10_000_000n, prl('2000')]);
    expect(estimates.map((estimate) => estimate.feeRate)).toEqual([1000n, 2000n, 50_000n, 10_000_000n, prl('2000')]);
    expect(estimates.slice(0, 3).every((estimate) => estimate.error === null && estimate.inputs === 2)).toBe(true);
    expect(estimates[1]!.fee).toBe(estimates[0]!.fee! * 2n);
    expect(estimates[1]!.change).toBe(prl('1') - estimates[1]!.fee!);
    expect(estimates[3]).toMatchObject({ fee: null, error: expect.objectContaining({ code: 'FEE_TOO_HIGH' }) });
    expect(estimates[4]!.error).toMatchObject({ code: 'FEE_TOO_HIGH' });
    expect(wallet.estimateSend({ recipients: [{ address: STRANGER, amount: prl('40') }] }, [2000n])[0]!.error).toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    // What it says is what a send at that rate then pays.
    const prepared = await wallet.prepareSend({ recipients: [{ address: STRANGER, amount: prl('4') }], feeRate: 50_000n });
    expect(prepared).toMatchObject({ fee: estimates[2]!.fee, vsize: estimates[2]!.vsize, change: estimates[2]!.change });
    expect([...chain.calls.keys()]).toEqual([]);
    expect(wallet.version).toBe(version + 1);
  });

  it('records on the change output of a prepared payment that it is the account\'s own', async () => {
    const { wallet } = await watching(['3']);
    const prepared = await wallet.prepareSend(payment);
    const psbt = parsePsbt(prepared.psbt);
    const change = psbt.data.outputs[prepared.outputs.findIndex((output) => output.change)]!;
    expect(change.tapBip32Derivation).toHaveLength(1);
    expect(Buffer.from(change.tapBip32Derivation![0]!.masterFingerprint).toString('hex')).toBe(origin.masterFingerprint);
    expect(change.tapBip32Derivation![0]!.path).toBe("m/86'/1'/0'/1/0");
    // The signer, holding the account, finds the change to be its own and the payment to be nothing else.
    const signer = deriveSigningAccountFromSeed(seed, network, 0);
    const outputs = psbt.txOutputs.map((_, i) => signer.watchOnlyAccount().findChild(psbt.data.outputs[i]!.tapBip32Derivation ?? []));
    signer.destroy();
    expect(outputs).toEqual([null, { index: 0, change: true }]);
    await wallet.cancelPrepared(prepared.id!);
  });

  it('sends from a watch-only wallet through a signer that holds the keys, and bumps the fee the same way', async () => {
    const { chain, wallet } = await watching(['3', '2']);
    const device = deriveSigningAccountFromSeed(seed, network, 0);
    const asked: Uint8Array[] = [];
    const inner = device.keyPathSigner();
    const signer = { signKeyPath: (request: Parameters<typeof inner.signKeyPath>[0]) => (asked.push(request.hash), inner.signKeyPath(request)) };
    await expect(wallet.send(payment)).rejects.toMatchObject({ code: 'WALLET_WATCH_ONLY' });
    const sent = await wallet.send({ ...payment, rbf: true, signer });
    expect(chain.mempool.has(sent.txid)).toBe(true);
    expect(asked).toHaveLength(1);
    expect(wallet.transaction(sent.txid)).toMatchObject({ status: 'pending', direction: 'outgoing', broadcast: true });
    await expect(wallet.bumpFee(sent.txid, { feeRate: 10_000n })).rejects.toMatchObject({ code: 'WALLET_WATCH_ONLY' });
    const bumped = await wallet.bumpFee(sent.txid, { feeRate: 10_000n, signer });
    expect(chain.mempool.has(bumped.txid)).toBe(true);
    expect(chain.mempool.has(sent.txid)).toBe(false);
    // A signer for other keys is refused before anything is recorded.
    const stranger = deriveSigningAccountFromSeed(mnemonicToSeed('legal winner thank year wave sausage worth useful legal winner thank yellow'), network, 0);
    await expect(wallet.send({ ...payment, signer: stranger.keyPathSigner() })).rejects.toThrow();
    expect(wallet.history().filter((entry) => entry.direction === 'outgoing' && entry.status === 'pending')).toHaveLength(1);
    device.destroy();
    stranger.destroy();
  });

  it('prepares from a wallet with keys while it is locked, and a send it then signs itself is unaffected', async () => {
    const chain = new FakeChain();
    const wallet = await PearlWallet.create({ store: createMemoryStore(), backend: chain, transactions: chain, passphrase: PASSPHRASE, mnemonic: MNEMONIC, kdf: FAST_KDF, gapLimit: 10, unlockTimeout: 0 });
    chain.pay(await wallet.receiveAddress(), prl('3'));
    chain.mine();
    await wallet.sync();
    expect(wallet.locked).toBe(true);
    const prepared = await wallet.prepareSend(payment);
    const sent = await wallet.submitSigned(signElsewhere(prepared));
    expect(chain.mempool.has(sent.txid)).toBe(true);
    expect(wallet.locked).toBe(true);
  });
});
