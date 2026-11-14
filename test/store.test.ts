// Wallet stores: the same behaviour from the memory and file stores, the
// file store's format, atomic writes that survive a process killed between
// writing and renaming, and a lock no second process gets past. The crash
// and lock tests run the file store in child processes, bundled from src/
// with esbuild so they need no build.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  });
});

describe('file store', () => {
  it('writes the documented format and reads it back after a restart', async () => {
    const path = join(dir, 'wallet.json');
    const store = createFileStore(path, { create: true });
    await store.batch([
      { type: 'set', key: 'meta', value: { version: 1 } },
      { type: 'set', key: 'amount', value: '2100000000000000' },
    ]);
    await store.close();
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      format: 'pearljs-wallet-store',
      version: 1,
      entries: { amount: '2100000000000000', meta: { version: 1 } },
    });
    const reopened = createFileStore(path);
    expect(await reopened.get('amount')).toBe('2100000000000000');
    await reopened.close();
  });

  it('needs create for a new file and refuses it for an existing one', async () => {
    const path = join(dir, 'wallet.json');
    expect(() => createFileStore(path)).toThrow('does not exist; pass create: true');
    await createFileStore(path, { create: true }).close();
    expect(() => createFileStore(path, { create: true })).toThrow('already exists');
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  it('refuses a damaged file instead of starting empty', () => {
    const path = join(dir, 'wallet.json');
    writeFileSync(path, '{"format":"pearljs-wallet-store","version":1,"entr');
    expect(() => createFileStore(path)).toThrow('is not valid JSON');
    writeFileSync(path, '{"format":"pearljs-wallet-store","version":9,"entries":{}}');
    expect(() => createFileStore(path)).toThrow('format version 9');
  });

  it('discards a temporary file a crash left before its rename', async () => {
    const path = join(dir, 'wallet.json');
    const store = createFileStore(path, { create: true });
    await store.set('n', 1);
    await store.close();
    writeFileSync(`${path}.tmp`, '{"format":"pearljs-wallet-store","version":1,"entries":{"n":2}}');
    const reopened = createFileStore(path);
    expect(await reopened.get('n')).toBe(1);
    expect(existsSync(`${path}.tmp`)).toBe(false);
    await reopened.close();
  });

  it('refuses a second store on a locked file', async () => {
    const path = join(dir, 'wallet.json');
    const store = createFileStore(path, { create: true });
    expect(() => createFileStore(path)).toThrow(`is locked by process ${process.pid}`);
    await store.close();
    await createFileStore(path).close();
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

  // A child that opens the store, optionally dies by SIGKILL at the next rename, and runs `body`.
  const child = (path: string, body: string, options: { crashAtRename?: boolean; breakStaleLock?: boolean } = {}): string => {
    const script = join(build, `child-${Math.random().toString(16).slice(2)}.mjs`);
    writeFileSync(
      script,
      `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  if (${options.crashAtRename === true}) process.kill(process.pid, 'SIGKILL');
  return rename(from, to);
};
syncBuiltinESMExports();
const { createFileStore } = await import(${JSON.stringify(bundle)});
const store = createFileStore(${JSON.stringify(path)}, { breakStaleLock: ${options.breakStaleLock === true} });
${body}
`,
    );
    return script;
  };

  it('keeps the last complete state when a process dies between writing and renaming', async () => {
    const chain = new FakeChain();
    const path = join(dir, 'wallet.json');
    const wallet = await newWallet(chain, { store: createFileStore(path, { create: true }) });
    chain.pay(await wallet.receiveAddress(), parsePearl('3'));
    chain.mine();
    await wallet.sync();
    const balance = wallet.balance();
    const history = wallet.history();
    await wallet.close();
    const before = readFileSync(path, 'utf8');

    const script = child(path, `await store.batch([{ type: 'delete', key: 'meta' }, { type: 'set', key: 'account:0', value: 'half written' }]);`, { crashAtRename: true });
    const result = spawnSync(process.execPath, [script]);
    expect(result.signal).toBe('SIGKILL');
    expect(existsSync(`${path}.tmp`)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(before);

    // The dead process's lock stays until it is broken on purpose.
    expect(() => createFileStore(path)).toThrow('no longer running, so open with breakStaleLock: true');
    const store = createFileStore(path, { breakStaleLock: true });
    const reopened = await PearlWallet.open({ store, backend: chain, transactions: chain });
    expect(reopened.balance()).toEqual(balance);
    expect(reopened.history()).toEqual(history);
    await reopened.sync();
    expect(reopened.balance()).toEqual(balance);
    await reopened.close();
  });

  it('never leaves a torn state however a busy writer is killed', async () => {
    const path = join(dir, 'wallet.json');
    await createFileStore(path, { create: true }).close();
    for (let round = 0; round < 3; round += 1) {
      const script = child(
        path,
        `for (let n = ((await store.get('n')) ?? 0) + 1; ; n += 1) {
  await store.batch([{ type: 'set', key: 'n', value: n }, { type: 'set', key: 'item:' + String(n).padStart(6, '0'), value: n }]);
  if (n % 20 === 0) process.stdout.write('.');
}`,
        { breakStaleLock: true },
      );
      const proc = spawn(process.execPath, [script]);
      await new Promise<void>((resolve) => proc.stdout.once('data', () => resolve()));
      proc.kill('SIGKILL');
      await new Promise((resolve) => proc.once('exit', resolve));
      const store = createFileStore(path, { breakStaleLock: true });
      const n = (await store.get('n')) as number;
      const items = await store.list('item:');
      expect(n).toBeGreaterThanOrEqual(20);
      expect(items).toHaveLength(n);
      expect(items[items.length - 1]).toEqual([`item:${String(n).padStart(6, '0')}`, n]);
      await store.close();
    }
  });

  it('keeps a second process off a wallet another has open', async () => {
    const path = join(dir, 'wallet.json');
    await createFileStore(path, { create: true }).close();
    const proc = spawn(process.execPath, [child(path, `process.stdout.write('open'); setInterval(() => {}, 1000);`)]);
    await new Promise<void>((resolve) => proc.stdout.once('data', () => resolve()));
    try {
      expect(() => createFileStore(path)).toThrow(`is locked by process ${proc.pid}`);
      // The holder is alive, so even breakStaleLock does not take it.
      expect(() => createFileStore(path, { breakStaleLock: true })).toThrow('Two writers must never share a wallet');
    } finally {
      proc.kill('SIGKILL');
      await new Promise((resolve) => proc.once('exit', resolve));
    }
  });
});
