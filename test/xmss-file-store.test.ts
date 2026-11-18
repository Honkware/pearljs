// The file-backed XMSS index store: an index is on disk as used before
// reserve returns it, a crash burns an index instead of repeating it, one
// state file serves one key and one store at a time, and a store that has
// lost its lock, or finds another writer's mark, hands out nothing.

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createXmssSigner, xmssVerify } from '../src/index.js';
import { createFileXmssIndexStore, readXmssIndexFile } from '../src/xmss-file-store.js';

const keyA = new Uint8Array(64).fill(0xa1);
const keyB = new Uint8Array(64).fill(0xb2);
const message = new Uint8Array(32).fill(7);
const indexOf = (signature: Uint8Array): number => new DataView(signature.buffer).getUint32(0);

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pearljs-xmss-'));
  path = join(dir, 'key.xmss-index');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const nextOnDisk = (): number => (JSON.parse(readFileSync(path, 'utf8')) as { next: number }).next;

describe('file-backed XMSS index store', () => {
  it('records each index on disk before returning it', () => {
    const store = createFileXmssIndexStore(path, { create: true });
    expect(nextOnDisk()).toBe(0);
    expect(store.reserve(keyA)).toBe(0);
    expect(nextOnDisk()).toBe(1);
    expect(store.reserve(keyA)).toBe(1);
    expect(nextOnDisk()).toBe(2);
    store.close();
  });

  it('can be inspected through the store and, without the lock, from the file', () => {
    const store = createFileXmssIndexStore(path, { create: true });
    expect(store.peek()).toBe(0);
    expect(readXmssIndexFile(path)).toEqual({ publicKey: null, next: 0, remaining: 31, locked: true });
    store.reserve(keyA);
    expect(store.peek(keyA)).toBe(1);
    expect(() => store.peek(keyB)).toThrow('belongs to a different key');
    expect(nextOnDisk()).toBe(1);
    store.close();
    expect(readXmssIndexFile(path)).toEqual({ publicKey: 'a1'.repeat(64), next: 1, remaining: 30, locked: false });
    expect(() => store.peek()).toThrow('is closed');
    expect(() => readXmssIndexFile(join(dir, 'missing'))).toThrow('does not exist');
  });

  it('stops at index 30 and writes nothing more', () => {
    writeFileSync(path, `${JSON.stringify({ version: 1, publicKey: 'a1'.repeat(64), next: 30 })}\n`);
    const store = createFileXmssIndexStore(path);
    expect(store.reserve(keyA)).toBe(30);
    expect(nextOnDisk()).toBe(31);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(() => store.reserve(keyA)).toThrow('used all 31 of its signatures');
    }
    expect(nextOnDisk()).toBe(31);
    expect(readXmssIndexFile(path).remaining).toBe(0);
    store.close();
  });

  it('continues after a restart instead of starting again', () => {
    const first = createFileXmssIndexStore(path, { create: true });
    first.reserve(keyA);
    first.reserve(keyA);
    first.close();
    const second = createFileXmssIndexStore(path);
    expect(second.reserve(keyA)).toBe(2);
    second.close();
  });

  it('burns the index of a signature that never happened', async () => {
    const privateSeed = new Uint8Array(64).fill(0x44);
    const publicSeed = new Uint8Array(32).fill(0x55);
    const store = createFileXmssIndexStore(path, { create: true });
    // The process dies between reserving index 0 and signing with it.
    const dying = createXmssSigner(privateSeed, publicSeed, {
      peek: () => 0,
      reserve(publicKey) {
        store.reserve(publicKey);
        throw new Error('power cut');
      },
    });
    await expect(dying.sign(message)).rejects.toThrow('power cut');
    // It never closed the store, so its lock is still there.
    expect(() => createFileXmssIndexStore(path)).toThrow('is locked by process');

    const restarted = createFileXmssIndexStore(path, { breakLock: true });
    const signer = createXmssSigner(privateSeed, publicSeed, restarted);
    const signature = await signer.sign(message);
    expect(indexOf(signature)).toBe(1);
    expect(xmssVerify(signer.publicKey, message, signature)).toBe(true);
    restarted.close();
  });

  it('keeps a second store off a state file that is in use', () => {
    const store = createFileXmssIndexStore(path, { create: true });
    expect(() => createFileXmssIndexStore(path)).toThrow(`locked by process ${process.pid}`);
    store.close();
    expect(() => store.reserve(keyA)).toThrow('is closed');
    createFileXmssIndexStore(path).close();
  });

  it('serves one key per file', () => {
    const store = createFileXmssIndexStore(path, { create: true });
    store.reserve(keyA);
    expect(() => store.reserve(keyB)).toThrow('belongs to a different key');
    expect(() => store.reserve(new Uint8Array(32))).toThrow('must be 64 bytes');
    expect(nextOnDisk()).toBe(1);
    store.close();
    const reopened = createFileXmssIndexStore(path);
    expect(() => reopened.reserve(keyB)).toThrow('belongs to a different key');
    reopened.close();
  });

  it('never starts a state file by accident', () => {
    expect(() => createFileXmssIndexStore(path)).toThrow('does not exist');
    createFileXmssIndexStore(path, { create: true }).close();
    expect(() => createFileXmssIndexStore(path, { create: true })).toThrow('already exists');
    // Neither failure leaves a lock behind.
    createFileXmssIndexStore(path).close();
  });

  it('marks each index it hands out in a file of its own, and starts from the marks when the state file is behind', () => {
    const store = createFileXmssIndexStore(path, { create: true });
    store.reserve(keyA);
    store.reserve(keyA);
    store.close();
    expect(readdirSync(dir).sort()).toEqual(['key.xmss-index', 'key.xmss-index.index-00', 'key.xmss-index.index-01']);
    // The state file as a crash, or an old copy put back, would leave it.
    writeFileSync(path, `${JSON.stringify({ version: 1, publicKey: 'a1'.repeat(64), next: 0 })}\n`);
    expect(readXmssIndexFile(path)).toMatchObject({ next: 2, remaining: 29 });
    const reopened = createFileXmssIndexStore(path);
    expect(reopened.peek()).toBe(2);
    expect(reopened.reserve(keyA)).toBe(2);
    reopened.close();
    // Marks of an earlier key are no place to start a new one.
    rmSync(path);
    expect(() => createFileXmssIndexStore(path, { create: true })).toThrow('index markers');
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  it('reserves nothing once its lock is gone or taken, and says how to take a lock without removing it', () => {
    const store = createFileXmssIndexStore(path, { create: true });
    store.reserve(keyA);
    let message = '';
    try {
      createFileXmssIndexStore(path);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('open with breakLock: true');
    expect(message).not.toMatch(/delete|remove/);
    expect(() => createFileXmssIndexStore(path, { breakStaleLock: true, staleLockAfter: 1 })).toThrow('Two signers must never share a key');

    const taker = createFileXmssIndexStore(path, { breakLock: true });
    expect(() => store.reserve(keyA)).toThrow(expect.objectContaining({ code: 'XMSS_STORE_LOCKED', message: expect.stringContaining('No index was reserved') }));
    expect(() => store.peek()).toThrow(expect.objectContaining({ code: 'XMSS_STORE_LOCKED' }));
    // Closing the first leaves the taker's lock where it is.
    store.close();
    expect(() => createFileXmssIndexStore(path)).toThrow('is locked by process');
    expect(taker.reserve(keyA)).toBe(1);
    taker.close();

    const alone = createFileXmssIndexStore(path);
    rmSync(`${path}.lock`);
    expect(() => alone.reserve(keyA)).toThrow(expect.objectContaining({ code: 'XMSS_STORE_LOCKED' }));
    expect(readXmssIndexFile(path).next).toBe(2);
    alone.close();
  });

  it('gives an index to one of two stores on the same file, whichever holds the lock when it asks', () => {
    const first = createFileXmssIndexStore(path, { create: true });
    const firstLock = readFileSync(`${path}.lock`, 'utf8');
    const second = createFileXmssIndexStore(path, { breakLock: true });
    const secondLock = readFileSync(`${path}.lock`, 'utf8');
    expect(second.reserve(keyA)).toBe(0);
    // The first store gets its lock back and still believes the next index is 0.
    writeFileSync(`${path}.lock`, firstLock);
    expect(() => first.reserve(keyA)).toThrow(expect.objectContaining({ code: 'XMSS_INDEX_REUSE', message: expect.stringContaining('another signer is using the key') }));
    expect(() => first.reserve(keyA)).toThrow(expect.objectContaining({ code: 'XMSS_INDEX_REUSE' }));
    writeFileSync(`${path}.lock`, secondLock);
    expect(second.reserve(keyA)).toBe(1);
    expect(readdirSync(dir).filter((name) => name.includes('.index-')).sort()).toEqual(['key.xmss-index.index-00', 'key.xmss-index.index-01']);
    first.close();
    second.close();
  });

  it('refuses an index whose mark another writer made, even with the state file put back', () => {
    const store = createFileXmssIndexStore(path, { create: true });
    const before = readFileSync(path, 'utf8');
    // Another writer, heedless of the lock, takes index 0 and then restores the state file.
    writeFileSync(`${path}.index-00`, 'someone else');
    writeFileSync(path, before);
    expect(() => store.reserve(keyA)).toThrow(expect.objectContaining({ code: 'XMSS_INDEX_REUSE' }));
    store.close();
    const reopened = createFileXmssIndexStore(path);
    expect(reopened.reserve(keyA)).toBe(1);
    reopened.close();
  });

  it('refuses a state file it cannot read instead of guessing', () => {
    for (const text of ['', '{', '{"version":2,"publicKey":null,"next":0}', '{"version":1,"publicKey":null,"next":-1}', '{"version":1,"publicKey":"zz","next":0}', 'null']) {
      writeFileSync(path, text);
      expect(() => createFileXmssIndexStore(path)).toThrow('is not valid; refusing to guess');
      expect(() => createFileXmssIndexStore(path)).toThrow('is not valid; refusing to guess');
    }
  });
});
