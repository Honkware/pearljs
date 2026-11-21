// Wallet stores: the same behaviour from the memory and file stores,
// compareAndSet included, the file store's format, commits that survive a
// process killed between writing and linking, and a lock that knows its
// owner: it is not taken from a live holder unless the caller insists, a
// store that lost it writes nothing more, and closing removes only one's
// own. The crash and lock tests run the file store in child processes,
// bundled from src/ with esbuild so they need no build.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PearlWallet, createMemoryStore, parsePearl } from '../src/index.js';
import type { JsonValue, WalletStore } from '../src/index.js';
import { createFileStore } from '../src/store-file.js';
import { FakeChain, newWallet } from './wallet-chain.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pearljs-store-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** The revision files of a file store, oldest first. */
const revisions = (path: string): string[] => readdirSync(path).filter((name) => /^\d{16}\.json$/.test(name)).sort();
/** The newest revision of a file store, as text. */
const newest = (path: string): string => readFileSync(join(path, revisions(path).at(-1)!), 'utf8');
const temporaries = (path: string): string[] => readdirSync(path).filter((name) => name.endsWith('.tmp'));

const kinds: [string, () => WalletStore][] = [
  ['memory', () => createMemoryStore()],
  ['file', () => createFileStore(join(dir, 'wallet.json'), { create: true })],
];

describe.each(kinds)('%s store', (_, make) => {
  it('gets, sets, deletes and lists by prefix in key order', async () => {
    const store = make();
    await store.set('tx:b', { n: 2 });
    await store.set('tx:a', { n: 1 });
    await store.set('meta', 'x');
    expect(await store.get('tx:a')).toEqual({ n: 1 });
    expect(await store.get('missing')).toBeUndefined();
    expect(await store.list('tx:')).toEqual([
      ['tx:a', { n: 1 }],
      ['tx:b', { n: 2 }],
    ]);
    await store.delete('tx:a');
    expect((await store.list('')).map(([key]) => key)).toEqual(['meta', 'tx:b']);
    await store.close();
  });

  it('applies a batch entirely or not at all', async () => {
    const store = make();
    await store.set('a', 1);
    await expect(store.batch([{ type: 'set', key: 'b', value: 2 }, { type: 'set', key: 'c', value: 3n as unknown as JsonValue }])).rejects.toThrow('decimal string');
    expect(await store.list('')).toEqual([['a', 1]]);
    await store.batch([{ type: 'delete', key: 'a' }, { type: 'set', key: 'b', value: [1, 'two', null, true] }]);
    expect(await store.list('')).toEqual([['b', [1, 'two', null, true]]]);
    await store.close();
  });

  it('hands out copies, so changing a value read or written changes nothing stored', async () => {
    const store = make();
    const value = { list: [1] };
    await store.set('k', value);
    value.list.push(2);
    const read = (await store.get('k')) as { list: number[] };
    read.list.push(3);
    expect(await store.get('k')).toEqual({ list: [1] });
    await store.close();
  });

  it('refuses use after close', async () => {
    const store = make();
    await store.close();
    await expect(store.get('k')).rejects.toThrow('closed');
    await expect(store.compareAndSet([], [{ type: 'set', key: 'k', value: 1 }])).rejects.toThrow('closed');
  });

  it('applies a compareAndSet only while every expected key holds the expected value', async () => {
    const store = make();
    await store.set('index', { next: 3, label: null });
    // Absent is a value too, and object key order is not.
    expect(await store.compareAndSet([{ key: 'index', value: { label: null, next: 3 } }, { key: 'new', value: undefined }], [{ type: 'set', key: 'index', value: { next: 4, label: null } }, { type: 'set', key: 'new', value: 1 }])).toBe(true);
    expect(await store.get('index')).toEqual({ next: 4, label: null });
    for (const expected of [{ next: 3, label: null }, { next: 4 }, { next: 4, label: 'x' }, { next: '4', label: null }, undefined]) {
      expect(await store.compareAndSet([{ key: 'index', value: expected }], [{ type: 'set', key: 'index', value: 'overwritten' }, { type: 'delete', key: 'new' }])).toBe(false);
    }
    expect(await store.compareAndSet([{ key: 'index', value: { next: 4, label: null } }, { key: 'new', value: 2 }], [{ type: 'delete', key: 'index' }])).toBe(false);
    expect(await store.list('')).toEqual([['index', { next: 4, label: null }], ['new', 1]]);
    await expect(store.compareAndSet([{ key: 'new', value: 1 }], [{ type: 'set', key: 'new', value: 2n as unknown as JsonValue }])).rejects.toThrow(TypeError);
    expect(await store.get('new')).toBe(1);
    await store.close();
  });

  it('lets one of two compareAndSet calls made at once win', async () => {
    const store = make();
    await store.set('n', 0);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => store.compareAndSet([{ key: 'n', value: 0 }], [{ type: 'set', key: 'n', value: i + 1 }])));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await store.get('n')).toBe(results.indexOf(true) + 1);
    await store.close();
  });
});

describe('file store', () => {
  it('writes the documented format and reads it back after a restart', async () => {
    const path = join(dir, 'wallet');
    const store = createFileStore(path, { create: true });
    await store.batch([
      { type: 'set', key: 'meta', value: { version: 1 } },
      { type: 'set', key: 'amount', value: '2100000000000000' },
    ]);
    expect(store.revision).toBe(1);
    await store.close();
    expect(revisions(path)).toEqual(['0000000000000000.json', '0000000000000001.json']);
    expect(JSON.parse(newest(path))).toEqual({
      format: 'pearljs-wallet-store',
      version: 2,
      revision: 1,
      id: expect.stringMatching(/^[0-9a-f]{32}$/),
      entries: { amount: '2100000000000000', meta: { version: 1 } },
    });
    expect(readdirSync(path).sort()).toEqual(revisions(path));
    const reopened = createFileStore(path);
    expect(reopened.revision).toBe(1);
    expect(await reopened.get('amount')).toBe('2100000000000000');
    await reopened.close();
  });

  it('keeps the newest two revisions and deletes the rest', async () => {
    const path = join(dir, 'wallet');
    const store = createFileStore(path, { create: true });
    for (let n = 1; n <= 5; n += 1) await store.set('n', n);
    expect(revisions(path)).toEqual(['0000000000000004.json', '0000000000000005.json']);
    // A write that changes nothing still commits; an empty batch does not.
    await store.batch([]);
    expect(store.revision).toBe(5);
    await store.close();
  });

  it('needs create for a new store and refuses it for an existing one', async () => {
    const path = join(dir, 'wallet');
    expect(() => createFileStore(path)).toThrow('does not exist; pass create: true');
    await createFileStore(path, { create: true }).close();
    expect(() => createFileStore(path, { create: true })).toThrow('already exists');
    expect(existsSync(join(path, 'lock'))).toBe(false);
    // A directory with no store in it is not one, and a file is not a directory.
    expect(() => createFileStore(dir)).toThrow('holds no wallet store');
    writeFileSync(join(dir, 'file'), '{}');
    expect(() => createFileStore(join(dir, 'file'))).toThrow('is a file, not a pearljs wallet store directory');
    expect(existsSync(join(dir, 'lock'))).toBe(false);
  });

  it('refuses a damaged revision instead of starting empty or falling back', async () => {
    const path = join(dir, 'wallet');
    const store = createFileStore(path, { create: true });
    await store.set('n', 1);
    await store.close();
    const file = join(path, revisions(path).at(-1)!);
    const good = readFileSync(file, 'utf8');
    for (const [text, message] of [
      [good.slice(0, 60), 'is not valid JSON'],
      [good.replace('"version":2', '"version":9'), 'format version 9'],
      [good.replace('"revision":1', '"revision":7'), 'does not say it is revision 1'],
      [good.replace('pearljs-wallet-store', 'something-else'), 'is not a pearljs wallet store revision'],
    ] as const) {
      writeFileSync(file, text);
      expect(() => createFileStore(path)).toThrow(message);
      expect(existsSync(join(path, 'lock'))).toBe(false);
    }
  });

  it('discards a temporary file a crash left before its link', async () => {
    const path = join(dir, 'wallet');
    const store = createFileStore(path, { create: true });
    await store.set('n', 1);
    await store.close();
    writeFileSync(join(path, `${'ab'.repeat(16)}.tmp`), newest(path).replace('"n":1', '"n":2'));
    const reopened = createFileStore(path);
    expect(await reopened.get('n')).toBe(1);
    expect(temporaries(path)).toEqual([]);
    await reopened.close();
  });

  it('refuses a second store on a locked store, and never suggests removing the lock', async () => {
    const path = join(dir, 'wallet');
    const store = createFileStore(path, { create: true });
    let message = '';
    try {
      createFileStore(path);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(`is locked by process ${process.pid}`);
    expect(message).not.toMatch(/delete|remove/);
    // The holder is this live process, so the lock is not stale however long it is left.
    expect(() => createFileStore(path, { breakStaleLock: true, staleLockAfter: 1 })).toThrow('Two writers must never share a wallet');
    expect(temporaries(path)).toEqual([]);
    await store.close();
    await createFileStore(path).close();
  });

  it('calls a lock stale only when its process is gone and it has stopped being touched', async () => {
    const path = join(dir, 'wallet');
    await createFileStore(path, { create: true }).close();
    const lock = join(path, 'lock');
    const write = (owner: object, ageMs: number): void => {
      writeFileSync(lock, JSON.stringify(owner));
      const then = new Date(Date.now() - ageMs);
      utimesSync(lock, then, then);
    };
    // A process id that does not exist here, as a holder in another PID namespace looks.
    const gone = { id: 'cd'.repeat(16), pid: 2 ** 22 + 12345, host: hostname(), heartbeatMs: 100 };
    const options = { breakStaleLock: true, staleLockAfter: 2_000 };

    write(gone, 0);
    expect(() => createFileStore(path, options)).toThrow('if you are certain its holder is gone, open with breakLock: true');
    write(gone, 1_000);
    expect(() => createFileStore(path, options)).toThrow('is locked by process');
    // Untouched for long enough, but by a holder whose heartbeat is slower than that.
    write({ ...gone, heartbeatMs: 60_000 }, 5_000);
    expect(() => createFileStore(path, options)).toThrow('is locked by process');
    // Another host's lock, and one that cannot be read, are never stale.
    write({ ...gone, host: 'another-host' }, 3_600_000);
    expect(() => createFileStore(path, options)).toThrow('on another-host');
    write({ not: 'a lock' }, 3_600_000);
    expect(() => createFileStore(path, options)).toThrow('is locked by another store');
    // A live process is never stale.
    write({ ...gone, pid: process.ppid }, 3_600_000);
    expect(() => createFileStore(path, options)).toThrow('is locked by process');

    write(gone, 5_000);
    expect(() => createFileStore(path, { staleLockAfter: 2_000 })).toThrow('open with breakStaleLock: true to take it over');
    const store = createFileStore(path, options);
    expect(JSON.parse(readFileSync(lock, 'utf8'))).toMatchObject({ pid: process.pid, host: hostname() });
    await store.set('n', 1);
    await store.close();
    expect(existsSync(lock)).toBe(false);
  });

  it('touches its lock while it is open', async () => {
    const path = join(dir, 'wallet');
    const store = createFileStore(path, { create: true, staleLockAfter: 100 });
    const lock = join(path, 'lock');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(Date.now() - statSync(lock).mtimeMs).toBeLessThan(5_000);
    await store.close();
  });

  it('writes nothing once its lock is gone, and refuses every call after', async () => {
    const path = join(dir, 'wallet');
    const store = createFileStore(path, { create: true });
    await store.set('n', 1);
    rmSync(join(path, 'lock'));
    await expect(store.set('n', 2)).rejects.toMatchObject({ code: 'STORE_LOCKED', message: expect.stringContaining('no longer locked by this store') });
    await expect(store.get('n')).rejects.toMatchObject({ code: 'STORE_LOCKED' });
    await expect(store.list('')).rejects.toMatchObject({ code: 'STORE_LOCKED' });
    await expect(store.compareAndSet([], [{ type: 'set', key: 'n', value: 3 }])).rejects.toMatchObject({ code: 'STORE_LOCKED' });
    expect(JSON.parse(newest(path)).entries).toEqual({ n: 1 });
    await store.close();
  });

  it('gives the lock to a store that breaks it, whose lock the first then leaves alone', async () => {
    const path = join(dir, 'wallet');
    const first = createFileStore(path, { create: true });
    await first.set('n', 1);
    const second = createFileStore(path, { breakLock: true });
    const lock = readFileSync(join(path, 'lock'), 'utf8');
    await expect(first.set('n', 2)).rejects.toMatchObject({ code: 'STORE_LOCKED' });
    // Closing the first removes only a lock that is its own.
    await first.close();
    expect(readFileSync(join(path, 'lock'), 'utf8')).toBe(lock);
    expect(() => createFileStore(path)).toThrow('is locked by process');
    await second.set('n', 3);
    await second.close();
    expect(existsSync(join(path, 'lock'))).toBe(false);
    const reopened = createFileStore(path);
    expect(await reopened.get('n')).toBe(3);
    await reopened.close();
  });

  it('refuses a writer that is behind, whoever holds the lock by then', async () => {
    const path = join(dir, 'wallet');
    const first = createFileStore(path, { create: true });
    await first.set('n', 1);
    const lock = join(path, 'lock');
    const firstLock = readFileSync(lock, 'utf8');
    const second = createFileStore(path, { breakLock: true });
    await second.set('n', 2);
    // The first store is handed its lock back, so only the revisions stand between it and the file.
    writeFileSync(lock, firstLock);
    await expect(first.set('n', 99)).rejects.toMatchObject({ code: 'STORE_CONFLICT', message: expect.stringContaining('another writer is using it') });
    await expect(first.get('n')).rejects.toMatchObject({ code: 'STORE_CONFLICT' });
    expect(JSON.parse(newest(path)).entries).toEqual({ n: 2 });
    expect(temporaries(path)).toEqual([]);
    await first.close();
  });

  it('refuses a writer so far behind that its next revision name is free again', async () => {
    const path = join(dir, 'wallet');
    const first = createFileStore(path, { create: true });
    await first.set('n', 1);
    const lock = join(path, 'lock');
    const firstLock = readFileSync(lock, 'utf8');
    const second = createFileStore(path, { breakLock: true });
    for (let n = 2; n <= 6; n += 1) await second.set('n', n);
    expect(revisions(path)).toEqual(['0000000000000005.json', '0000000000000006.json']);
    writeFileSync(lock, firstLock);
    await expect(first.compareAndSet([{ key: 'n', value: 1 }], [{ type: 'set', key: 'n', value: 99 }])).rejects.toMatchObject({ code: 'STORE_CONFLICT', message: expect.stringContaining('has moved past revision 1') });
    // Its link is gone again, and the newest revision is untouched.
    expect(revisions(path)).toEqual(['0000000000000005.json', '0000000000000006.json']);
    expect(JSON.parse(newest(path)).entries).toEqual({ n: 6 });
    await first.close();
  });
});

describe('file store across processes', () => {
  let bundle: string;
  let build: string;
  beforeAll(() => {
    build = mkdtempSync(join(tmpdir(), 'pearljs-store-bundle-'));
    bundle = join(build, 'store-file.mjs');
    buildSync({ entryPoints: [join(import.meta.dirname, '../src/store-file.ts')], bundle: true, platform: 'node', format: 'esm', outfile: bundle, logLevel: 'silent' });
  });
  afterAll(() => rmSync(build, { recursive: true, force: true }));

  // A child that opens the store, optionally dies by SIGKILL at the next link, and runs `body`.
  const child = (path: string, body: string, options: { crashAtLink?: boolean; open?: string } = {}): string => {
    const script = join(build, `child-${Math.random().toString(16).slice(2)}.mjs`);
    writeFileSync(
      script,
      `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const link = fs.linkSync;
fs.linkSync = (from, to) => {
  if (${options.crashAtLink === true} && /[0-9]{16}\\.json$/.test(to)) process.kill(process.pid, 'SIGKILL');
  return link(from, to);
};
syncBuiltinESMExports();
const { createFileStore } = await import(${JSON.stringify(pathToFileURL(bundle).href)});
const store = createFileStore(${JSON.stringify(path)}, ${options.open ?? '{}'});
${body}
`,
    );
    return script;
  };
  const STALE = '{ breakStaleLock: true, staleLockAfter: 200 }';
  const untilStale = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 300));

  it('keeps the last complete state when a process dies between writing and linking', async () => {
    const chain = new FakeChain();
    const path = join(dir, 'wallet');
    const wallet = await newWallet(chain, { store: createFileStore(path, { create: true }) });
    chain.pay(await wallet.receiveAddress(), parsePearl('3'));
    chain.mine();
    await wallet.sync();
    const balance = wallet.balance();
    const history = wallet.history();
    await wallet.close();
    const before = newest(path);

    const script = child(path, `await store.batch([{ type: 'delete', key: 'meta' }, { type: 'set', key: 'account:0', value: 'half written' }]);`, { crashAtLink: true, open: '{ staleLockAfter: 200 }' });
    const result = spawnSync(process.execPath, [script]);
    // Windows has no signals: the process is ended with exit code 1.
    if (process.platform === 'win32') expect(result.status).toBe(1);
    else expect(result.signal).toBe('SIGKILL');
    expect(temporaries(path)).toHaveLength(1);
    expect(newest(path)).toBe(before);

    // The dead process's lock stays until it is broken on purpose, and is not stale while it could still be touched.
    expect(() => createFileStore(path, { breakStaleLock: true, staleLockAfter: 60_000 })).toThrow('is locked by process');
    await untilStale();
    expect(() => createFileStore(path, { staleLockAfter: 200 })).toThrow('open with breakStaleLock: true to take it over');
    const store = createFileStore(path, { breakStaleLock: true, staleLockAfter: 200 });
    expect(temporaries(path)).toEqual([]);
    const reopened = await PearlWallet.open({ store, backend: chain, transactions: chain });
    expect(reopened.balance()).toEqual(balance);
    expect(reopened.history()).toEqual(history);
    await reopened.sync();
    expect(reopened.balance()).toEqual(balance);
    await reopened.close();
  });

  it('never leaves a torn state however a busy writer is killed', async () => {
    const path = join(dir, 'wallet');
    await createFileStore(path, { create: true }).close();
    for (let round = 0; round < 3; round += 1) {
      const script = child(
        path,
        `for (let n = ((await store.get('n')) ?? 0) + 1; ; n += 1) {
  await store.batch([{ type: 'set', key: 'n', value: n }, { type: 'set', key: 'item:' + String(n).padStart(6, '0'), value: n }]);
  if (n % 20 === 0) process.stdout.write('.');
}`,
        { open: STALE },
      );
      const proc = spawn(process.execPath, [script]);
      await new Promise<void>((resolve) => proc.stdout.once('data', () => resolve()));
      proc.kill('SIGKILL');
      await new Promise((resolve) => proc.once('exit', resolve));
      await untilStale();
      const store = createFileStore(path, { breakStaleLock: true, staleLockAfter: 200 });
      const n = (await store.get('n')) as number;
      const items = await store.list('item:');
      expect(n).toBeGreaterThanOrEqual(20);
      expect(items).toHaveLength(n);
      expect(items[items.length - 1]).toEqual([`item:${String(n).padStart(6, '0')}`, n]);
      await store.close();
    }
  });

  it('keeps a second process off a wallet another has open, however long it stays open', async () => {
    const path = join(dir, 'wallet');
    await createFileStore(path, { create: true }).close();
    const proc = spawn(process.execPath, [child(path, `process.stdout.write('open'); setInterval(() => {}, 1000);`, { open: '{ staleLockAfter: 200 }' })]);
    await new Promise<void>((resolve) => proc.stdout.once('data', () => resolve()));
    try {
      expect(() => createFileStore(path)).toThrow(`is locked by process ${proc.pid}`);
      // The holder is alive and touching its lock, so breakStaleLock does not take it even past the stale interval.
      await untilStale();
      expect(() => createFileStore(path, { breakStaleLock: true, staleLockAfter: 200 })).toThrow('Two writers must never share a wallet');
      expect(Date.now() - statSync(join(path, 'lock')).mtimeMs).toBeLessThan(250);
    } finally {
      proc.kill('SIGKILL');
      await new Promise((resolve) => proc.once('exit', resolve));
    }
  });
});
