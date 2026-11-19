// Sessions: the data key wrapped under a random session key, so a process
// that lost its memory unlocks again without the passphrase or scrypt. The
// wrap is checked against the pinned keystore's known data key, scrypt is
// counted to show the session path never runs it, and every way a session
// can be wrong (stale, foreign, another key, altered, malformed) fails with
// its own code while the checks a passphrase unlock makes still run.

import type * as Scrypt from '@noble/hashes/scrypt';
import { describe, expect, it, vi } from 'vitest';
import { createKeystore, openKeystore } from '../src/index.js';
import type { EncryptedKeystore, KeystoreSession } from '../src/index.js';

const calls = vi.hoisted(() => ({ scrypt: 0 }));
vi.mock('@noble/hashes/scrypt', async (importOriginal) => {
  const original = await importOriginal<typeof Scrypt>();
  return {
    ...original,
    scryptAsync: (...args: Parameters<typeof original.scryptAsync>) => {
      calls.scrypt += 1;
      return original.scryptAsync(...args);
    },
  };
});

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (text: string): Uint8Array => Uint8Array.from(text.match(/../g) ?? [], (b) => parseInt(b, 16));
const FAST = { kdf: { N: 2 ** 10 } };
const SEED = new Uint8Array(32).fill(0xab);
const secretOf = async (keystore: ReturnType<typeof openKeystore>, id: string): Promise<string> => keystore.useSecret(id, (bytes) => hex(bytes));

async function stocked(passphrase = 'pass') {
  const keystore = await createKeystore(passphrase, { ...FAST, allowSessionExport: true });
  await keystore.addSecret('seed', 'seed', SEED);
  return keystore;
}

describe('keystore sessions', () => {
  it('wraps the data key under the session key, bound to the keystore, and never holds the passphrase', async () => {
    // The pinned keystore of keystore.test.ts: its data key is the bytes 0x20 to 0x3f.
    const pinned: EncryptedKeystore = {
      format: 'pearljs-keystore',
      version: 1,
      kdf: { name: 'scrypt', N: 1024, r: 8, p: 1, salt: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f' },
      cipher: 'aes-256-gcm',
      key: { nonce: '404142434445464748494a4b', ciphertext: '9d4c30e99a1cab957dd8bfd7287731667c68e74fd71056c5bf86a7983a49086d741ca455825a66ee46e2096bc948290d' },
      secrets: { seed: { kind: 'seed', nonce: '58595a5b5c5d5e5f60616263', ciphertext: 'c9be72750bab9a2bf8f98ee0d3e41c2b119972c2af08a5764939ec81b5433b2623a6dd8ec99fea20d9a1449604302a6d' } },
      manifest: { nonce: '6465666768696a6b6c6d6e6f', ciphertext: 'fd1cd50856f58c5ceef61e17c5a26b02' },
    };
    const keystore = openKeystore(pinned);
    await keystore.unlock('pearl', { allowSessionExport: true });
    const session = await keystore.exportSession({ keyFormat: 'bytes' });
    const bound = `pearljs-keystore:1:session:pearljs-keystore:1:key:scrypt:1024:8:1:${pinned.kdf.salt}:${pinned.key.nonce}:${pinned.key.ciphertext}`;
    const binding = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(bound))));
    expect(session).toMatchObject({ format: 'pearljs-keystore-session', version: 1, keystore: binding });
    const key = await crypto.subtle.importKey('raw', session.key as Uint8Array<ArrayBuffer>, 'AES-GCM', false, ['decrypt']);
    const aad = new TextEncoder().encode(`pearljs-keystore:1:session:${binding}`);
    const opened = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unhex(session.wrapped.nonce) as Uint8Array<ArrayBuffer>, additionalData: aad }, key, unhex(session.wrapped.ciphertext) as Uint8Array<ArrayBuffer>);
    expect(hex(new Uint8Array(opened))).toBe(hex(Uint8Array.from({ length: 32 }, (_, i) => 32 + i)));
    const text = JSON.stringify({ ...session, key: hex(session.key) });
    expect(text).not.toContain('pearl"');
    expect(text).not.toContain(hex(new TextEncoder().encode('pearl')));
  });

  it.each(['cryptokey', 'bytes'] as const)('unlocks a fresh copy from a %s session without the passphrase or scrypt', async (keyFormat) => {
    const keystore = await stocked();
    const session = await keystore.exportSession({ keyFormat });
    const copy = openKeystore(keystore.toJSON());
    const before = calls.scrypt;
    await copy.unlockWithSession(session);
    expect(calls.scrypt).toBe(before);
    expect(copy.locked).toBe(false);
    expect(await secretOf(copy, 'seed')).toBe(hex(SEED));
    // Unlocking again, after a lock, works from the same session.
    copy.lock();
    await copy.unlockWithSession(session);
    expect(await secretOf(copy, 'seed')).toBe(hex(SEED));
  });

  it('gives a non-extractable CryptoKey unless bytes are asked for, and leaves the caller its bytes', async () => {
    const keystore = await stocked();
    const session = await keystore.exportSession();
    expect(session.key.extractable).toBe(false);
    expect(session.key.usages.sort()).toEqual(['unwrapKey', 'wrapKey']);
    await expect(crypto.subtle.exportKey('raw', session.key)).rejects.toThrow();
    const bytes = await keystore.exportSession({ keyFormat: 'bytes' });
    const kept = hex(bytes.key);
    await openKeystore(keystore.toJSON()).unlockWithSession(bytes);
    expect(hex(bytes.key)).toBe(kept);
    expect(kept).not.toBe('00'.repeat(32));
  });

  it('exports a session only from an unlock that allowed it', async () => {
    const keystore = await createKeystore('pass', FAST);
    await expect(keystore.exportSession()).rejects.toMatchObject({ name: 'KeystoreError', code: 'KEYSTORE_SESSION_DISABLED' });
    keystore.lock();
    await expect(keystore.exportSession()).rejects.toMatchObject({ code: 'KEYSTORE_LOCKED' });
    await keystore.unlock('pass', { allowSessionExport: true });
    const session = await keystore.exportSession();
    keystore.lock();
    await keystore.unlock('pass');
    await expect(keystore.exportSession()).rejects.toMatchObject({ code: 'KEYSTORE_SESSION_DISABLED' });
    keystore.lock();
    await keystore.unlockWithSession(session);
    await expect(keystore.exportSession()).rejects.toMatchObject({ code: 'KEYSTORE_SESSION_DISABLED' });
    keystore.lock();
    await keystore.unlockWithSession(session, { allowSessionExport: true });
    await openKeystore(keystore.toJSON()).unlockWithSession(await keystore.exportSession());
  });

  it('turns stale after a passphrase change, and the old passphrase is still what the change needs', async () => {
    const keystore = await stocked();
    const session = await keystore.exportSession();
    const before = keystore.toJSON();
    const copy = openKeystore(before);
    await copy.unlockWithSession(session);
    await expect(copy.changePassphrase('not it', 'new')).rejects.toMatchObject({ code: 'KEYSTORE_BAD_PASSPHRASE' });
    await copy.changePassphrase('pass', 'new');
    expect(copy.locked).toBe(false);
    await expect(openKeystore(copy.toJSON()).unlockWithSession(session)).rejects.toMatchObject({ name: 'KeystoreError', code: 'KEYSTORE_SESSION_STALE' });
    // A session made after the change opens the new copy and not the old one.
    copy.lock();
    await copy.unlock('new', { allowSessionExport: true });
    const fresh = await copy.exportSession();
    await openKeystore(copy.toJSON()).unlockWithSession(fresh);
    await expect(openKeystore(before).unlockWithSession(fresh)).rejects.toMatchObject({ code: 'KEYSTORE_SESSION_STALE' });
  });

  it('keeps a session working across a passphrase change made while it allows sessions', async () => {
    const keystore = await stocked();
    await keystore.changePassphrase('pass', 'new');
    const session = await keystore.exportSession();
    await openKeystore(keystore.toJSON()).unlockWithSession(session);
  });

  it('refuses the session of another keystore with the same passphrase', async () => {
    const one = await stocked();
    const two = await stocked();
    await expect(openKeystore(two.toJSON()).unlockWithSession(await one.exportSession())).rejects.toMatchObject({ code: 'KEYSTORE_SESSION_STALE' });
    // Relabelled as the other keystore's, the wrap no longer authenticates.
    const relabelled = { ...(await one.exportSession()), keystore: (await two.exportSession()).keystore };
    await expect(openKeystore(two.toJSON()).unlockWithSession(relabelled)).rejects.toMatchObject({ code: 'KEYSTORE_SESSION_INVALID' });
  });

  it('refuses a session under another key, altered, or malformed', async () => {
    const keystore = await stocked();
    const session = await keystore.exportSession({ keyFormat: 'bytes' });
    const copy = openKeystore(keystore.toJSON());
    const other = await keystore.exportSession({ keyFormat: 'bytes' });
    const flip = (text: string): string => (text[0] === '0' ? '1' : '0') + text.slice(1);
    const bad: [string, unknown][] = [
      ['another session key', { ...session, key: other.key }],
      ['another CryptoKey', { ...session, key: (await keystore.exportSession()).key }],
      ['an altered ciphertext', { ...session, wrapped: { ...session.wrapped, ciphertext: flip(session.wrapped.ciphertext) } }],
      ['an altered nonce', { ...session, wrapped: { ...session.wrapped, nonce: flip(session.wrapped.nonce) } }],
      ['a short ciphertext', { ...session, wrapped: { ...session.wrapped, ciphertext: session.wrapped.ciphertext.slice(2) } }],
      ['a short key', { ...session, key: session.key.slice(1) }],
      ['a key that cannot unwrap', { ...session, key: await crypto.subtle.importKey('raw', session.key as Uint8Array<ArrayBuffer>, 'AES-GCM', false, ['decrypt']) }],
      ['a hex string key', { ...session, key: hex(session.key) }],
      ['another format', { ...session, format: 'pearljs-keystore' }],
      ['another version', { ...session, version: 2 }],
      ['no wrapped key', { ...session, wrapped: null }],
      ['null', null],
    ];
    for (const [what, value] of bad) {
      await expect(copy.unlockWithSession(value as KeystoreSession), what).rejects.toMatchObject({ name: 'KeystoreError', code: 'KEYSTORE_SESSION_INVALID' });
      expect(copy.locked, what).toBe(true);
    }
    await copy.unlockWithSession(session);
  });

  it('still checks the set of secrets against its tag', async () => {
    const keystore = await stocked();
    const session = await keystore.exportSession();
    const data = keystore.toJSON();
    const removed = openKeystore({ ...data, secrets: {} });
    await expect(removed.unlockWithSession(session)).rejects.toMatchObject({ code: 'KEYSTORE_TAMPERED' });
    expect(removed.locked).toBe(true);
  });

  it('stays locked when lock is called while a session unlock is in flight', async () => {
    const keystore = await stocked();
    const session = await keystore.exportSession();
    const copy = openKeystore(keystore.toJSON());
    const unlocking = copy.unlockWithSession(session);
    copy.lock();
    await expect(unlocking).rejects.toMatchObject({ code: 'KEYSTORE_LOCKED' });
    expect(copy.locked).toBe(true);
  });

  it('locks itself after the timeout given to a session unlock', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const keystore = await stocked();
      const copy = openKeystore(keystore.toJSON());
      await copy.unlockWithSession(await keystore.exportSession(), { timeout: 1000 });
      vi.advanceTimersByTime(999);
      expect(copy.locked).toBe(false);
      vi.advanceTimersByTime(1);
      expect(copy.locked).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('checks that the scrypt it counts is the one the passphrase path runs', async () => {
    const before = calls.scrypt;
    await openKeystore((await stocked()).toJSON()).unlock('pass');
    expect(calls.scrypt).toBeGreaterThan(before);
  });
});
