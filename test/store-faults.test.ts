// Faults injected under the file stores, through a node:fs whose writes,
// fsyncs, links and renames a test can make short, fail, or stop at, as a
// full disk, an I/O error and a crash do. After each, the stored state is
// whole: the one before the write or the one after it, never part of one,
// and an XMSS index is either never handed out or never handed out again.
// A "crash" here is a throw the store cannot catch its way out of followed
// by never touching that store again; the lock it leaves is broken on
// reopening, as after a real one.

import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import type * as NodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Fs = typeof NodeFs;
const hooks: {
  write?: (fs: Fs, fd: number, data: Uint8Array) => number;
  fsync?: (fs: Fs, fd: number) => void;
  link?: (fs: Fs, from: string, to: string) => void;
  rename?: (fs: Fs, from: string, to: string) => void;
  open?: (fs: Fs, path: string, flags: string) => void;
  unlink?: (fs: Fs, path: string) => void;
} = {};

vi.mock('node:fs', async (original) => {
  const fs = await original<Fs>();
  return {
    ...fs,
    writeSync: (fd: number, data: Uint8Array) => (hooks.write === undefined ? fs.writeSync(fd, data) : hooks.write(fs, fd, data)),
    fsyncSync: (fd: number) => (hooks.fsync === undefined ? fs.fsyncSync(fd) : hooks.fsync(fs, fd)),
    linkSync: (from: string, to: string) => (hooks.link === undefined ? fs.linkSync(from, to) : hooks.link(fs, from, to)),
    renameSync: (from: string, to: string) => (hooks.rename === undefined ? fs.renameSync(from, to) : hooks.rename(fs, from, to)),
    unlinkSync: (path: string) => (hooks.unlink === undefined ? fs.unlinkSync(path) : hooks.unlink(fs, path)),
    openSync: (path: string, flags: string, mode?: number) => {
      hooks.open?.(fs, path, flags);
      return fs.openSync(path, flags, mode);
    },
  };
});

const { createFileStore } = await import('../src/store-file.js');
const { createFileXmssIndexStore, readXmssIndexFile } = await import('../src/xmss-file-store.js');

class Crash extends Error {}
const errno = (code: string): Error => Object.assign(new Error(`${code}: injected`), { code });
const clear = (): void => {
  for (const key of Object.keys(hooks) as (keyof typeof hooks)[]) delete hooks[key];
};
const isRevision = (path: string): boolean => /\d{16}\.json$/.test(path);

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pearljs-faults-'));
  path = join(dir, 'wallet');
});
afterEach(() => {
  clear();
  rmSync(dir, { recursive: true, force: true });
});

const files = (): string[] => readdirSync(path).sort();
const newest = (): { revision: number; entries: Record<string, unknown> } =>
  JSON.parse(readFileSync(join(path, files().filter((name) => name.endsWith('.json')).at(-1)!), 'utf8')) as { revision: number; entries: Record<string, unknown> };

async function seeded() {
  const store = createFileStore(path, { create: true });
  await store.set('keystore', { pretend: 'the encrypted seed' });
  return store;
}

describe('file store under write faults', () => {
  it('finishes a write the disk takes a few bytes at a time', async () => {
    const store = await seeded();
    let calls = 0;
    hooks.write = (fs, fd, data) => {
      calls += 1;
      return fs.writeSync(fd, data.subarray(0, 7));
    };
    await store.set('xmss:key', { next: 7 });
    clear();
    expect(calls).toBeGreaterThan(10);
    expect(newest()).toMatchObject({ revision: 2, entries: { keystore: { pretend: 'the encrypted seed' }, 'xmss:key': { next: 7 } } });
    await store.close();
    const reopened = createFileStore(path);
    expect(await reopened.get('xmss:key')).toEqual({ next: 7 });
    await reopened.close();
  });

  it.each([
    ['takes no more bytes', (): void => void (hooks.write = (fs, fd, data) => (data.length > 40 ? fs.writeSync(fd, data.subarray(0, 40)) : 0))],
    ['reports the disk full part way', (): void => void (hooks.write = (fs, fd, data) => {
      if (data.length <= 40) throw errno('ENOSPC');
      return fs.writeSync(fd, data.subarray(0, 40));
    })],
    ['says it wrote bytes it did not', (): void => void (hooks.write = (fs, fd, data) => fs.writeSync(fd, data.subarray(0, 40)) + data.length - 40)],
    ['fails to fsync', (): void => void (hooks.fsync = () => {
      throw errno('EIO');
    })],
    ['cannot make the link', (): void => void (hooks.link = () => {
      throw errno('EIO');
    })],
  ])('leaves the stored state as it was when the disk %s, and goes on working', async (_, inject) => {
    const store = await seeded();
    const before = files();
    inject();
    await expect(store.batch([{ type: 'delete', key: 'keystore' }, { type: 'set', key: 'xmss:key', value: { next: 7 } }])).rejects.toMatchObject({ name: 'StoreError', code: 'STORE_WRITE_FAILED', cause: expect.any(Error) });
    await expect(store.compareAndSet([], [{ type: 'set', key: 'xmss:key', value: { next: 7 } }])).rejects.toMatchObject({ code: 'STORE_WRITE_FAILED' });
    clear();
    // No truncated file took the place of the good one, and nothing is left behind.
    expect(files()).toEqual(before);
    expect(newest()).toMatchObject({ revision: 1, entries: { keystore: { pretend: 'the encrypted seed' } } });
    expect(await store.list('')).toEqual([['keystore', { pretend: 'the encrypted seed' }]]);
    await store.set('xmss:key', { next: 8 });
    expect(newest()).toMatchObject({ revision: 2, entries: { 'xmss:key': { next: 8 } } });
    await store.close();
  });

  it('says so when the file system cannot make hard links', async () => {
    const store = await seeded();
    hooks.link = () => {
      throw errno('EPERM');
    };
    await expect(store.set('n', 1)).rejects.toMatchObject({ code: 'STORE_UNAVAILABLE' });
    clear();
    expect(newest().revision).toBe(1);
    await store.close();
  });

  it('holds the old state after a crash before the link, and discards the unfinished write', async () => {
    const abandoned = await seeded();
    hooks.link = (_fs, _from, to) => {
      if (isRevision(to)) throw new Crash();
    };
    await expect(abandoned.set('xmss:key', { next: 7 })).rejects.toBeDefined();
    clear();
    const store = createFileStore(path, { breakLock: true });
    expect(await store.list('')).toEqual([['keystore', { pretend: 'the encrypted seed' }]]);
    expect(store.revision).toBe(1);
    expect(files().filter((name) => name.endsWith('.tmp'))).toEqual([]);
    await store.close();
  });

  it('holds the new state, whole, after a crash between the link and the directory fsync', async () => {
    const abandoned = await seeded();
    hooks.link = (fs, from, to) => {
      fs.linkSync(from, to);
      if (isRevision(to)) throw new Crash();
    };
    await expect(abandoned.set('xmss:key', { next: 7 })).rejects.toBeDefined();
    clear();
    const store = createFileStore(path, { breakLock: true });
    expect(await store.list('')).toEqual([['keystore', { pretend: 'the encrypted seed' }], ['xmss:key', { next: 7 }]]);
    expect(store.revision).toBe(2);
    await store.set('n', 1);
    expect(newest().revision).toBe(3);
    await store.close();
  });

  // Two stores on one directory, each with the lock text that makes it the holder: the
  // second runs `between` after the first has looked at its lock and before it links.
  async function raced(between: (other: Awaited<ReturnType<typeof seeded>>) => void) {
    const store = await seeded();
    const lock = join(path, 'lock');
    const mine = readFileSync(lock, 'utf8');
    const other = createFileStore(path, { breakLock: true });
    const theirs = readFileSync(lock, 'utf8');
    const { writeFileSync } = await vi.importActual<Fs>('node:fs');
    writeFileSync(lock, mine);
    let done = false;
    hooks.link = (fs, from, to) => {
      if (isRevision(to) && !done) {
        done = true;
        writeFileSync(lock, theirs);
        between(other);
        writeFileSync(lock, mine);
      }
      fs.linkSync(from, to);
    };
    return store;
  }

  it('refuses a commit another writer got in ahead of, at the moment of the link', async () => {
    const store = await raced((other) => void other.set('other', true));
    await expect(store.set('mine', true)).rejects.toMatchObject({ code: 'STORE_CONFLICT', message: expect.stringContaining('already has revision 2') });
    clear();
    expect(newest()).toMatchObject({ revision: 2, entries: { other: true } });
    expect(newest().entries).not.toHaveProperty('mine');
    await expect(store.get('other')).rejects.toMatchObject({ code: 'STORE_CONFLICT' });
    expect(files().filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('refuses a commit whose revision name was free only because the writers ahead had deleted it', async () => {
    const store = await raced((other) => {
      for (let n = 0; n < 5; n += 1) void other.set('other', n);
    });
    await expect(store.set('mine', true)).rejects.toMatchObject({ code: 'STORE_CONFLICT', message: expect.stringContaining('has moved past revision 1') });
    clear();
    expect(files().filter((name) => name.endsWith('.json'))).toEqual(['0000000000000005.json', '0000000000000006.json']);
    expect(newest()).toMatchObject({ revision: 6, entries: { other: 4 } });
  });
});

describe('XMSS index file under write faults', () => {
  const key = new Uint8Array(64).fill(0xa1);
  const state = (): string => join(dir, 'key.xmss-index');
  const marker = (file: string): boolean => /\.index-\d\d$/.test(file);

  it('hands the same index out again only when the crash came before its marker', () => {
    const abandoned = createFileXmssIndexStore(state(), { create: true });
    expect(abandoned.reserve(key)).toBe(0);
    hooks.open = (_fs, file) => {
      if (marker(file)) throw new Crash();
    };
    expect(() => abandoned.reserve(key)).toThrow();
    clear();
    // Index 1 was never returned, so it is still unused.
    const store = createFileXmssIndexStore(state(), { breakLock: true });
    expect(store.reserve(key)).toBe(1);
    store.close();
  });

  it('never hands an index out again once its marker exists, whatever became of the state file', () => {
    const abandoned = createFileXmssIndexStore(state(), { create: true });
    hooks.rename = () => {
      throw new Crash();
    };
    // The marker is on disk, the state file still says 0, and the process dies here or a moment later.
    expect(abandoned.reserve(key)).toBe(0);
    clear();
    expect((JSON.parse(readFileSync(state(), 'utf8')) as { next: number }).next).toBe(0);
    expect(readXmssIndexFile(state()).next).toBe(1);
    const store = createFileXmssIndexStore(state(), { breakLock: true });
    expect(store.peek()).toBe(1);
    expect(store.reserve(key)).toBe(1);
    expect((JSON.parse(readFileSync(state(), 'utf8')) as { next: number }).next).toBe(2);
    store.close();
  });

  it('gives an index to whoever creates its marker first, at the moment of creating it', () => {
    const store = createFileXmssIndexStore(state(), { create: true });
    hooks.open = (fs, file, flags) => {
      // Another writer, past every check this store made a moment ago, marks the index first.
      if (marker(file) && flags === 'wx' && !fs.existsSync(file)) fs.writeFileSync(file, 'someone else');
    };
    expect(() => store.reserve(key)).toThrow(expect.objectContaining({ code: 'XMSS_INDEX_REUSE', message: expect.stringContaining('reserved by another signer') }));
    clear();
    expect(readFileSync(`${state()}.index-00`, 'utf8')).toBe('someone else');
    expect(() => store.reserve(key)).toThrow(expect.objectContaining({ code: 'XMSS_INDEX_REUSE' }));
    store.close();
    const reopened = createFileXmssIndexStore(state());
    expect(reopened.reserve(key)).toBe(1);
    reopened.close();
  });

  it('spends the index and stops when its marker cannot be written whole', () => {
    const store = createFileXmssIndexStore(state(), { create: true });
    expect(store.reserve(key)).toBe(0);
    hooks.write = () => {
      throw errno('ENOSPC');
    };
    expect(() => store.reserve(key)).toThrow(expect.objectContaining({ code: 'XMSS_STORE_INVALID' }));
    clear();
    expect(() => store.reserve(key)).toThrow(expect.objectContaining({ code: 'XMSS_STORE_INVALID' }));
    expect(() => store.peek()).toThrow(expect.objectContaining({ code: 'XMSS_STORE_INVALID' }));
    store.close();
    const reopened = createFileXmssIndexStore(state());
    expect(reopened.reserve(key)).toBe(2);
    reopened.close();
  });

  it('finishes a state file the disk takes a few bytes at a time', () => {
    const store = createFileXmssIndexStore(state(), { create: true });
    hooks.write = (fs, fd, data) => fs.writeSync(fd, data.subarray(0, 5));
    expect(store.reserve(key)).toBe(0);
    clear();
    expect(JSON.parse(readFileSync(state(), 'utf8'))).toEqual({ version: 1, publicKey: 'a1'.repeat(64), next: 1 });
    store.close();
  });
});

describe('file store lock under a takeover', () => {
  it('leaves the lock of a writer that took it over between its look and its removal', async () => {
    const store = await seeded();
    const lockPath = join(path, 'lock');
    const theirs = `${JSON.stringify({ id: 'f'.repeat(32), pid: process.pid + 1, host: 'elsewhere', heartbeatMs: 1000 })}\n`;
    // Another process breaks the lock and takes it the moment before this one's release touches the file.
    const takeOver = (fs: Fs, target: string): void => {
      if (target !== lockPath) return;
      delete hooks.unlink;
      delete hooks.rename;
      fs.writeFileSync(lockPath, theirs);
    };
    hooks.unlink = (fs, target) => {
      takeOver(fs, target);
      fs.unlinkSync(target);
    };
    hooks.rename = (fs, from, to) => {
      takeOver(fs, from);
      fs.renameSync(from, to);
    };
    await store.close();
    clear();
    expect(readFileSync(lockPath, 'utf8')).toBe(theirs);
  });

  it('says the lock was taken when a store opened over it removed the write in progress', async () => {
    const store = await seeded();
    let other: Awaited<ReturnType<typeof createFileStore>> | undefined;
    // Another process opens the store with breakLock just before this one links its next revision, and clears the unfinished write.
    hooks.link = (fs, from, to) => {
      // The second store links too; without this it would come back in here before `other` is set.
      delete hooks.link;
      if (from.endsWith('.tmp') && other === undefined) other = createFileStore(path, { breakLock: true });
      fs.linkSync(from, to);
    };
    await expect(store.set('xmss:key', { next: 7 })).rejects.toMatchObject({ code: 'STORE_LOCKED' });
    clear();
    expect(await other!.get('keystore')).toEqual({ pretend: 'the encrypted seed' });
    expect(await other!.get('xmss:key')).toBeUndefined();
    await other!.close();
  });
});
