// Secrets encrypted at rest under a passphrase, in two layers as Oyster's
// address manager does it (waddrmgr/manager.go, snacl/snacl.go): scrypt
// turns the passphrase into a key-encryption key, which wraps a random data
// key, which encrypts each secret. Changing the passphrase makes a new data
// key and encrypts every secret again under it, so what the old passphrase
// and an old copy of the keystore open stops at the change.
//
// The cipher is AES-256-GCM from WebCrypto, present in Node 20 and every
// current browser, so no cipher code ships with pearljs. Every ciphertext
// carries associated data naming what it is: the wrapped data key is bound
// to the KDF parameters it was wrapped under, and each secret to its id and
// kind, so no ciphertext can be moved to another record or have its
// parameters changed without failing authentication. The set of secrets is
// authenticated too: a tag under the data key over every secret's id, kind
// and nonce, checked on unlock, so a secret cannot be removed, added or
// swapped for an older ciphertext of itself unnoticed. The same key
// authenticates data its owner hands it (authenticate, verify), which is how
// a wallet binds its account records to its keys.
//
// While unlocked, only the data key is held, as a non-extractable CryptoKey
// whose bytes live in the WebCrypto implementation rather than the
// JavaScript heap. Secrets are decrypted for one use and overwritten after
// it. Locking drops the CryptoKey.
//
// A session lets a process that lost its memory (an extension's service
// worker, stopped when idle) unlock again without the passphrase or scrypt:
// the data key wrapped under a fresh random session key, which the
// application keeps where its platform keeps short-lived secrets. The wrap
// is bound to the keystore as it is (KDF parameters, salt and wrapped data
// key), so a passphrase change or another keystore makes the session stale,
// and the unwrapped key must still open the tag over the set of secrets.
// Exporting needs the data key as a second, wrappable CryptoKey, held only
// when the unlock asked for it (allowSessionExport); wrapKey and unwrapKey
// move the data key without its bytes reaching the JavaScript heap.

/**
 * An encrypted keystore: a mnemonic, seed, WIF keys and XMSS seeds under a
 * passphrase, with lock, unlock with a timeout, passphrase change, and tags
 * that authenticate data kept beside it.
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
  /** A tag under the data key over the id, kind and nonce of every secret; its ciphertext is the 16-byte tag alone. */
  manifest: EncryptedBox;
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

/** The longest unlock timeout: what a timer can hold, a little under 25 days. */
export const MAX_UNLOCK_TIMEOUT_MS = 2 ** 31 - 1;

export interface UnlockOptions {
  /** Lock again after this many milliseconds, at most MAX_UNLOCK_TIMEOUT_MS. Stays unlocked until lock() unless given. */
  timeout?: number;
  /** Keep a wrappable copy of the data key until lock, so exportSession works. Off unless given. */
  allowSessionExport?: boolean;
}

/**
 * The data key of one keystore wrapped under a session key, from
 * exportSession. Whoever holds all of it, with the keystore, can read every
 * secret until the passphrase changes; it does not reveal the passphrase.
 * Everything but `key` is JSON. `key` is a non-extractable CryptoKey (keep
 * it in IndexedDB, which stores it without exposing its bytes) or 32 bytes
 * (for storage that holds only JSON, such as chrome.storage.session).
 */
export interface KeystoreSession<Key extends CryptoKey | Uint8Array = CryptoKey | Uint8Array> {
  format: 'pearljs-keystore-session';
  version: 1;
  /** SHA-256, hex, over the keystore's KDF parameters, salt and wrapped data key: what the session is bound to. */
  keystore: string;
  /** The data key under `key`, AES-256-GCM, with `keystore` as associated data. */
  wrapped: EncryptedBox;
  key: Key;
}

/** Options for exportSession. */
export interface ExportSessionOptions {
  /** 'cryptokey' (the default) for a non-extractable CryptoKey, 'bytes' for the session key's 32 bytes. */
  keyFormat?: 'cryptokey' | 'bytes';
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

function manifestAad(secrets: EncryptedKeystore['secrets']): Uint8Array {
  const list = Object.keys(secrets)
    .sort()
    .map((id) => [id, secrets[id]!.kind, secrets[id]!.nonce]);
  return encoder.encode(`${AAD_PREFIX}:manifest:${JSON.stringify(list)}`);
}

function macAad(context: string, message: string): Uint8Array {
  if (typeof context !== 'string' || context.length === 0 || context.includes(':')) throw new TypeError('context must be a non-empty string without a colon');
  if (typeof message !== 'string') throw new TypeError('message must be a string');
  return encoder.encode(`${AAD_PREFIX}:mac:${context}:${message}`);
}

async function sessionBinding(data: EncryptedKeystore): Promise<string> {
  const bound = encoder.encode(`${AAD_PREFIX}:session:${new TextDecoder().decode(keyAad(data.kdf))}:${data.key.nonce}:${data.key.ciphertext}`);
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', buf(bound))));
}

function sessionAad(binding: string): Uint8Array {
  return encoder.encode(`${AAD_PREFIX}:session:${binding}`);
}

const SESSION_INVALID = 'the session is not a pearljs keystore session, or its key does not open it';

async function sessionKey(key: unknown): Promise<CryptoKey> {
  if (typeof CryptoKey !== 'undefined' && key instanceof CryptoKey) {
    const algorithm = key.algorithm as AesKeyAlgorithm;
    if (key.type !== 'secret' || algorithm.name !== 'AES-GCM' || algorithm.length !== 256 || !key.usages.includes('unwrapKey')) throw new KeystoreError('KEYSTORE_SESSION_INVALID', 'the session key must be an AES-256-GCM key that can unwrap');
    return key;
  }
  if (!(key instanceof Uint8Array) || key.length !== KEY_BYTES) throw new KeystoreError('KEYSTORE_SESSION_INVALID', 'the session key must be a CryptoKey or 32 bytes');
  // A copy, wiped by importAesKey: the caller's bytes are the caller's to keep or wipe.
  return importAesKey(Uint8Array.from(key), ['unwrapKey']);
}

const EMPTY = new Uint8Array(0);
const TAMPERED_SET = 'the keystore set of secrets failed authentication: a secret was added, removed or replaced outside the keystore, or the keystore was damaged';

function checkTimeout(timeout: number | undefined): void {
  if (timeout === undefined) return;
  if (!Number.isFinite(timeout) || timeout <= 0) throw new RangeError('timeout must be a positive number');
  // A timer takes a 32-bit delay and runs a longer one at once.
  if (timeout > MAX_UNLOCK_TIMEOUT_MS) throw new RangeError(`timeout must be at most ${MAX_UNLOCK_TIMEOUT_MS}; leave it out to stay unlocked until lock()`);
}

async function importAesKey(raw: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  try {
    return await crypto.subtle.importKey('raw', buf(raw), 'AES-GCM', false, usages);
  } finally {
    raw.fill(0);
  }
}

// The data key as a non-extractable key for use and, if asked for, an extractable one whose only purpose is wrapKey. Wipes raw.
async function importDataKey(raw: Uint8Array, wrappable: boolean): Promise<[CryptoKey, CryptoKey | null]> {
  try {
    // WebCrypto refuses a secret key with no usages; 'encrypt' is the least this copy can be given.
    const exportable = wrappable ? await crypto.subtle.importKey('raw', buf(raw), 'AES-GCM', true, ['encrypt']) : null;
    return [await importAesKey(raw, ['encrypt', 'decrypt']), exportable];
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
  const manifest = box(value.manifest, 'manifest');
  return { format: 'pearljs-keystore', version: 1, kdf: { ...value.kdf! }, cipher: 'aes-256-gcm', key, secrets, manifest };
}

/**
 * Encrypted secrets under one passphrase. A keystore made by createKeystore
 * starts unlocked; one read by openKeystore starts locked.
 */
export class Keystore {
  #data: EncryptedKeystore;
  #key: CryptoKey | null = null;
  // The data key again, extractable, for exportSession; null unless the unlock allowed sessions.
  #wrappable: CryptoKey | null = null;
  #bySession = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #random: (length: number) => Uint8Array;
  #listeners = new Set<() => void>();
  // Counts lock() calls, so an unlock that was overtaken by one does not undo it.
  #generation = 0;
  // Changes to the stored data run one at a time: each reads the set of secrets and writes a tag over it.
  #changes: Promise<unknown> = Promise.resolve();

  /** @internal Use createKeystore or openKeystore. */
  constructor(data: EncryptedKeystore, key: CryptoKey | null, random: (length: number) => Uint8Array, wrappable: CryptoKey | null = null) {
    this.#data = data;
    this.#key = key;
    this.#wrappable = wrappable;
    this.#random = random;
  }

  /** The keystore as stored: JSON-compatible, and useless without the passphrase. */
  toJSON(): EncryptedKeystore {
    return JSON.parse(JSON.stringify(this.#data)) as EncryptedKeystore;
  }

  get locked(): boolean {
    return this.#key === null;
  }

  /** True while unlocked by unlockWithSession, so without anyone having typed the passphrase. */
  get unlockedBySession(): boolean {
    return this.#key !== null && this.#bySession;
  }

  /** Rejects with KEYSTORE_BAD_PASSPHRASE unless this is the keystore's passphrase. Runs scrypt; changes nothing. */
  async checkPassphrase(passphrase: string | Uint8Array): Promise<void> {
    const data = this.#data;
    const kek = await deriveKek(passphrase, data.kdf);
    (await open(kek, data.key, keyAad(data.kdf), 'KEYSTORE_BAD_PASSPHRASE', 'wrong passphrase for this keystore')).fill(0);
  }

  /** Ids of the secrets held, with their kinds. */
  secrets(): { id: string; kind: SecretKind }[] {
    return Object.entries(this.#data.secrets).map(([id, { kind }]) => ({ id, kind }));
  }

  has(id: string): boolean {
    return Object.hasOwn(this.#data.secrets, id);
  }

  /**
   * Derives the key from the passphrase, unwraps the data key and checks the
   * set of secrets against its tag. Rejects with KEYSTORE_BAD_PASSPHRASE
   * when the passphrase, or anything the data key is bound to, is not what
   * the keystore was made with; with KEYSTORE_TAMPERED when a secret was
   * added, removed or replaced; and with KEYSTORE_LOCKED when lock() was
   * called while it was working, in which case the keystore stays locked.
   */
  async unlock(passphrase: string | Uint8Array, options: UnlockOptions = {}): Promise<void> {
    const { timeout } = options;
    checkTimeout(timeout);
    const generation = this.#generation;
    const data = this.#data;
    const kek = await deriveKek(passphrase, data.kdf);
    const raw = await open(kek, data.key, keyAad(data.kdf), 'KEYSTORE_BAD_PASSPHRASE', 'wrong passphrase for this keystore');
    if (raw.length !== KEY_BYTES) {
      raw.fill(0);
      throw new KeystoreError('KEYSTORE_TAMPERED', 'the keystore data key has the wrong length');
    }
    const [key, wrappable] = await importDataKey(raw, options.allowSessionExport === true);
    await this.#finishUnlock(generation, data, key, wrappable, timeout, false);
  }

  /**
   * Unlocks from a session that exportSession made, without the passphrase
   * and without scrypt, and checks the set of secrets as unlock does.
   * Rejects with KEYSTORE_SESSION_STALE when the session belongs to another
   * keystore or to this one before a passphrase change; with
   * KEYSTORE_SESSION_INVALID when it is malformed or its key does not open
   * it; and with KEYSTORE_TAMPERED and KEYSTORE_LOCKED as unlock does.
   */
  async unlockWithSession(session: KeystoreSession, options: UnlockOptions = {}): Promise<void> {
    const { timeout } = options;
    checkTimeout(timeout);
    const generation = this.#generation;
    const data = this.#data;
    const value = session as Partial<KeystoreSession> | null;
    if (value === null || typeof value !== 'object' || value.format !== 'pearljs-keystore-session' || value.version !== 1 || typeof value.keystore !== 'string') throw new KeystoreError('KEYSTORE_SESSION_INVALID', SESSION_INVALID);
    const wrapped = value.wrapped as Partial<EncryptedBox> | undefined;
    if (wrapped === null || typeof wrapped !== 'object' || typeof wrapped.nonce !== 'string' || typeof wrapped.ciphertext !== 'string') throw new KeystoreError('KEYSTORE_SESSION_INVALID', SESSION_INVALID);
    const binding = await sessionBinding(data);
    if (value.keystore !== binding) throw new KeystoreError('KEYSTORE_SESSION_STALE', 'the session belongs to another keystore, or to this one before its passphrase changed; unlock with the passphrase');
    const unwrapping = await sessionKey(value.key);
    let nonce: Uint8Array;
    let ciphertext: Uint8Array;
    try {
      nonce = fromHex(wrapped.nonce, 'session nonce', NONCE_BYTES);
      ciphertext = fromHex(wrapped.ciphertext, 'session ciphertext', KEY_BYTES + TAG_BYTES);
    } catch {
      throw new KeystoreError('KEYSTORE_SESSION_INVALID', SESSION_INVALID);
    }
    const params = { name: 'AES-GCM', iv: buf(nonce), additionalData: buf(sessionAad(binding)) };
    let key: CryptoKey;
    let wrappable: CryptoKey | null = null;
    try {
      key = await crypto.subtle.unwrapKey('raw', buf(ciphertext), unwrapping, params, 'AES-GCM', false, ['encrypt', 'decrypt']);
      if (options.allowSessionExport === true) wrappable = await crypto.subtle.unwrapKey('raw', buf(ciphertext), unwrapping, params, 'AES-GCM', true, ['encrypt']);
    } catch {
      throw new KeystoreError('KEYSTORE_SESSION_INVALID', SESSION_INVALID);
    }
    await this.#finishUnlock(generation, data, key, wrappable, timeout, true);
  }

  /**
   * The data key wrapped under a new random session key, for
   * unlockWithSession in a later process. Needs the keystore unlocked with
   * allowSessionExport (KEYSTORE_SESSION_DISABLED otherwise). Each call
   * makes a new session key; a session stays usable until the passphrase
   * changes, and locking does not end it, so delete the stored session
   * when the application locks. The session key is the only secret in it.
   */
  async exportSession(options?: { keyFormat?: 'cryptokey' }): Promise<KeystoreSession<CryptoKey>>;
  async exportSession(options: { keyFormat: 'bytes' }): Promise<KeystoreSession<Uint8Array>>;
  async exportSession(options?: ExportSessionOptions): Promise<KeystoreSession>;
  async exportSession(options: ExportSessionOptions = {}): Promise<KeystoreSession> {
    const format = options.keyFormat ?? 'cryptokey';
    if (format !== 'cryptokey' && format !== 'bytes') throw new TypeError("keyFormat must be 'cryptokey' or 'bytes'");
    this.#unlocked();
    const wrappable = this.#wrappable;
    if (wrappable === null) throw new KeystoreError('KEYSTORE_SESSION_DISABLED', 'this unlock did not allow sessions; unlock with allowSessionExport');
    const binding = await sessionBinding(this.#data);
    const session = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, format === 'bytes', ['wrapKey', 'unwrapKey']);
    const nonce = this.#random(NONCE_BYTES);
    if (!(nonce instanceof Uint8Array) || nonce.length !== NONCE_BYTES) throw new RangeError('random source returned the wrong length');
    const wrapped = new Uint8Array(await crypto.subtle.wrapKey('raw', wrappable, session, { name: 'AES-GCM', iv: buf(nonce), additionalData: buf(sessionAad(binding)) }));
    const key = format === 'bytes' ? new Uint8Array(await crypto.subtle.exportKey('raw', session)) : session;
    return { format: 'pearljs-keystore-session', version: 1, keystore: binding, wrapped: { nonce: toHex(nonce), ciphertext: toHex(wrapped) }, key };
  }

  async #finishUnlock(generation: number, data: EncryptedKeystore, key: CryptoKey, wrappable: CryptoKey | null, timeout: number | undefined, bySession: boolean): Promise<void> {
    await open(key, data.manifest, manifestAad(data.secrets), 'KEYSTORE_TAMPERED', TAMPERED_SET);
    // The work above takes a second or so, in which lock() may have been called or the keystore changed: neither is undone here.
    if (generation !== this.#generation || data !== this.#data) throw new KeystoreError('KEYSTORE_LOCKED', 'the keystore was locked or changed while it was unlocking; it stays as that left it');
    this.#key = key;
    this.#wrappable = wrappable;
    this.#bySession = bySession;
    this.#schedule(timeout);
  }

  /** Forgets the data key. Secrets cannot be read or added until unlock, and an unlock still in flight fails. */
  lock(): void {
    this.#generation += 1;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    const wasUnlocked = this.#key !== null;
    this.#key = null;
    this.#wrappable = null;
    if (wasUnlocked) for (const listener of this.#listeners) listener();
  }

  /** Calls listener whenever the keystore locks, by lock() or by its timeout. Returns a function that removes it. */
  onLock(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Checks the old passphrase, then makes a new data key, encrypts every
   * secret again under it, and wraps it under the new passphrase with a
   * fresh salt. The old passphrase and an older copy of the keystore still
   * open the secrets that copy holds, and nothing added after the change.
   * Tags made by authenticate before the change no longer verify. Leaves the
   * keystore locked or unlocked as it was.
   */
  async changePassphrase(oldPassphrase: string | Uint8Array, newPassphrase: string | Uint8Array, options: KeystoreOptions = {}): Promise<void> {
    await this.#change(async () => {
      const data = this.#data;
      const oldKek = await deriveKek(oldPassphrase, data.kdf);
      const oldKey = await importAesKey(await open(oldKek, data.key, keyAad(data.kdf), 'KEYSTORE_BAD_PASSPHRASE', 'wrong passphrase for this keystore'), ['encrypt', 'decrypt']);
      await open(oldKey, data.manifest, manifestAad(data.secrets), 'KEYSTORE_TAMPERED', TAMPERED_SET);
      const kdf = newKdf(options, this.#random);
      const kek = await deriveKek(newPassphrase, kdf);
      const raw = Uint8Array.from(this.#random(KEY_BYTES));
      let key: CryptoKey;
      let wrappable: CryptoKey | null;
      let wrapped: EncryptedBox;
      try {
        if (raw.length !== KEY_BYTES) throw new RangeError('random source returned the wrong length');
        wrapped = await seal(kek, raw, keyAad(kdf), this.#random);
        [key, wrappable] = await importDataKey(raw, this.#wrappable !== null);
      } finally {
        raw.fill(0);
      }
      const secrets: EncryptedKeystore['secrets'] = {};
      for (const [id, box] of Object.entries(data.secrets)) {
        const secret = await open(oldKey, box, secretAad(id, box.kind), 'KEYSTORE_TAMPERED', `keystore secret ${id} failed authentication; the keystore has been altered or damaged`);
        try {
          secrets[id] = { kind: box.kind, ...(await seal(key, secret, secretAad(id, box.kind), this.#random)) };
        } finally {
          secret.fill(0);
        }
      }
      const manifest = await seal(key, EMPTY, manifestAad(secrets), this.#random);
      this.#data = { ...data, kdf, key: wrapped, secrets, manifest };
      if (this.#key !== null) {
        this.#key = key;
        this.#wrappable = wrappable;
        this.#bySession = false;
      }
    });
  }

  /** Encrypts and adds a secret under id, replacing one of that id. Needs the keystore unlocked. The bytes are copied, not wiped. */
  async addSecret(id: string, kind: SecretKind, secret: Uint8Array): Promise<void> {
    if (typeof id !== 'string' || id.length === 0) throw new TypeError('secret id must be a non-empty string');
    await this.#change(async () => {
      const key = this.#unlocked();
      const box = await seal(key, secret, secretAad(id, kind), this.#random);
      const secrets = { ...this.#data.secrets, [id]: { kind, ...box } };
      const manifest = await seal(key, EMPTY, manifestAad(secrets), this.#random);
      this.#data = { ...this.#data, secrets, manifest };
    });
  }

  /** Removes a secret. Needs the keystore unlocked, since the set of secrets is authenticated. */
  async removeSecret(id: string): Promise<void> {
    await this.#change(async () => {
      const key = this.#unlocked();
      const secrets = { ...this.#data.secrets };
      delete secrets[id];
      const manifest = await seal(key, EMPTY, manifestAad(secrets), this.#random);
      this.#data = { ...this.#data, secrets, manifest };
    });
  }

  /**
   * A tag under the data key over context and message, for data kept beside
   * the keystore that must not change behind its back. Needs the keystore
   * unlocked. The tag is a box with an empty plaintext; verify checks it.
   */
  async authenticate(context: string, message: string): Promise<EncryptedBox> {
    return seal(this.#unlocked(), EMPTY, macAad(context, message), this.#random);
  }

  /** Whether tag was made by authenticate for this context and message under this keystore's data key. Needs the keystore unlocked. */
  async verify(context: string, message: string, tag: unknown): Promise<boolean> {
    const key = this.#unlocked();
    const aad = macAad(context, message);
    const box = tag as Partial<EncryptedBox> | null;
    if (box === null || typeof box !== 'object' || typeof box.nonce !== 'string' || typeof box.ciphertext !== 'string' || box.ciphertext.length !== 2 * TAG_BYTES) return false;
    try {
      await open(key, { nonce: box.nonce, ciphertext: box.ciphertext }, aad, 'KEYSTORE_TAMPERED', 'tag does not verify');
      return true;
    } catch {
      return false;
    }
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

  /** Locks after timeout unless it is locked, or unlocked again, first: the timeout of unlock for a keystore that is already unlocked. */
  lockAfter(timeout: number): void {
    checkTimeout(timeout);
    this.#unlocked();
    this.#schedule(timeout);
  }

  #change<T>(run: () => Promise<T>): Promise<T> {
    const result = this.#changes.then(run);
    this.#changes = result.catch(() => undefined);
    return result;
  }

  #unlocked(): CryptoKey {
    if (this.#key === null) throw new KeystoreError('KEYSTORE_LOCKED', 'the keystore is locked; unlock it with the passphrase first');
    return this.#key;
  }

  #schedule(timeout: number | undefined): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    if (timeout === undefined) return;
    this.#timer = setTimeout(() => this.lock(), timeout);
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

/** Makes an empty keystore under passphrase, unlocked; allowSessionExport as unlock takes it. */
export async function createKeystore(passphrase: string | Uint8Array, options: KeystoreOptions & Pick<UnlockOptions, 'allowSessionExport'> = {}): Promise<Keystore> {
  const random = options.random ?? defaultRandom;
  const kdf = newKdf(options, random);
  const kek = await deriveKek(passphrase, kdf);
  const raw = Uint8Array.from(random(KEY_BYTES));
  try {
    if (raw.length !== KEY_BYTES) throw new RangeError('random source returned the wrong length');
    const wrapped = await seal(kek, raw, keyAad(kdf), random);
    const [key, wrappable] = await importDataKey(raw, options.allowSessionExport === true);
    const manifest = await seal(key, EMPTY, manifestAad({}), random);
    const data: EncryptedKeystore = { format: 'pearljs-keystore', version: 1, kdf, cipher: 'aes-256-gcm', key: wrapped, secrets: {}, manifest };
    return new Keystore(data, key, random, wrappable);
  } finally {
    raw.fill(0);
  }
}

/** Reads a stored keystore, checking its shape and parameters (KEYSTORE_INVALID). It starts locked. */
export function openKeystore(data: unknown, options: Pick<KeystoreOptions, 'random'> = {}): Keystore {
  return new Keystore(parseKeystore(data), null, options.random ?? defaultRandom);
}
