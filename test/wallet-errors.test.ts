// The codes the wallet, its stores and its keystore throw: each refusal a
// caller would branch on carries its class and code, and none carries the
// passphrase or a secret it was given.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  KeystoreError,
  PearlRpcError,
  PearlWallet,
  StoreError,
  WalletError,
  createKeystore,
  createMemoryStore,
  deriveAccountFromSeed,
  mnemonicToSeed,
  networks,
  openIndexedDbStore,
  openKeystore,
  parsePearl,
} from '../src/index.js';
import type { JsonValue, PearlErrorCode } from '../src/index.js';
import { createFileStore } from '../src/store-file.js';
import { FAST_KDF, FakeChain, MNEMONIC, PASSPHRASE, STRANGER, newWallet } from './wallet-chain.js';

const code = (name: string, value: PearlErrorCode) => expect.objectContaining({ name, code: value });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pearljs-errors-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('store error codes', () => {
  it('names each file store refusal', async () => {
    const path = join(dir, 'wallet');
    expect(() => createFileStore(path)).toThrow(code('StoreError', 'STORE_NOT_FOUND'));
    const store = createFileStore(path, { create: true });
    expect(() => createFileStore(path)).toThrow(code('StoreError', 'STORE_LOCKED'));
    await store.close();
    expect(() => createFileStore(path, { create: true })).toThrow(code('StoreError', 'STORE_EXISTS'));
    await expect(store.get('k')).rejects.toThrow(code('StoreError', 'STORE_CLOSED'));
    writeFileSync(join(path, '0000000000000000.json'), 'not json');
    expect(() => createFileStore(path)).toThrow(code('StoreError', 'STORE_INVALID'));
    const taken = createFileStore(join(dir, 'other'), { create: true });
    await taken.set('n', 1);
    const taker = createFileStore(join(dir, 'other'), { breakLock: true });
    await expect(taken.set('n', 2)).rejects.toThrow(code('StoreError', 'STORE_LOCKED'));
    await taker.close();
    await taken.close();
  });

  it('says when there is no IndexedDB', async () => {
    await expect(openIndexedDbStore('wallet', { indexedDB: undefined as unknown as IDBFactory })).rejects.toBeInstanceOf(StoreError);
  });
});

describe('keystore error codes', () => {
  it('names a wrong passphrase, tampering, a bad file and a locked keystore, without echoing secrets', async () => {
    const keystore = await createKeystore('right passphrase', { kdf: FAST_KDF });
    await keystore.addSecret('seed', 'seed', new Uint8Array(32).fill(0x5a));
    const data = keystore.toJSON();
    const wrong = await openKeystore(data)
      .unlock('a wrong passphrase')
      .catch((err: unknown) => err);
    expect(wrong).toEqual(code('KeystoreError', 'KEYSTORE_BAD_PASSPHRASE'));
    expect(JSON.stringify(wrong)).not.toContain('a wrong passphrase');
    const tampered = openKeystore({ ...data, secrets: { seed: { ...data.secrets.seed!, ciphertext: `00${data.secrets.seed!.ciphertext.slice(2)}` } } });
    await tampered.unlock('right passphrase');
    await expect(tampered.useSecret('seed', () => undefined)).rejects.toThrow(code('KeystoreError', 'KEYSTORE_TAMPERED'));
    await expect(tampered.useSecret('other', () => undefined)).rejects.toThrow(code('KeystoreError', 'KEYSTORE_NO_SECRET'));
    tampered.lock();
    await expect(tampered.useSecret('seed', () => undefined)).rejects.toThrow(code('KeystoreError', 'KEYSTORE_LOCKED'));
    expect(() => openKeystore({ ...data, version: 9 })).toThrow(KeystoreError);
    await expect(createKeystore('', { kdf: FAST_KDF })).rejects.toThrow(code('KeystoreError', 'KEYSTORE_INVALID'));
  });
});

describe('wallet error codes', () => {
  it('names locked, watch-only, gap limit and unknown items', async () => {
    const chain = new FakeChain();
    const wallet = await newWallet(chain, { gapLimit: 1 });
    await wallet.receiveAddress();
    await expect(wallet.receiveAddress()).rejects.toThrow(code('WalletError', 'WALLET_GAP_LIMIT'));
    await expect(wallet.setTransactionLabel('00'.repeat(32), 'x')).rejects.toThrow(code('WalletError', 'WALLET_UNKNOWN'));
    await expect(wallet.addAccount(0)).rejects.toThrow(code('WalletError', 'WALLET_DUPLICATE'));
    wallet.lock();
    await expect(wallet.send({ recipients: [{ address: STRANGER, amount: 1n }] })).rejects.toThrow(code('WalletError', 'WALLET_LOCKED'));
    const xpub = deriveAccountFromSeed(mnemonicToSeed(MNEMONIC), networks.regtest).extendedPublicKey();
    const watching = await PearlWallet.create({ store: createMemoryStore(), backend: chain, transactions: chain, watchOnly: xpub });
    await expect(watching.unlock(PASSPHRASE)).rejects.toThrow(code('WalletError', 'WALLET_WATCH_ONLY'));
    await wallet.close();
    await expect(wallet.sync()).rejects.toThrow(code('WalletError', 'WALLET_CLOSED'));
  });

  it('names a store with no wallet, a full store, another network and another schema', async () => {
    const chain = new FakeChain();
    const store = createMemoryStore();
    const connection = { store, backend: chain, transactions: chain };
    await expect(PearlWallet.open(connection)).rejects.toThrow(code('WalletError', 'WALLET_NOT_FOUND'));
    await newWallet(chain, { store });
    await expect(newWallet(chain, { store })).rejects.toThrow(code('WalletError', 'WALLET_EXISTS'));
    const meta = (await store.get('meta')) as Record<string, JsonValue>;
    await store.set('meta', { ...meta, version: 2 });
    await expect(PearlWallet.open(connection)).rejects.toThrow(code('WalletError', 'WALLET_SCHEMA'));
    await store.set('meta', { ...meta, network: 'mainnet' });
    await expect(PearlWallet.open(connection)).rejects.toThrow(code('WalletError', 'WALLET_WRONG_NETWORK'));
    await expect(PearlWallet.restore({ ...connection, store: createMemoryStore(), keystore: (await store.get('keystore')) as never, passphrase: PASSPHRASE, backup: { format: 'other' } as never })).rejects.toThrow(
      code('WalletError', 'WALLET_BACKUP_INVALID'),
    );
  });

  it('tells a refused broadcast from an uncertain one, keeping the node error as the cause', async () => {
    const chain = new FakeChain();
    const wallet = await newWallet(chain);
    chain.pay(await wallet.receiveAddress(), parsePearl('2'));
    chain.mine();
    await wallet.sync();
    const refusal = new PearlRpcError('rpc', 'sendrawtransaction', 'rejected', { rpcCode: -26 });
    const broadcast = chain.broadcast.bind(chain);
    chain.broadcast = async () => {
      throw refusal;
    };
    const refused = await wallet.send({ recipients: [{ address: STRANGER, amount: parsePearl('1') }], feeRate: 2000n }).catch((err: unknown) => err);
    expect(refused).toEqual(code('WalletError', 'WALLET_BROADCAST_REFUSED'));
    expect(refused).toBeInstanceOf(WalletError);
    expect((refused as WalletError).cause).toBe(refusal);
    chain.broadcast = broadcast;
    chain.failNextBroadcast = true;
    await expect(wallet.send({ recipients: [{ address: STRANGER, amount: parsePearl('1') }], feeRate: 2000n })).rejects.toThrow(code('WalletError', 'WALLET_BROADCAST_UNCERTAIN'));
    const pending = wallet.history()[0]!.txid;
    await expect(wallet.bumpFee(pending, { feeRate: 5000n })).rejects.toThrow(code('WalletError', 'WALLET_NOT_REPLACEABLE'));
  });
});
