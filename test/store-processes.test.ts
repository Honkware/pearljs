// Two and more real processes on one store. The lock keeps a second process
// out; these tests take the lock away in every way they can construct (the
// file removed while its holder lives, broken by the second process, handed
// back and forth so that each process is the holder whenever it looks, and
// flipped between them while both write) and show that what must happen
// once still happens once: an XMSS index is signed with by at most one
// process, a compareAndSet from one value is won by one process, and no
// write is lost. The children are test/processes/child.ts, bundled with
// esbuild so they need no build.

import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { buildSync } from 'esbuild';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PearlWallet } from '../src/index.js';
import { createFileStore } from '../src/store-file.js';
import { createFileXmssIndexStore, readXmssIndexFile } from '../src/xmss-file-store.js';
import { chainFor } from './processes/child.js';
import { FAST_KDF, FakeChain, MNEMONIC, PASSPHRASE } from './wallet-chain.js';

type Reply = { ok?: true; next?: number; index?: number; txid?: string; error?: string; message?: string; won?: number[] };

let build: string;
let bundle: string;
let template: string;
let keyId: string;
beforeAll(async () => {
  // Inside node_modules, so the bundle finds the packages it leaves external.
  build = join(import.meta.dirname, '../node_modules/.cache', `pearljs-children-${process.pid}`);
  mkdirSync(build, { recursive: true });
  bundle = join(build, 'child.mjs');
  buildSync({ entryPoints: [join(import.meta.dirname, 'processes/child.ts')], bundle: true, packages: 'external', platform: 'node', format: 'esm', outfile: bundle, logLevel: 'silent' });
  // One wallet with a funded XMSS key, copied for each test.
  template = join(build, 'template');
  const boot = new FakeChain();
  const store = createFileStore(template, { create: true });
  const created = await PearlWallet.create({ store: { ...store, close: async () => undefined }, backend: boot, transactions: boot, passphrase: PASSPHRASE, mnemonic: MNEMONIC, kdf: FAST_KDF, gapLimit: 10 });
  const key = await created.addXmssKey();
  keyId = key.id;
  const chain = chainFor(key.address);
  const wallet = await PearlWallet.open({ store, backend: chain, transactions: chain });
  await wallet.sync();
  await wallet.close();
}, 60_000);
afterAll(() => rmSync(build, { recursive: true, force: true }));

let dir: string;
let children: ChildProcessWithoutNullStreams[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pearljs-processes-'));
});
afterEach(() => {
  for (const child of children) child.kill('SIGKILL');
  children = [];
  rmSync(dir, { recursive: true, force: true });
});

/** A wallet process on the store directory; ask sends one command and resolves with its one reply. */
function walletProcess(directory: string): { ask(command: string): Promise<Reply> } {
  const child = spawn(process.execPath, [bundle, 'wallet', directory]);
  children.push(child);
  const waiting: ((reply: Reply) => void)[] = [];
  createInterface({ input: child.stdout }).on('line', (line) => waiting.shift()?.(JSON.parse(line) as Reply));
  child.stderr.on('data', (data: Buffer) => process.stderr.write(data));
  return {
    ask: (command) =>
      new Promise((resolve) => {
        waiting.push(resolve);
        child.stdin.write(`${command}\n`);
      }),
  };
}

/** A child that runs to its end and prints one line. */
function run(mode: string, target: string, rounds: number): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bundle, mode, target, String(rounds)]);
    children.push(child);
    let out = '';
    let err = '';
    child.stdout.on('data', (data: Buffer) => (out += data.toString()));
    child.stderr.on('data', (data: Buffer) => (err += data.toString()));
    child.once('exit', (code) => (code === 0 ? resolve(JSON.parse(out) as Reply) : reject(new Error(`child failed: ${err}`))));
  });
}

const storedNext = (directory: string): number => {
  const newest = readdirSync(directory).filter((name) => /^\d{16}\.json$/.test(name)).sort().at(-1)!;
  return (JSON.parse(readFileSync(join(directory, newest), 'utf8')) as { entries: Record<string, { next: number }> }).entries[`xmss:${keyId}`]!.next;
};

describe('two processes on one wallet store', () => {
  let path: string;
  let lock: string;
  beforeEach(() => {
    path = join(dir, 'wallet');
    cpSync(template, path, { recursive: true });
    lock = join(path, 'lock');
  });

  it('stops the first process signing once its lock was removed and a second opened the wallet', async () => {
    const a = walletProcess(path);
    const b = walletProcess(path);
    expect(await a.ask('open {}')).toEqual({ ok: true, next: 0 });
    expect(await b.ask('open {}')).toMatchObject({ error: 'STORE_LOCKED' });
    // What the old message told the user to do.
    rmSync(lock);
    expect(await b.ask('open {}')).toEqual({ ok: true, next: 0 });
    expect(await a.ask('send')).toMatchObject({ error: 'STORE_LOCKED' });
    expect(await b.ask('send')).toMatchObject({ index: 0 });
    expect(await a.ask('send')).toMatchObject({ error: 'STORE_LOCKED' });
    expect(await b.ask('send')).toMatchObject({ index: 1 });
    expect(storedNext(path)).toBe(2);
  }, 60_000);

  it('stops the first process signing once a second broke its lock, in either order of asking', async () => {
    const a = walletProcess(path);
    const b = walletProcess(path);
    await a.ask('open {}');
    expect(await b.ask('open {"breakLock":true}')).toEqual({ ok: true, next: 0 });
    expect(await a.ask('send')).toMatchObject({ error: 'STORE_LOCKED' });
    expect(await b.ask('send')).toMatchObject({ index: 0 });
    expect(storedNext(path)).toBe(1);
  }, 60_000);

  it('lets one process sign an index when each is the lock holder whenever it looks', async () => {
    const a = walletProcess(path);
    const b = walletProcess(path);
    await a.ask('open {}');
    const lockA = readFileSync(lock, 'utf8');
    await b.ask('open {"breakLock":true}');
    const lockB = readFileSync(lock, 'utf8');

    // Both hold index 0 in memory. A is the holder when it signs.
    writeFileSync(lock, lockA);
    const first = await a.ask('send');
    expect(first).toMatchObject({ index: 0 });
    // Now B is, and it is one revision behind.
    writeFileSync(lock, lockB);
    expect(await b.ask('send')).toMatchObject({ error: 'STORE_CONFLICT' });
    expect(await b.ask('send')).toMatchObject({ error: 'STORE_CONFLICT' });
    expect(storedNext(path)).toBe(1);

    // B starts again from the store and signs the next index; A, behind now, cannot.
    await b.ask('close');
    expect(await b.ask('open {"breakLock":true}')).toEqual({ ok: true, next: 1 });
    const second = await b.ask('send');
    expect(second).toMatchObject({ index: 1 });
    const lockB2 = readFileSync(lock, 'utf8');
    writeFileSync(lock, lockA);
    expect(await a.ask('send')).toMatchObject({ error: 'STORE_CONFLICT' });
    writeFileSync(lock, lockB2);
    expect(await b.ask('send')).toMatchObject({ index: 2 });
    expect(storedNext(path)).toBe(3);
  }, 60_000);

  it('never signs one index twice while both write and the lock flips between them', async () => {
    const signed: number[] = [];
    for (let round = 0; round < 4; round += 1) {
      const a = walletProcess(path);
      const b = walletProcess(path);
      rmSync(lock, { force: true });
      expect(await a.ask('open {}')).toMatchObject({ ok: true });
      const lockA = readFileSync(lock, 'utf8');
      expect(await b.ask('open {"breakLock":true}')).toMatchObject({ ok: true });
      const lockB = readFileSync(lock, 'utf8');
      let flip = 0;
      const flipping = setInterval(() => writeFileSync(lock, (flip += 1) % 2 === 0 ? lockA : lockB), 1);
      const replies = await Promise.all([a.ask('send'), b.ask('send'), a.ask('send'), b.ask('send')]);
      clearInterval(flipping);
      for (const reply of replies) {
        if (reply.index !== undefined) signed.push(reply.index);
        else expect(['STORE_CONFLICT', 'STORE_LOCKED', 'STORE_WRITE_FAILED', 'XMSS_INDEX_REUSE']).toContain(reply.error);
      }
      await Promise.all([a.ask('exit'), b.ask('exit')].map((asked) => Promise.race([asked, new Promise((resolve) => setTimeout(resolve, 200))])));
    }
    expect(new Set(signed).size).toBe(signed.length);
    for (const index of signed) expect(index).toBeLessThan(storedNext(path));
  }, 120_000);
});

describe('processes taking over one stale lock at the same moment', () => {
  it('lets one of them write, whichever of them the lock ends up naming', async () => {
    for (let round = 0; round < 3; round += 1) {
      const path = join(dir, `stale-${round}`);
      const store = createFileStore(path, { create: true });
      await store.set('n', 0);
      await store.close();
      // A lock left by a process that is gone and stopped touching it long ago.
      const lock = join(path, 'lock');
      writeFileSync(lock, JSON.stringify({ id: 'ab'.repeat(16), pid: 2 ** 22 + 4321, host: hostname(), heartbeatMs: 40 }));
      const old = new Date(Date.now() - 60_000);
      utimesSync(lock, old, old);
      const takers = Array.from({ length: 4 }, () => {
        const child = spawn(process.execPath, [bundle, 'takeover', path]);
        children.push(child);
        const replies: Reply[] = [];
        const waiting: ((reply: Reply) => void)[] = [];
        createInterface({ input: child.stdout }).on('line', (line) => {
          const reply = JSON.parse(line) as Reply;
          const next = waiting.shift();
          if (next === undefined) replies.push(reply);
          else next(reply);
        });
        const reply = (): Promise<Reply> => new Promise((resolve) => (replies.length > 0 ? resolve(replies.shift()!) : waiting.push(resolve)));
        return { child, reply };
      });
      const opened = await Promise.all(takers.map((taker) => taker.reply()));
      // Any number of them may have got as far as believing the lock theirs.
      expect(opened.filter((reply) => reply.ok === true).length).toBeGreaterThanOrEqual(1);
      for (const reply of opened) if (reply.ok !== true) expect(reply.error).toBe('STORE_LOCKED');
      for (const taker of takers) taker.child.stdin.write('go\n');
      const written = await Promise.all(takers.map((taker) => taker.reply()));
      expect(written.filter((reply) => reply.ok === true)).toHaveLength(1);
      for (const reply of written) if (reply.ok !== true) expect(['STORE_LOCKED', 'STORE_CONFLICT', 'STORE_WRITE_FAILED', 'OTHER']).toContain(reply.error);
      const newest = readdirSync(path).filter((name) => /^\d{16}\.json$/.test(name)).sort().at(-1)!;
      expect(JSON.parse(readFileSync(join(path, newest), 'utf8'))).toMatchObject({ revision: 2, entries: { n: 0, winner: expect.any(Number) } });
    }
  }, 60_000);
});

describe('processes fighting over one store with breakLock', () => {
  it('lets each compareAndSet from one value be won once, and loses no write', async () => {
    const path = join(dir, 'counter');
    const store = createFileStore(path, { create: true });
    await store.set('n', 0);
    await store.close();
    const results = await Promise.all([run('counter', path, 150), run('counter', path, 150), run('counter', path, 150)]);
    const won = results.flatMap((result) => result.won!);
    expect(won.length).toBeGreaterThan(0);
    expect(new Set(won).size).toBe(won.length);
    rmSync(join(path, 'lock'), { force: true });
    const after = createFileStore(path);
    // Every win moved the counter by one, and each value was won by the process the store says.
    expect(await after.get('n')).toBe(won.length);
    expect((await after.list('won:')).map(([key]) => Number(key.slice(4))).sort((x, y) => x - y)).toEqual([...won].sort((x, y) => x - y));
    await after.close();
  }, 120_000);

  it('hands each XMSS index of a state file to one process', async () => {
    const path = join(dir, 'key.xmss-index');
    createFileXmssIndexStore(path, { create: true }).close();
    const results = await Promise.all([run('xmss-file', path, 40), run('xmss-file', path, 40), run('xmss-file', path, 40)]);
    const won = results.flatMap((result) => result.won!);
    expect(won.length).toBeGreaterThan(0);
    expect(new Set(won).size).toBe(won.length);
    for (const index of won) expect(index).toBeGreaterThanOrEqual(0);
    expect(Math.max(...won)).toBeLessThan(readXmssIndexFile(path).next);
    expect(readXmssIndexFile(path).next).toBeLessThanOrEqual(31);
  }, 120_000);
});
