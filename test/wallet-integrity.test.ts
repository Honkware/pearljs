// What the keystore vouches for in a wallet's store. The accounts' extended
// public keys, the imported addresses and the XMSS public keys are tagged
// under the keystore's data key, and the tag is checked on unlock and on
// restore, so someone who can write the store cannot point the wallet's
// receive and change addresses at keys of their own without the next unlock
// failing. Also here: a restore that checks everything before it writes
// anything, a passphrase change that makes old copies stop at the change,
// and how long a new wallet stays unlocked.

import { describe, expect, it } from 'vitest';
import { DEFAULT_CREATE_UNLOCK_MS, PearlWallet, createMemoryStore, deriveAccountFromSeed, encodeWif, mnemonicToSeed, networks, parsePearl } from '../src/index.js';
import type { JsonValue, WalletBackup, WalletStore } from '../src/index.js';
import { FAST_KDF, FakeChain, MNEMONIC, PASSPHRASE, STRANGER, newWallet } from './wallet-chain.js';

const network = networks.regtest;
const prl = (text: string): bigint => parsePearl(text);
const OTHER_MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const other = deriveAccountFromSeed(mnemonicToSeed(OTHER_MNEMONIC), network, 0);
const mine = deriveAccountFromSeed(mnemonicToSeed(MNEMONIC), network, 0);
const tampered = expect.objectContaining({ name: 'KeystoreError', code: 'KEYSTORE_TAMPERED' });
const record = (value: JsonValue | undefined): Record<string, JsonValue> => value as Record<string, JsonValue>;

/** A wallet with an imported key and an XMSS key, its chain, and a way to reopen an edited copy of its store. */
async function stocked() {
  const chain = new FakeChain();
  const store = createMemoryStore();
  const wallet = await newWallet(chain, { store });
  const imported = await wallet.importKey(encodeWif(new Uint8Array(32).fill(5), network));
  const key = await wallet.addXmssKey();
  chain.pay(key.address, prl('10'));
  chain.mine();
  await wallet.sync();
  const edited = async (edit: (entries: Map<string, JsonValue>) => void): Promise<PearlWallet> => {
    const entries = new Map(await store.list(''));
    edit(entries);
    return PearlWallet.open({ store: createMemoryStore(entries), backend: chain, transactions: chain });
  };
  return { chain, store, wallet, imported, key, edited };
}

describe('wallet: what the keystore authenticates', () => {
  it('opens and unlocks an untouched store, and a wallet that added accounts and keys', async () => {
    const { wallet, edited } = await stocked();
    await wallet.addAccount(3);
    await wallet.addWatchOnlyAccount(other.extendedPublicKey());
    const reopened = await edited(() => undefined);
    await reopened.unlock(PASSPHRASE);
    expect(reopened.locked).toBe(false);
    expect(reopened.accounts().map((account) => account.id)).toEqual(['0', '3', 'watch-0']);
  });

  it.each([
    ['the extended public key of an account is swapped', (entries: Map<string, JsonValue>) => void entries.set('account:0', { ...record(entries.get('account:0')), xpub: other.extendedPublicKey() })],
    ['an account is added', (entries: Map<string, JsonValue>) => void entries.set('account:watch-0', { id: 'watch-0', kind: 'xpub', number: null, xpub: other.extendedPublicKey(), label: null, receive: 0, change: 0 })],
    ['an account changes kind', (entries: Map<string, JsonValue>) => void entries.set('account:0', { ...record(entries.get('account:0')), kind: 'xpub', number: null })],
    ['the origin of an account is changed', (entries: Map<string, JsonValue>) => void entries.set('account:0', { ...record(entries.get('account:0')), origin: null })],
    ['an imported address is added', (entries: Map<string, JsonValue>) => void entries.set(`imported:${STRANGER}`, { address: STRANGER, label: null })],
    ['an imported address is removed', (entries: Map<string, JsonValue>) => void [...entries.keys()].filter((key) => key.startsWith('imported:')).forEach((key) => entries.delete(key))],
    ['an XMSS key is removed', (entries: Map<string, JsonValue>) => void [...entries.keys()].filter((key) => key.startsWith('xmss:')).forEach((key) => entries.delete(key))],
    ['the tag is removed', (entries: Map<string, JsonValue>) => void entries.delete('auth')],
    ['the tag is replaced', (entries: Map<string, JsonValue>) => void entries.set('auth', { nonce: '00'.repeat(12), tag: '00'.repeat(16) })],
  ])('refuses to unlock when %s in the store', async (_, edit) => {
    const { edited } = await stocked();
    const victim = await edited(edit);
    await expect(victim.unlock(PASSPHRASE)).rejects.toEqual(tampered);
    expect(victim.locked).toBe(true);
    await expect(victim.send({ recipients: [{ address: STRANGER, amount: prl('1') }], feeRate: 2000n })).rejects.toMatchObject({ code: 'WALLET_LOCKED' });
    await expect(victim.addAccount(1)).rejects.toMatchObject({ code: 'WALLET_LOCKED' });
  });

  it('pays no change to a key put in an account record: the spend never starts', async () => {
    const { chain, key, edited } = await stocked();
    const victim = await edited((entries) => entries.set('account:0', { ...record(entries.get('account:0')), xpub: other.extendedPublicKey() }));
    await expect(victim.unlock(PASSPHRASE)).rejects.toEqual(tampered);
    await expect(victim.send({ recipients: [{ address: STRANGER, amount: prl('1') }], feeRate: 2000n, from: { xmss: key.id } })).rejects.toMatchObject({ code: 'WALLET_LOCKED' });
    expect(chain.mempool.size).toBe(0);
  });

  it('refuses a store whose XMSS record names another address, before any unlock', async () => {
    const { key, edited } = await stocked();
    await expect(edited((entries) => entries.set(`xmss:${key.id}`, { ...record(entries.get(`xmss:${key.id}`)), address: STRANGER }))).rejects.toMatchObject({ code: 'STORE_INVALID' });
    await expect(edited((entries) => entries.set('account:0', { junk: true }))).rejects.toMatchObject({ code: 'STORE_INVALID' });
    await expect(edited((entries) => entries.set('account:0', { ...record(entries.get('account:0')), xpub: 'not a key' }))).rejects.toMatchObject({ code: 'STORE_INVALID' });
  });

  it('refuses a keystore put back from before a key was added', async () => {
    const chain = new FakeChain();
    const store = createMemoryStore();
    const wallet = await newWallet(chain, { store });
    const old = await store.get('keystore');
    await wallet.importKey(encodeWif(new Uint8Array(32).fill(5), network));
    const entries = new Map(await store.list(''));
    entries.set('keystore', old!);
    const victim = await PearlWallet.open({ store: createMemoryStore(entries), backend: chain, transactions: chain });
    await expect(victim.unlock(PASSPHRASE)).rejects.toEqual(tampered);
    expect(victim.locked).toBe(true);
  });

  it('holds the accounts to what it checked for as long as the process lives, locked or not', async () => {
    const { store, chain } = await stocked();
    const wallet = await PearlWallet.open({ store, backend: chain, transactions: chain });
    await wallet.unlock(PASSPHRASE);
    wallet.lock();
    const address = await wallet.receiveAddress();
    expect(address).toBe(mine.deriveAddress(0));
    // The store is changed behind the locked wallet, and an operation that fails makes it read the store again.
    await store.set('account:0', { ...record(await store.get('account:0')), xpub: other.extendedPublicKey() });
    await expect(wallet.setLabel(STRANGER, 'x')).rejects.toMatchObject({ code: 'WALLET_UNKNOWN' });
    await expect(wallet.receiveAddress()).rejects.toEqual(tampered);
    await expect(wallet.sync()).rejects.toEqual(tampered);
  });

  it('cannot check a wallet that has not been unlocked since it was opened, and does at the first unlock', async () => {
    const { edited } = await stocked();
    const victim = await edited((entries) => entries.set('account:0', { ...record(entries.get('account:0')), xpub: other.extendedPublicKey() }));
    // Locked, there is no key to check with: the address comes from the stored key as it is.
    expect(await victim.receiveAddress()).toBe(other.deriveAddress(0));
    await expect(victim.unlock(PASSPHRASE)).rejects.toEqual(tampered);
  });

  it('authenticates again under the new key when the passphrase changes', async () => {
    const { chain, store, wallet, key, edited } = await stocked();
    const before = new Map(await store.list(''));
    await wallet.changePassphrase(PASSPHRASE, 'second passphrase', { kdf: FAST_KDF });
    const reopened = await edited(() => undefined);
    await expect(reopened.unlock(PASSPHRASE)).rejects.toMatchObject({ code: 'KEYSTORE_BAD_PASSPHRASE' });
    await reopened.unlock('second passphrase');
    const sent = await reopened.send({ recipients: [{ address: STRANGER, amount: prl('1') }], feeRate: 2000n, from: { xmss: key.id } });
    expect(chain.mempool.has(sent.txid)).toBe(true);
    // The old keystore does not vouch for the new state, nor the new keystore for the old tag.
    const mixed = await edited((entries) => entries.set('keystore', before.get('keystore')!));
    await expect(mixed.unlock(PASSPHRASE)).rejects.toEqual(tampered);
    const mixedBack = await edited((entries) => entries.set('auth', before.get('auth')!));
    await expect(mixedBack.unlock('second passphrase')).rejects.toEqual(tampered);
    // A whole copy from before the change is a wallet in itself, under the old passphrase.
    const copy = await PearlWallet.open({ store: createMemoryStore(before), backend: chain, transactions: chain });
    await copy.unlock(PASSPHRASE);
    wallet.lock();
    await expect(wallet.changePassphrase('second passphrase', 'third', { kdf: FAST_KDF })).rejects.toMatchObject({ code: 'WALLET_LOCKED' });
  });

  it('needs a wallet with keys unlocked to add a watch-only account, and records its origin', async () => {
    const chain = new FakeChain();
    const wallet = await newWallet(chain);
    wallet.lock();
    await expect(wallet.addWatchOnlyAccount(other.extendedPublicKey())).rejects.toMatchObject({ code: 'WALLET_LOCKED' });
    await wallet.unlock(PASSPHRASE);
    const origin = { masterFingerprint: other.masterFingerprint!, path: other.path! };
    const added = await wallet.addWatchOnlyAccount(other.extendedPublicKey(), { origin, label: 'cold' });
    expect(added).toMatchObject({ id: 'watch-0', kind: 'xpub', origin, label: 'cold' });
    expect(wallet.accounts()[0]).toMatchObject({ id: '0', origin: { masterFingerprint: mine.masterFingerprint, path: "m/86'/1'/0'" } });
    await expect(wallet.addWatchOnlyAccount(mine.extendedPublicKey(), { origin: { masterFingerprint: '00000000', path: "m/86'/1'/7'" } })).rejects.toMatchObject({ code: 'EXTENDED_KEY_INVALID' });
    // A watch-only wallet has no keystore to check with, and takes the origin at creation.
    const watching = await PearlWallet.create({ store: createMemoryStore(), backend: chain, transactions: chain, watchOnly: other.extendedPublicKey(), watchOnlyOrigin: origin });
    expect(watching.accounts()[0]!.origin).toEqual(origin);
    await watching.addWatchOnlyAccount(mine.extendedPublicKey());
  });
});

describe('wallet: restore checks before it writes', () => {
  async function backedUp() {
    const { chain, wallet, key, imported } = await stocked();
    await wallet.receiveAddress({ label: 'kept' });
    return { chain, wallet, key, imported, backup: await wallet.exportState(), keystore: wallet.exportKeystore() };
  }
  const edit = (backup: WalletBackup, key: string, value: JsonValue | undefined): WalletBackup => {
    const entries = { ...backup.entries };
    if (value === undefined) delete entries[key];
    else entries[key] = value;
    return { ...backup, entries };
  };

  it('restores an untouched backup, with every XMSS key frozen', async () => {
    const { chain, backup, keystore, key } = await backedUp();
    const restored = await PearlWallet.restore({ store: createMemoryStore(), backend: chain, transactions: chain, keystore, passphrase: PASSPHRASE, backup });
    expect(restored.locked).toBe(false);
    expect(restored.addresses().find((address) => address.label === 'kept')).toBeDefined();
    expect(restored.xmssKeys()).toMatchObject([{ id: key.id, frozen: 'restored' }]);
    expect(restored.balance().confirmed).toBe(prl('10'));
  });

  it('refuses a backup whose accounts or keys are not the ones the keystore authenticated, and leaves the store empty', async () => {
    const { chain, backup, keystore, key } = await backedUp();
    const account = record(backup.entries['account:0']);
    const bad: [string, WalletBackup][] = [
      ['a swapped account key', edit(backup, 'account:0', { ...account, xpub: other.extendedPublicKey() })],
      ['an added account', edit(backup, 'account:watch-0', { id: 'watch-0', kind: 'xpub', number: null, xpub: other.extendedPublicKey(), label: null, receive: 0, change: 0 })],
      ['an added imported address', edit(backup, `imported:${STRANGER}`, { address: STRANGER, label: null })],
      ['a removed XMSS key', edit(backup, `xmss:${key.id}`, undefined)],
      ['an XMSS key at another address', edit(backup, `xmss:${key.id}`, { ...record(backup.entries[`xmss:${key.id}`]), address: STRANGER })],
      ['no tag', edit(backup, 'auth', undefined)],
      ['a record that is not one', edit(backup, 'account:0', { junk: true })],
      ['a transaction that does not parse', edit(backup, `tx:${'00'.repeat(32)}`, { hex: 'zz' })],
      ['no metadata', edit(backup, 'meta', undefined)],
      ['entries that are not an object', { ...backup, entries: [] as never }],
    ];
    const store = createMemoryStore();
    for (const [what, damaged] of bad) {
      const error = await PearlWallet.restore({ store, backend: chain, transactions: chain, keystore, passphrase: PASSPHRASE, backup: damaged }).catch((err: unknown) => err);
      expect(error, what).toMatchObject({ name: 'WalletError', code: 'WALLET_BACKUP_INVALID' });
      expect(await store.list(''), what).toEqual([]);
    }
    await expect(PearlWallet.restore({ store, backend: chain, transactions: chain, keystore, passphrase: 'not the passphrase', backup })).rejects.toMatchObject({ code: 'KEYSTORE_BAD_PASSPHRASE' });
    expect(await store.list('')).toEqual([]);
    // The same store takes the real backup afterwards.
    const restored = await PearlWallet.restore({ store, backend: chain, transactions: chain, keystore, passphrase: PASSPHRASE, backup });
    expect(await restored.receiveAddress()).toBe(mine.deriveAddress(1));
  });

  it('restores from the keystore alone with accounts and keys it has authenticated', async () => {
    const { chain, keystore, key, imported } = await backedUp();
    const store = createMemoryStore();
    const restored = await PearlWallet.restore({ store, backend: chain, transactions: chain, keystore, passphrase: PASSPHRASE, accounts: [0, 2] });
    expect(restored.accounts().map((account) => account.id)).toEqual(['0', '2']);
    expect(restored.xmssKeys()).toMatchObject([{ id: key.id, address: key.address, frozen: 'restored' }]);
    await restored.sync();
    expect(restored.balance().confirmed).toBe(prl('10'));
    expect(restored.coins().map((coin) => coin.owner.type)).toEqual(['xmss']);
    // What it wrote opens and unlocks like any wallet, the imported key's address among its own.
    const reopened = await PearlWallet.open({ store: createMemoryStore(await store.list('')), backend: chain, transactions: chain });
    await reopened.unlock(PASSPHRASE);
    expect((await store.list('imported:')).map(([key]) => key)).toEqual([`imported:${imported}`]);
  });
});

describe('wallet: how long a new wallet stays unlocked', () => {
  const connection = (chain: FakeChain, store: WalletStore = createMemoryStore()) => ({ store, backend: chain, transactions: chain, passphrase: PASSPHRASE, mnemonic: MNEMONIC, kdf: FAST_KDF });

  it('returns a new wallet unlocked and locks it after the timeout', async () => {
    expect(DEFAULT_CREATE_UNLOCK_MS).toBe(300_000);
    const chain = new FakeChain();
    const wallet = await PearlWallet.create({ ...connection(chain), unlockTimeout: 40 });
    expect(wallet.locked).toBe(false);
    expect(await wallet.mnemonic()).toBe(MNEMONIC);
    await new Promise((resolve) => setTimeout(resolve, 90));
    expect(wallet.locked).toBe(true);
    await expect(wallet.mnemonic()).rejects.toMatchObject({ code: 'KEYSTORE_LOCKED' });
  });

  it('returns it locked for a timeout of 0, and unlocked until lock() for null', async () => {
    const chain = new FakeChain();
    const locked = await PearlWallet.create({ ...connection(chain), unlockTimeout: 0 });
    expect(locked.locked).toBe(true);
    await locked.unlock(PASSPHRASE);
    const open = await PearlWallet.create({ ...connection(chain), unlockTimeout: null });
    expect(open.locked).toBe(false);
    await expect(PearlWallet.create({ ...connection(chain), unlockTimeout: -5 })).rejects.toThrow(RangeError);
    const keystore = open.exportKeystore();
    const restored = await PearlWallet.restore({ store: createMemoryStore(), backend: chain, transactions: chain, keystore, passphrase: PASSPHRASE, unlockTimeout: 0 });
    expect(restored.locked).toBe(true);
    const brief = await PearlWallet.restore({ store: createMemoryStore(), backend: chain, transactions: chain, keystore, passphrase: PASSPHRASE, unlockTimeout: 40 });
    expect(brief.locked).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 90));
    expect(brief.locked).toBe(true);
  });

  it('stays locked when lock is called while it is unlocking', async () => {
    const chain = new FakeChain();
    const wallet = await newWallet(chain);
    wallet.lock();
    const unlocking = wallet.unlock(PASSPHRASE);
    wallet.lock();
    await expect(unlocking).rejects.toMatchObject({ code: 'KEYSTORE_LOCKED' });
    expect(wallet.locked).toBe(true);
    await wallet.unlock(PASSPHRASE);
    expect(wallet.locked).toBe(false);
  });
});
