// pearljs against a running Oyster wallet on regtest, through every typed
// OysterClient method: addresses from the same mnemonic, message signatures
// in both directions, WIF import, a pearljs payment Oyster receives and
// lists, a transaction Oyster builds that pearljs parses, and locking.

import { randomBytes } from 'node:crypto';
import { beforeAll, expect, it } from 'vitest';
import {
  checkStandard,
  decodeWif,
  deriveAccountFromSeed,
  deriveSigningAccountFromSeed,
  encodeWif,
  estimateVsize,
  feeForVsize,
  keyPathAddress,
  mnemonicToSeed,
  parseTransaction,
  PearlRpcError,
  RPC_ERROR_CODES,
  serializeTransaction,
  signMessage,
  toOutputScript,
  transactionId,
  verifyMessage,
} from '../../src/index.js';
import type { TxOutput } from '../../src/index.js';
import { OYSTER_MNEMONIC, OYSTER_PASSPHRASE } from './context.js';
import { describeOyster, fund, mine, miner, network, oyster, pearld } from './chain.js';

const MESSAGE = 'pearljs live test: nonce 5c2e';

/** Polls until Oyster, which follows pearld by notification, has caught up. */
async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function privateKey(): Uint8Array {
  // Any scalar below the curve order works; 32 random bytes almost surely are.
  return Uint8Array.from(randomBytes(32));
}

describeOyster('Oyster', () => {
  const watching = deriveAccountFromSeed(mnemonicToSeed(OYSTER_MNEMONIC), network);
  // The suite shares one Oyster, and files before this one may already have
  // taken receive addresses from it, so the next index is read from Oyster.
  let firstIndex: number;
  let firstAddress: string;
  beforeAll(async () => {
    await oyster.walletPassphrase(OYSTER_PASSPHRASE, 600);
    const known = new Set(await oyster.call<string[]>('getaddressesbyaccount', ['default']));
    firstIndex = 0;
    while (known.has(watching.deriveAddress(firstIndex))) firstIndex += 1;
    firstAddress = await oyster.getNewAddress();
  });

  it('gives the next BIP86 receive address pearljs derives from the same mnemonic', () => {
    expect(firstAddress).toBe(watching.deriveAddress(firstIndex));
  });

  it('verifies a message pearljs signed', async () => {
    const key = privateKey();
    const signature = signMessage(key, MESSAGE);
    expect(await oyster.verifyMessage(keyPathAddress(key, network), signature, MESSAGE)).toBe(true);
    expect(await oyster.verifyMessage(keyPathAddress(key, network), signature, `${MESSAGE}!`)).toBe(false);
  });

  it('signs a message pearljs verifies', async () => {
    const signature = await oyster.signMessage(firstAddress, MESSAGE);
    expect(verifyMessage(firstAddress, signature, MESSAGE, network)).toBe(true);
    expect(verifyMessage(firstAddress, signature, `${MESSAGE}!`, network)).toBe(false);
  });

  it('verifies a message a pearljs account signed for an Oyster address', async () => {
    const account = deriveSigningAccountFromSeed(mnemonicToSeed(OYSTER_MNEMONIC), network);
    const signature = account.signMessage(MESSAGE, { index: firstIndex });
    expect(await oyster.verifyMessage(firstAddress, signature, MESSAGE)).toBe(true);
  });

  it('imports a pearljs WIF at the address keyPathAddress predicts', async () => {
    const key = privateKey();
    await oyster.importPrivKey(encodeWif(key, network), false);
    const imported = await oyster.call<string[]>('getaddressesbyaccount', ['imported']);
    expect(imported).toContain(keyPathAddress(key, network));
    expect(await oyster.dumpPrivKey(keyPathAddress(key, network))).toBe(encodeWif(key, network));
  });

  it('dumps the key behind an address it generated, which pearljs maps back to that address', async () => {
    const wif = await oyster.dumpPrivKey(firstAddress);
    expect(keyPathAddress(decodeWif(wif, network).privateKey, network)).toBe(firstAddress);
  });

  it('receives a pearljs payment and lists it with amounts in grains', async () => {
    const balance = await oyster.getBalance();
    const coins = (await oyster.listUnspent(0)).length;
    expect(await oyster.getUnconfirmedBalance()).toBe(0n);
    const second = await oyster.getNewAddress('default');
    expect(second).toBe(watching.deriveAddress(firstIndex + 1));
    const payments = [
      { script: toOutputScript(firstAddress, network), value: 500_000_000n },
      { script: toOutputScript(second, network), value: 123_456_789n },
    ];
    const funding = await fund(payments);
    const txid = transactionId(funding);

    const unspent = await eventually(
      () => oyster.listUnspent(),
      (list) => list.length === coins + 2,
    );
    expect(unspent.filter((utxo) => utxo.txid === txid).sort((a, b) => a.vout - b.vout)).toEqual([
      {
        txid,
        vout: 0,
        address: firstAddress,
        account: 'default',
        scriptPubKey: Buffer.from(payments[0]!.script).toString('hex'),
        amount: 500_000_000n,
        confirmations: 1,
        spendable: true,
      },
      {
        txid,
        vout: 1,
        address: second,
        account: 'default',
        scriptPubKey: Buffer.from(payments[1]!.script).toString('hex'),
        amount: 123_456_789n,
        confirmations: 1,
        spendable: true,
      },
    ]);
    expect(await oyster.getBalance()).toBe(balance + 623_456_789n);
    expect(await oyster.getBalance('default', 1)).toBe(balance + 623_456_789n);
    // Not yet two blocks deep, unlike any coin Oyster held before.
    expect(await oyster.getBalance('*', 2)).toBe(balance);
    expect((await oyster.listUnspent(2)).filter((utxo) => utxo.txid === txid)).toEqual([]);
    expect(await oyster.listUnspent(0, 1)).toHaveLength(2);
    expect(await oyster.getUnconfirmedBalance()).toBe(0n);
    expect(await oyster.getUnconfirmedBalance('default')).toBe(0n);
  });

  it('builds a transaction with sendtoaddress that pearljs parses, prices and finds standard', async () => {
    const recipient = miner.deriveAddress(200);
    const amount = 150_000_000n;
    const feeRate = 2000n;
    const before = await oyster.listUnspent();
    const txid = await oyster.sendToAddress(recipient, amount, feeRate);

    const hex = await pearld.getRawTransactionHex(txid);
    const tx = parseTransaction(hex);
    expect(transactionId(tx)).toBe(txid);
    expect(serializeTransaction(tx)).toBe(hex);
    // wire.TxVersion: Oyster still builds version 1 transactions.
    expect(tx.version).toBe(1);
    const paid = tx.outs.filter((out) => Buffer.from(out.script).equals(toOutputScript(recipient, network)));
    expect(paid.map((out) => out.value)).toEqual([amount]);

    // Every input is a BIP86 key-path spend of an output the wallet listed.
    const prevouts: TxOutput[] = tx.ins.map((input) => {
      const spent = before.find(
        (utxo) => utxo.txid === Buffer.from(input.hash).reverse().toString('hex') && utxo.vout === input.index,
      );
      expect(spent).toBeDefined();
      expect(input.witness.map((item) => item.length)).toEqual([64]);
      return { script: Buffer.from(spent!.scriptPubKey, 'hex'), value: spent!.amount };
    });
    const vsize = estimateVsize(tx, tx.ins.map(() => ({ type: 'keyPath' as const })));
    expect(vsize).toBe(tx.virtualSize());
    checkStandard(tx, { prevouts });
    const fee = prevouts.reduce((sum, prevout) => sum + prevout.value, 0n) - tx.outs.reduce((sum, out) => sum + out.value, 0n);
    const entry = (await pearld.getRawMempoolVerbose())[txid];
    expect(entry).toMatchObject({ fee, vsize });
    // Oyster prices its own size estimate, which is never under the real size.
    expect(fee).toBeGreaterThanOrEqual(feeForVsize(vsize, feeRate));
    expect(fee).toBeLessThan(feeForVsize(vsize + 10, feeRate));

    // The change is unconfirmed until a block takes the transaction.
    const change = tx.outs.find((out) => !Buffer.from(out.script).equals(toOutputScript(recipient, network)))!;
    expect(
      await eventually(
        () => oyster.getUnconfirmedBalance(),
        (balance) => balance > 0n,
      ),
    ).toBe(change.value);
    const total = before.reduce((sum, utxo) => sum + utxo.amount, 0n);
    const [blockHash] = await mine(1);
    expect(await pearld.getRawTransaction(txid)).toMatchObject({ blockhash: blockHash, confirmations: 1 });
    expect(
      await eventually(
        () => oyster.getBalance(),
        (balance) => balance === total - amount - fee,
      ),
    ).toBe(total - amount - fee);
    expect(await oyster.getUnconfirmedBalance()).toBe(0n);
  });

  it('refuses to send or sign while locked, and unlocks again', async () => {
    expect(await oyster.walletIsLocked()).toBe(false);
    await oyster.walletLock();
    expect(await oyster.walletIsLocked()).toBe(true);
    const mempool = await pearld.getRawMempool();
    const refused = await oyster.sendToAddress(miner.deriveAddress(201), 1_000_000n, 2000n).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(PearlRpcError);
    expect(refused).toMatchObject({ kind: 'rpc', rpcCode: RPC_ERROR_CODES.WALLET_UNLOCK_NEEDED });
    await expect(oyster.dumpPrivKey(firstAddress)).rejects.toMatchObject({ rpcCode: RPC_ERROR_CODES.WALLET_UNLOCK_NEEDED });
    expect(await pearld.getRawMempool()).toEqual(mempool);

    await expect(oyster.walletPassphrase('not the passphrase', 60)).rejects.toMatchObject({
      kind: 'rpc',
      rpcCode: RPC_ERROR_CODES.WALLET_PASSPHRASE_INCORRECT,
    });
    await oyster.walletPassphrase(OYSTER_PASSPHRASE, 600);
    expect(await oyster.walletIsLocked()).toBe(false);
    expect(await oyster.dumpPrivKey(firstAddress)).toBe(await oyster.dumpPrivKey(firstAddress));
  });
});
