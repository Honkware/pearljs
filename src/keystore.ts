// Secrets encrypted at rest under a passphrase, in two layers as Oyster's
// address manager does it (waddrmgr/manager.go, snacl/snacl.go): scrypt
// turns the passphrase into a key-encryption key, which wraps a random data
// key, which encrypts each secret. Changing the passphrase rewraps the data
// key and leaves every secret's ciphertext as it was.
//
// The cipher is AES-256-GCM from WebCrypto, present in Node 20 and every
// current browser, so no cipher code ships with pearljs. Every ciphertext
// carries associated data naming what it is: the wrapped data key is bound
// to the KDF parameters it was wrapped under, and each secret to its id and
// kind, so no ciphertext can be moved to another record or have its
// parameters changed without failing authentication.
//
// While unlocked, only the data key is held, as a non-extractable CryptoKey
// whose bytes live in the WebCrypto implementation rather than the
// JavaScript heap. Secrets are decrypted for one use and overwritten after
// it. Locking drops the CryptoKey.

/**
 * An encrypted keystore: a mnemonic, seed, WIF keys and XMSS seeds under a
 * passphrase, with lock, unlock with a timeout, and passphrase change.
 *
 * @module
 */

import { scryptAsync } from '@noble/hashes/scrypt';
import { KeystoreError } from './errors.js';
import type { PearlErrorCode } from './errors.js';
import { toHex } from './internal/bytes.js';

/** What a keystore secret is. */
export type SecretKind = 'mnemonic' | 'seed' | 'wif' | 'xmss';

/** scrypt parameters as stored. */
export interface KeystoreKdf {
  name: 'scrypt';
  /** CPU and memory cost, a power of two. */
  N: number;
  r: number;
  p: number;
  /** 32 random bytes, hex. */
  salt: string;
}

/** An AES-256-GCM ciphertext as stored: a 12-byte nonce and the ciphertext with its 16-byte tag, both hex. */
export interface EncryptedBox {
  nonce: string;
  ciphertext: string;
}

/** A keystore as stored and exported. Everything in it is safe to keep next to the wallet; nothing in it opens without the passphrase. */
export interface EncryptedKeystore {
  format: 'pearljs-keystore';
  version: 1;
  kdf: KeystoreKdf;
  cipher: 'aes-256-gcm';
  /** The data key, wrapped under the key scrypt derives from the passphrase. */
  key: EncryptedBox;
  /** Each secret under the data key, by id. */
  secrets: Record<string, EncryptedBox & { kind: SecretKind }>;
}

/** Oyster's waddrmgr.DefaultScryptOptions (manager.go:122): N = 2^18, r = 8, p = 1, which takes 256 MiB. */
export const DEFAULT_KEYSTORE_KDF = { N: 2 ** 18, r: 8, p: 1 } as const;

// Bounds on what a stored keystore may ask for, so a crafted file cannot
// make unlock allocate gigabytes or spin for minutes.
const MIN_N = 2 ** 10;
const MAX_MEMORY = 2 ** 30;
const SALT_BYTES = 32;
const NONCE_BYTES = 12;
const KEY_BYTES = 32;
const TAG_BYTES = 16;
const AAD_PREFIX = 'pearljs-keystore:1';

/** Options for createKeystore and changePassphrase. */
export interface KeystoreOptions {
  /** scrypt cost; DEFAULT_KEYSTORE_KDF unless given. Lower N only for devices that cannot spare 256 MiB, and never below 2^14 for real funds. */
  kdf?: Partial<Pick<KeystoreKdf, 'N' | 'r' | 'p'>>;
  /** Source of random bytes; crypto.getRandomValues unless given. For known-answer tests only. */
  random?: (length: number) => Uint8Array;
}

/** Options for unlock. */
export interface UnlockOptions {
  /** Lock again after this many milliseconds. Stays unlocked until lock() unless given. */
  timeoutMs?: number;
}

const encoder = new TextEncoder();

// WebCrypto's types want an ArrayBuffer-backed view; every array here is one.
function buf(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (!(bytes.buffer instanceof ArrayBuffer)) throw new TypeError('keystore bytes must not be in a SharedArrayBuffer');
  return bytes as Uint8Array<ArrayBuffer>;
}

function fromHex(text: unknown, what: string, length?: number): Uint8Array {
  if (typeof text !== 'string' || text.length % 2 !== 0 || !/^[0-9a-f]*$/.test(text)) throw new KeystoreError('KEYSTORE_INVALID', `keystore ${what} is not hex`);
  const bytes = Uint8Array.from(text.match(/../g) ?? [], (byte) => parseInt(byte, 16));
  if (length !== undefined && bytes.length !== length) throw new KeystoreError('KEYSTORE_INVALID', `keystore ${what} must be ${length} bytes`);
  return bytes;
}

function defaultRandom(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function passphraseBytes(passphrase: string | Uint8Array): Uint8Array {
  const bytes = typeof passphrase === 'string' ? encoder.encode(passphrase.normalize('NFKD')) : Uint8Array.from(passphrase);
  if (bytes.length === 0) throw new KeystoreError('KEYSTORE_INVALID', 'the keystore passphrase must not be empty');
  return bytes;
}

function checkKdf(kdf: Partial<KeystoreKdf>): void {
  const { N, r, p } = kdf;
  if (kdf.name !== 'scrypt') throw new KeystoreError('KEYSTORE_INVALID', 'keystore KDF must be scrypt');
  if (!Number.isSafeInteger(N) || N! < MIN_N || (N! & (N! - 1)) !== 0) throw new KeystoreError('KEYSTORE_INVALID', `keystore scrypt N must be a power of two of at least ${MIN_N}`);
  if (!Number.isSafeInteger(r) || r! < 1 || r! > 32) throw new KeystoreError('KEYSTORE_INVALID', 'keystore scrypt r must be between 1 and 32');
  if (!Number.isSafeInteger(p) || p! < 1 || p! > 16) throw new KeystoreError('KEYSTORE_INVALID', 'keystore scrypt p must be between 1 and 16');
  if (128 * N! * r! > MAX_MEMORY) throw new KeystoreError('KEYSTORE_INVALID', 'keystore scrypt parameters need more than 1 GiB');
  fromHex(kdf.salt, 'salt', SALT_BYTES);
}

function keyAad(kdf: KeystoreKdf): Uint8Array {
  return encoder.encode(`${AAD_PREFIX}:key:scrypt:${kdf.N}:${kdf.r}:${kdf.p}:${kdf.salt}`);
}

function secretAad(id: string, kind: SecretKind): Uint8Array {
  return encoder.encode(`${AAD_PREFIX}:secret:${kind}:${id}`);
}

async function importAesKey(raw: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  try {
    return await crypto.subtle.importKey('raw', buf(raw), 'AES-GCM', false, usages);
  } finally {
    raw.fill(0);
  }
}

async function deriveKek(passphrase: string | Uint8Array, kdf: KeystoreKdf): Promise<CryptoKey> {
  const password = passphraseBytes(passphrase);
  try {
    const raw = await scryptAsync(password, fromHex(kdf.salt, 'salt'), { N: kdf.N, r: kdf.r, p: kdf.p, dkLen: KEY_BYTES });
    return await importAesKey(raw, ['encrypt', 'decrypt']);
  } finally {
    password.fill(0);
  }
}

async function seal(key: CryptoKey, plaintext: Uint8Array, aad: Uint8Array, random: (length: number) => Uint8Array): Promise<EncryptedBox> {
  const nonce = random(NONCE_BYTES);
  if (!(nonce instanceof Uint8Array) || nonce.length !== NONCE_BYTES) throw new RangeError('random source returned the wrong length');
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(nonce), additionalData: buf(aad) }, key, buf(plaintext)));
  return { nonce: toHex(nonce), ciphertext: toHex(ciphertext) };
}

// Rejects with KeystoreError `code` for any authentication error; the cause is left
// out, since it says nothing a caller can use.
async function open(key: CryptoKey, box: EncryptedBox, aad: Uint8Array, code: PearlErrorCode, failure: string): Promise<Uint8Array> {
  const nonce = fromHex(box.nonce, 'nonce', NONCE_BYTES);
  const ciphertext = fromHex(box.ciphertext, 'ciphertext');
  if (ciphertext.length < TAG_BYTES) throw new KeystoreError(code, failure);
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(nonce), additionalData: buf(aad) }, key, buf(ciphertext)));
  } catch {
    throw new KeystoreError(code, failure);
  }
}

function parseKeystore(data: unknown): EncryptedKeystore {
  const value = data as Partial<EncryptedKeystore> | null;
  if (value === null || typeof value !== 'object' || value.format !== 'pearljs-keystore') throw new KeystoreError('KEYSTORE_INVALID', 'not a pearljs keystore');
  if (value.version !== 1) throw new KeystoreError('KEYSTORE_INVALID', `keystore version ${String(value.version)} is not supported; this pearljs reads version 1`);
  if (value.cipher !== 'aes-256-gcm') throw new KeystoreError('KEYSTORE_INVALID', 'keystore cipher must be aes-256-gcm');
  checkKdf(value.kdf ?? {});
  const box = (item: unknown, what: string): EncryptedBox => {
    const b = item as Partial<EncryptedBox> | null;
    if (b === null || typeof b !== 'object') throw new KeystoreError('KEYSTORE_INVALID', `keystore ${what} is missing`);
    fromHex(b.nonce, `${what} nonce`, NONCE_BYTES);
    fromHex(b.ciphertext, `${what} ciphertext`);
    return { nonce: b.nonce!, ciphertext: b.ciphertext! };
  };
  const key = box(value.key, 'key');
  if (value.secrets === null || typeof value.secrets !== 'object' || Array.isArray(value.secrets)) throw new KeystoreError('KEYSTORE_INVALID', 'keystore secrets are missing');
  const secrets: EncryptedKeystore['secrets'] = {};
  for (const [id, item] of Object.entries(value.secrets)) {
    const kind = (item as { kind?: unknown }).kind;
    if (kind !== 'mnemonic' && kind !== 'seed' && kind !== 'wif' && kind !== 'xmss') throw new KeystoreError('KEYSTORE_INVALID', `keystore secret ${id} has an unknown kind`);
    secrets[id] = { kind, ...box(item, `secret ${id}`) };
  }
  return { format: 'pearljs-keystore', version: 1, kdf: { ...value.kdf! }, cipher: 'aes-256-gcm', key, secrets };
}

/**
 * Encrypted secrets under one passphrase. A keystore made by createKeystore
 * starts unlocked; one read by openKeystore starts locked.
 */
export class Keystore {
  #data: EncryptedKeystore;
  #key: CryptoKey | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #random: (length: number) => Uint8Array;
  #listeners = new Set<() => void>();

  /** @internal Use createKeystore or openKeystore. */
  constructor(data: EncryptedKeystore, key: CryptoKey | null, random: (length: number) => Uint8Array) {
    this.#data = data;
    this.#key = key;
    this.#random = random;
  }

  /** The keystore as stored: JSON-compatible, and useless without the passphrase. */
  toJSON(): EncryptedKeystore {
    return JSON.parse(JSON.stringify(this.#data)) as EncryptedKeystore;
  }

  get locked(): boolean {
    return this.#key === null;
  }

  /** Ids of the secrets held, with their kinds. */
  secrets(): { id: string; kind: SecretKind }[] {
    return Object.entries(this.#data.secrets).map(([id, { kind }]) => ({ id, kind }));
  }

  has(id: string): boolean {
    return Object.hasOwn(this.#data.secrets, id);
  }

  /**
   * Derives the key from the passphrase and unwraps the data key. Rejects
   * with KEYSTORE_BAD_PASSPHRASE when the passphrase, or anything the data
   * key is bound to, is not what the keystore was made with.
   */
  async unlock(passphrase: string | Uint8Array, options: UnlockOptions = {}): Promise<void> {
    const { timeoutMs } = options;
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw new RangeError('timeoutMs must be a positive number');
    const kek = await deriveKek(passphrase, this.#data.kdf);
    const raw = await open(kek, this.#data.key, keyAad(this.#data.kdf), 'KEYSTORE_BAD_PASSPHRASE', 'wrong passphrase for this keystore');
    if (raw.length !== KEY_BYTES) {
      raw.fill(0);
      throw new KeystoreError('KEYSTORE_TAMPERED', 'the keystore data key has the wrong length');
    }
    this.#key = await importAesKey(raw, ['encrypt', 'decrypt']);
    this.#schedule(timeoutMs);
  }

  /** Forgets the data key. Secrets cannot be read or added until unlock. */
  lock(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    const wasUnlocked = this.#key !== null;
    this.#key = null;
    if (wasUnlocked) for (const listener of this.#listeners) listener();
  }

  /** Calls listener whenever the keystore locks, by lock() or by its timeout. Returns a function that removes it. */
  onLock(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Checks the old passphrase, then wraps the same data key under a new one
   * with a fresh salt. The secrets' ciphertexts do not change. Leaves the
   * keystore locked or unlocked as it was.
   */
  async changePassphrase(oldPassphrase: string | Uint8Array, newPassphrase: string | Uint8Array, options: KeystoreOptions = {}): Promise<void> {
    const oldKek = await deriveKek(oldPassphrase, this.#data.kdf);
    const raw = await open(oldKek, this.#data.key, keyAad(this.#data.kdf), 'KEYSTORE_BAD_PASSPHRASE', 'wrong passphrase for this keystore');
    try {
      const kdf = newKdf(options, this.#random);
      const kek = await deriveKek(newPassphrase, kdf);
      const key = await seal(kek, raw, keyAad(kdf), this.#random);
      this.#data = { ...this.#data, kdf, key };
    } finally {
      raw.fill(0);
    }
  }

  /** Encrypts and adds a secret under id, replacing one of that id. Needs the keystore unlocked. The bytes are copied, not wiped. */
  async addSecret(id: string, kind: SecretKind, secret: Uint8Array): Promise<void> {
    if (typeof id !== 'string' || id.length === 0) throw new TypeError('secret id must be a non-empty string');
    const box = await seal(this.#unlocked(), secret, secretAad(id, kind), this.#random);
    this.#data = { ...this.#data, secrets: { ...this.#data.secrets, [id]: { kind, ...box } } };
  }

  removeSecret(id: string): void {
    const secrets = { ...this.#data.secrets };
    delete secrets[id];
    this.#data = { ...this.#data, secrets };
  }

  /**
   * Decrypts one secret, hands it to use, and overwrites it when use
   * settles. use must not keep the bytes. Rejects with KEYSTORE_LOCKED,
   * KEYSTORE_NO_SECRET, or KEYSTORE_TAMPERED when its ciphertext fails
   * authentication.
   */
  async useSecret<T>(id: string, use: (secret: Uint8Array, kind: SecretKind) => T | Promise<T>): Promise<T> {
    const key = this.#unlocked();
    const box = this.#data.secrets[id];
    if (box === undefined) throw new KeystoreError('KEYSTORE_NO_SECRET', `the keystore has no secret ${id}`);
    const secret = await open(key, box, secretAad(id, box.kind), 'KEYSTORE_TAMPERED', `keystore secret ${id} failed authentication; the keystore has been altered or damaged`);
    try {
      return await use(secret, box.kind);
    } finally {
      secret.fill(0);
    }
  }

  #unlocked(): CryptoKey {
    if (this.#key === null) throw new KeystoreError('KEYSTORE_LOCKED', 'the keystore is locked; unlock it with the passphrase first');
    return this.#key;
  }

  #schedule(timeoutMs: number | undefined): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    if (timeoutMs === undefined) return;
    this.#timer = setTimeout(() => this.lock(), timeoutMs);
    // A pending lock should not keep a Node process alive.
    (this.#timer as { unref?: () => void }).unref?.();
  }
}

function newKdf(options: KeystoreOptions, random: (length: number) => Uint8Array): KeystoreKdf {
  const salt = random(SALT_BYTES);
  if (!(salt instanceof Uint8Array) || salt.length !== SALT_BYTES) throw new RangeError('random source returned the wrong length');
  const kdf: KeystoreKdf = { name: 'scrypt', ...DEFAULT_KEYSTORE_KDF, ...options.kdf, salt: toHex(salt) };
  checkKdf(kdf);
  return kdf;
}

/** Makes an empty keystore under passphrase, unlocked. */
export async function createKeystore(passphrase: string | Uint8Array, options: KeystoreOptions = {}): Promise<Keystore> {
  const random = options.random ?? defaultRandom;
  const kdf = newKdf(options, random);
  const kek = await deriveKek(passphrase, kdf);
  const raw = Uint8Array.from(random(KEY_BYTES));
  try {
    if (raw.length !== KEY_BYTES) throw new RangeError('random source returned the wrong length');
    const key = await seal(kek, raw, keyAad(kdf), random);
    const data: EncryptedKeystore = { format: 'pearljs-keystore', version: 1, kdf, cipher: 'aes-256-gcm', key, secrets: {} };
    return new Keystore(data, await importAesKey(raw, ['encrypt', 'decrypt']), random);
  } finally {
    raw.fill(0);
  }
}

/** Reads a stored keystore, checking its shape and parameters (KEYSTORE_INVALID). It starts locked. */
export function openKeystore(data: unknown, options: Pick<KeystoreOptions, 'random'> = {}): Keystore {
  return new Keystore(parseKeystore(data), null, options.random ?? defaultRandom);
}
