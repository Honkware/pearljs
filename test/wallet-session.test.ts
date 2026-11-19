// A wallet unlocked from a session, as an extension's service worker does
// after Chrome stops it: the same store opened again, unlocked without the
// passphrase, and signing. The wallet's own records are still checked
// against the keystore's tag, and a passphrase change still needs the old
// passphrase and leaves every earlier session stale.

import { describe, expect, it } from 'vitest';
import { PearlWallet, createMemoryStore, deriveAccountFromSeed, mnemonicToSeed, networks, parsePearl } from '../src/index.js';
import type { JsonValue } from '../src/index.js';
import { FAST_KDF, FakeChain, MNEMONIC, PASSPHRASE, STRANGER } from './wallet-chain.js';

const prl = (text: string): bigint => parsePearl(text);
const other = deriveAccountFromSeed(mnemonicToSeed('legal winner thank year wave sausage worth useful legal winner thank yellow'), networks.regtest, 0);

async function funded(options: { allowSessionExport?: boolean } = { allowSessionExport: true }) {
  const chain = new FakeChain();
  const store = createMemoryStore();
  const wallet = await PearlWallet.create({ store, backend: chain, passphrase: PASSPHRASE, mnemonic: MNEMONIC, kdf: FAST_KDF, gapLimit: 10, ...options });
  chain.pay(await wallet.receiveAddress(), prl('5'));
  chain.mine();
  await wallet.sync();
  return { chain, store, wallet };
}

describe('wallet sessions', () => {
  it('unlocks a reopened wallet from a session and sends from it', async () => {
    const { chain, store, wallet } = await funded();
    const session = await wallet.exportSession({ keyFormat: 'bytes' });
    const stored = JSON.parse(JSON.stringify({ ...session, key: Array.from(session.key) })) as typeof session & { key: number[] };
    // The worker stopped: nothing in memory survives but what was stored.
    const entries = new Map(await store.list(''));
    await wallet.close();
    const reopened = await PearlWallet.open({ store: createMemoryStore(entries), backend: chain, transactions: chain });
    expect(reopened.locked).toBe(true);
    await reopened.unlockWithSession({ ...stored, key: Uint8Array.from(stored.key) });
    expect(reopened.locked).toBe(false);
    const sent = await reopened.send({ recipients: [{ address: STRANGER, amount: prl('1') }], feeRate: 2000n });
    expect(chain.mempool.has(sent.txid)).toBe(true);
  });

  it('exports a session only when the unlock or create allowed it', async () => {
    const { wallet } = await funded({});
    await expect(wallet.exportSession()).rejects.toMatchObject({ code: 'KEYSTORE_SESSION_DISABLED' });
    wallet.lock();
    await expect(wallet.exportSession()).rejects.toMatchObject({ code: 'WALLET_LOCKED' });
    await wallet.unlock(PASSPHRASE, { allowSessionExport: true });
    expect((await wallet.exportSession()).key).toBeInstanceOf(CryptoKey);
  });

  it('refuses a session unlock when the store changed the accounts the keystore tagged', async () => {
    const { chain, store, wallet } = await funded();
    const session = await wallet.exportSession();
    const entries = new Map<string, JsonValue>(await store.list(''));
    entries.set('account:0', { ...(entries.get('account:0') as Record<string, JsonValue>), xpub: other.extendedPublicKey() });
    const victim = await PearlWallet.open({ store: createMemoryStore(entries), backend: chain, transactions: chain });
    await expect(victim.unlockWithSession(session)).rejects.toMatchObject({ code: 'KEYSTORE_TAMPERED' });
    expect(victim.locked).toBe(true);
  });

  it('needs the old passphrase to change it after a session unlock, and the change makes the session stale', async () => {
    const { chain, store, wallet } = await funded();
    const session = await wallet.exportSession();
    wallet.lock();
    await wallet.unlockWithSession(session);
    await expect(wallet.changePassphrase('not it', 'new passphrase', { kdf: FAST_KDF })).rejects.toMatchObject({ code: 'KEYSTORE_BAD_PASSPHRASE' });
    await wallet.changePassphrase(PASSPHRASE, 'new passphrase', { kdf: FAST_KDF });
    const reopened = await PearlWallet.open({ store: createMemoryStore(new Map(await store.list(''))), backend: chain, transactions: chain });
    await expect(reopened.unlockWithSession(session)).rejects.toMatchObject({ code: 'KEYSTORE_SESSION_STALE' });
    expect(reopened.locked).toBe(true);
  });

  it('refuses the session of another wallet made from the same phrase', async () => {
    const one = await funded();
    const two = await funded();
    await expect(two.wallet.unlockWithSession(await one.wallet.exportSession())).rejects.toMatchObject({ code: 'KEYSTORE_SESSION_STALE' });
  });
});
