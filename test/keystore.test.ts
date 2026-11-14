// The encrypted keystore: known answers for scrypt (RFC 7914) and
// AES-256-GCM (the GCM specification's test cases 13 and 14), a pinned
// keystore rebuilt from those primitives as docs/wallet.md describes it,
// wrong passphrases, tampering of every part, passphrase change, the
// unlock timeout, and secrets wiped after use.

import { scrypt } from '@noble/hashes/scrypt';
import { describe, expect, it } from 'vitest';
import { createKeystore, openKeystore } from '../src/index.js';
import type { EncryptedKeystore } from '../src/index.js';

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (text: string): Uint8Array => Uint8Array.from(text.match(/../g) ?? [], (b) => parseInt(b, 16));
const FAST = { kdf: { N: 2 ** 10 } };

// Made by createKeystore('pearl', { kdf: { N: 1024 }, random: counting bytes }) with a 32-byte seed of 0xab.
const PINNED: EncryptedKeystore = {
  format: 'pearljs-keystore',
  version: 1,
  kdf: { name: 'scrypt', N: 1024, r: 8, p: 1, salt: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f' },
  cipher: 'aes-256-gcm',
  key: {
    nonce: '404142434445464748494a4b',
    ciphertext: '9d4c30e99a1cab957dd8bfd7287731667c68e74fd71056c5bf86a7983a49086d741ca455825a66ee46e2096bc948290d',
  },
  secrets: {
    seed: {
      kind: 'seed',
      nonce: '4c4d4e4f5051525354555657',
      ciphertext: '667ce06aa43434a6e270e75a7b5938c052bf8bb8b282132dcab3d40bef19ec557aadc7f701a91ed18b85009ab5fd2be7',
    },
  },
};

async function gcm(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad = new Uint8Array(0)): Promise<string> {
  const imported = await crypto.subtle.importKey('raw', key as Uint8Array<ArrayBuffer>, 'AES-GCM', false, ['encrypt']);
  return hex(new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce as Uint8Array<ArrayBuffer>, additionalData: aad as Uint8Array<ArrayBuffer> }, imported, plaintext as Uint8Array<ArrayBuffer>)));
}

const secretOf = async (keystore: ReturnType<typeof openKeystore>, id: string): Promise<string> => keystore.useSecret(id, (bytes) => hex(bytes));

describe('keystore primitives', () => {
  it('derives the RFC 7914 scrypt test vectors', () => {
    expect(hex(scrypt('pleaseletmein', 'SodiumChloride', { N: 16384, r: 8, p: 1, dkLen: 64 }))).toBe(
      '7023bdcb3afd7348461c06cd81fd38ebfda8fbba904f8e3ea9b543f6545da1f2d5432955613f0fcf62d49705242a9af9e61e85dc0d651e40dfcf017b45575887',
    );
    expect(hex(scrypt('password', 'NaCl', { N: 1024, r: 8, p: 16, dkLen: 64 }))).toBe(
      'fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b3731622eaf30d92e22a3886ff109279d9830dac727afb94a83ee6d8360cbdfa2cc0640',
    );
  });

  it('encrypts the GCM specification test cases 13 and 14 for AES-256', async () => {
    expect(await gcm(new Uint8Array(32), new Uint8Array(12), new Uint8Array(0))).toBe('530f8afbc74536b9a963b4f1c4cb738b');
    expect(await gcm(new Uint8Array(32), new Uint8Array(12), new Uint8Array(16))).toBe('cea7403d4d606b6e074ec5d3baf39d18d0d1c8a799996bf0265b98b5d48ab919');
  });

  it('builds the pinned keystore from scrypt and AES-GCM as documented', async () => {
    const kek = scrypt('pearl', unhex(PINNED.kdf.salt), { N: 1024, r: 8, p: 1, dkLen: 32 });
    const dataKey = Uint8Array.from({ length: 32 }, (_, i) => 32 + i);
    const keyAad = new TextEncoder().encode(`pearljs-keystore:1:key:scrypt:1024:8:1:${PINNED.kdf.salt}`);
    expect(await gcm(kek, unhex(PINNED.key.nonce), dataKey, keyAad)).toBe(PINNED.key.ciphertext);
    const secretAad = new TextEncoder().encode('pearljs-keystore:1:secret:seed:seed');
    expect(await gcm(dataKey, unhex(PINNED.secrets.seed!.nonce), new Uint8Array(32).fill(0xab), secretAad)).toBe(PINNED.secrets.seed!.ciphertext);
  });

  it('makes the pinned keystore from the same random bytes', async () => {
    let n = 0;
    const keystore = await createKeystore('pearl', { kdf: { N: 1024 }, random: (length) => Uint8Array.from({ length }, () => n++ & 0xff) });
    await keystore.addSecret('seed', 'seed', new Uint8Array(32).fill(0xab));
    expect(keystore.toJSON()).toEqual(PINNED);
  });
});

describe('keystore', () => {
  it('opens the pinned keystore with its passphrase and no other', async () => {
    const keystore = openKeystore(PINNED);
    expect(keystore.locked).toBe(true);
    await expect(keystore.unlock('Pearl')).rejects.toThrow('wrong passphrase for this keystore');
    await keystore.unlock('pearl');
    expect(await secretOf(keystore, 'seed')).toBe('ab'.repeat(32));
  });

  it('fails authentication for any change to a ciphertext, nonce or the KDF parameters', async () => {
    const flip = (text: string): string => (text[0] === '0' ? '1' : '0') + text.slice(1);
    const tampered: [string, EncryptedKeystore][] = [
      ['wrapped key', { ...PINNED, key: { ...PINNED.key, ciphertext: flip(PINNED.key.ciphertext) } }],
      ['key nonce', { ...PINNED, key: { ...PINNED.key, nonce: flip(PINNED.key.nonce) } }],
      ['salt', { ...PINNED, kdf: { ...PINNED.kdf, salt: flip(PINNED.kdf.salt) } }],
      ['cost', { ...PINNED, kdf: { ...PINNED.kdf, N: 2048 } }],
    ];
    for (const [, data] of tampered) await expect(openKeystore(data).unlock('pearl')).rejects.toThrow('wrong passphrase');
    const secret = PINNED.secrets.seed!;
    const badSecrets: EncryptedKeystore['secrets'][] = [
      { seed: { ...secret, ciphertext: flip(secret.ciphertext) } },
      { seed: { ...secret, nonce: flip(secret.nonce) } },
      { seed: { ...secret, kind: 'wif' } },
      { seed: { ...secret, ciphertext: secret.ciphertext.slice(0, 40) } },
    ];
    for (const secrets of badSecrets) {
      const keystore = openKeystore({ ...PINNED, secrets });
      await keystore.unlock('pearl');
      await expect(secretOf(keystore, 'seed')).rejects.toThrow('keystore secret seed failed authentication');
    }
    // A ciphertext moved to another id does not open there.
    const moved = openKeystore({ ...PINNED, secrets: { other: secret } });
    await moved.unlock('pearl');
    await expect(secretOf(moved, 'other')).rejects.toThrow('failed authentication');
  });

  it('refuses parameters that would make unlocking exhaust memory, and malformed records', () => {
    expect(() => openKeystore({ ...PINNED, kdf: { ...PINNED.kdf, N: 2 ** 24 } })).toThrow('more than 1 GiB');
    expect(() => openKeystore({ ...PINNED, kdf: { ...PINNED.kdf, N: 1000 } })).toThrow('power of two');
    expect(() => openKeystore({ ...PINNED, version: 2 })).toThrow('version 2 is not supported');
    expect(() => openKeystore({ ...PINNED, key: { nonce: 'zz', ciphertext: '' } })).toThrow('not hex');
    expect(() => openKeystore({ format: 'other' })).toThrow('not a pearljs keystore');
  });

  it('changes the passphrase by rewrapping the data key only', async () => {
    const keystore = await createKeystore('first', FAST);
    await keystore.addSecret('seed', 'seed', new Uint8Array(32).fill(1));
    const before = keystore.toJSON();
    await expect(keystore.changePassphrase('wrong', 'second', FAST)).rejects.toThrow('wrong passphrase');
    await keystore.changePassphrase('first', 'second', FAST);
    const after = keystore.toJSON();
    expect(after.secrets).toEqual(before.secrets);
    expect(after.key).not.toEqual(before.key);
    const reopened = openKeystore(after);
    await expect(reopened.unlock('first')).rejects.toThrow('wrong passphrase');
    await reopened.unlock('second');
    expect(await secretOf(reopened, 'seed')).toBe('01'.repeat(32));
  });

  it('locks itself after the unlock timeout', async () => {
    const keystore = await createKeystore('pass', FAST);
    await keystore.addSecret('seed', 'seed', new Uint8Array(16));
    keystore.lock();
    let locks = 0;
    keystore.onLock(() => (locks += 1));
    await keystore.unlock('pass', { timeoutMs: 20 });
    expect(keystore.locked).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(keystore.locked).toBe(true);
    expect(locks).toBe(1);
    await expect(secretOf(keystore, 'seed')).rejects.toThrow('the keystore is locked');
  });

  it('overwrites a secret once its use is over, and keeps secrets out of errors', async () => {
    const keystore = await createKeystore('pass', FAST);
    await keystore.addSecret('seed', 'seed', new Uint8Array(32).fill(0x5a));
    let seen: Uint8Array | undefined;
    await keystore.useSecret('seed', (bytes) => {
      seen = bytes;
      expect(bytes.every((b) => b === 0x5a)).toBe(true);
    });
    expect(seen!.every((b) => b === 0)).toBe(true);
    await expect(keystore.useSecret('seed', () => Promise.reject(new Error('use failed')))).rejects.toThrow('use failed');
    const error = await openKeystore(keystore.toJSON())
      .unlock('a wrong passphrase')
      .catch((err: Error) => err);
    expect(String(error)).not.toContain('a wrong passphrase');
    expect(String(error)).not.toContain('5a5a');
  });

  it('refuses an empty passphrase', async () => {
    await expect(createKeystore('', FAST)).rejects.toThrow('must not be empty');
  });

  it('normalizes a passphrase so either Unicode form opens it', async () => {
    const keystore = await createKeystore('café', FAST);
    await keystore.addSecret('x', 'wif', new Uint8Array([1]));
    const reopened = openKeystore(keystore.toJSON());
    await reopened.unlock('café');
    expect(await secretOf(reopened, 'x')).toBe('01');
  });
});
