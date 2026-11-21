// Two real processes on one wallet store directory, with a regtest pearld:
// the second is refused while the first holds the store; after the first is
// killed the store is taken over with breakStaleLock, and with breakLock
// from under a holder that is still alive, whose next write is then
// refused. An XMSS key is spent from every holder in turn, and the indices
// in the mined witnesses are never repeated.

import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { buildSync } from 'esbuild';
import { expect, it } from 'vitest';
import { inspectTransaction, parseTransaction, PearlWallet, StoreError, toOutputScript } from '../../src/index.js';
import { createFileStore } from '../../src/store-file.js';
import { describeLive, FEE_RATE, fund, live, mine, network, nowhere, pearld, spentOutputs } from './chain.js';
import { connection, outsider, PASSPHRASE, QUICK_KDF } from './wallets.js';

const { elsewhere } = outsider(12);

interface Holder {
  child: ChildProcessWithoutNullStreams;
  /** The next line the process writes, parsed. */
  next(): Promise<Record<string, unknown>>;
  ask(request: Record<string, unknown>): Promise<Record<string, unknown>>;
  kill(): Promise<void>;
}

function startHolder(path: string, lock: 'none' | 'stale' | 'break'): Holder {
  // Bundled next to node_modules so the child resolves the same packages.
  const script = join(import.meta.dirname, '../../node_modules/.cache/pearljs-live/wallet-holder.mjs');
  buildSync({ entryPoints: [join(import.meta.dirname, 'wallet-holder.ts')], bundle: true, packages: 'external', platform: 'node', format: 'esm', outfile: script, logLevel: 'silent' });
  const endpoint = live?.pearld ?? nowhere;
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, WALLET_PATH: path, WALLET_PASS: PASSPHRASE, LOCK: lock, NODE_URL: endpoint.url, NODE_USER: endpoint.username, NODE_PASS: endpoint.password, NODE_CA: endpoint.ca },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const next = async (): Promise<Record<string, unknown>> => {
    const line = await lines.next();
    if (line.done === true) throw new Error('the holder exited');
    return JSON.parse(line.value) as Record<string, unknown>;
  };
  return {
    child,
    next,
    async ask(request) {
      child.stdin.write(`${JSON.stringify(request)}\n`);
      return next();
    },
    async kill() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGKILL');
      await exited;
    },
  };
}

const open = (path: string, options: Parameters<typeof createFileStore>[1] = {}): unknown => {
  try {
    return createFileStore(path, options);
  } catch (err) {
    return err;
  }
};

describeLive('two processes on one wallet store', () => {
  it('refuses a second process, is taken over after a kill and from a live holder, and never signs one XMSS index twice', async () => {
    const dir = join(live?.dir ?? '.', 'wallet-processes');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'store');
    const wallet = await PearlWallet.create({ ...connection(createFileStore(path, { create: true })), passphrase: PASSPHRASE, unlockTimeout: null, kdf: QUICK_KDF });
    const key = await wallet.addXmssKey({ label: 'shared' });
    const script = toOutputScript(key.address, network);
    await fund([1, 2, 3, 4].map((n) => ({ script, value: BigInt(n) * 5_000_000n })));
    await wallet.sync();
    await wallet.close();
    const spends: string[] = [];
    const sendRequest = (n: number) => ({ op: 'send', address: elsewhere(n), amount: '1000000', from: { xmss: key.id } });

    // The first process holds the store; a second process and this one are both refused.
    const first = startHolder(path, 'none');
    expect(await first.next()).toEqual({ open: first.child.pid });
    const second = startHolder(path, 'none');
    expect(await second.next()).toMatchObject({ error: { name: 'StoreError', code: 'STORE_LOCKED' } });
    await new Promise((resolve) => second.child.once('exit', resolve));
    expect(second.child.exitCode).toBe(1);
    const refused = open(path);
    expect(refused).toBeInstanceOf(StoreError);
    expect(refused).toMatchObject({ code: 'STORE_LOCKED', message: expect.stringContaining(`process ${first.child.pid}`) as string });
    // breakStaleLock does not take a lock whose holder is running.
    expect(open(path, { breakStaleLock: true })).toMatchObject({ code: 'STORE_LOCKED' });

    const sent = await first.ask(sendRequest(0));
    expect(sent).toMatchObject({ txid: expect.stringMatching(/^[0-9a-f]{64}$/) as string });
    spends.push(sent.txid as string);
    await first.kill();

    // Dead, but its lock is fresh: not stale yet. Once the holder's heartbeat is overdue, breakStaleLock takes it.
    expect(open(path, { breakStaleLock: true })).toMatchObject({ code: 'STORE_LOCKED' });
    await new Promise((resolve) => setTimeout(resolve, 11_000));
    const stale = open(path);
    expect(stale).toMatchObject({ code: 'STORE_LOCKED', message: expect.stringContaining('breakStaleLock: true') as string });
    const third = startHolder(path, 'stale');
    expect(await third.next()).toEqual({ open: third.child.pid });
    await mine(1);
    expect(await third.ask({ op: 'sync' })).toMatchObject({ balance: expect.any(String) as string });
    const again = await third.ask(sendRequest(1));
    expect(again).toMatchObject({ txid: expect.any(String) as string });
    spends.push(again.txid as string);

    // Taken from under a live holder: the holder's next send is refused before anything is signed.
    const takeover = await PearlWallet.open(connection(createFileStore(path, { breakLock: true })));
    await takeover.unlock(PASSPHRASE);
    const late = await third.ask(sendRequest(2));
    expect(late).toMatchObject({ error: { code: expect.stringMatching(/^(STORE_LOCKED|STORE_CONFLICT|XMSS_INDEX_REUSE)$/) as string } });
    // The first spend was mined before the takeover; the refused holder left nothing behind it.
    expect(await pearld.getRawMempool()).toEqual([spends[1]]);
    await takeover.sync();
    const own = await takeover.send({ recipients: [{ address: elsewhere(3), amount: 1_000_000n }], from: { xmss: key.id }, feeRate: FEE_RATE });
    spends.push(own.txid);
    await third.kill();
    await mine(1);
    await takeover.sync();
    expect(takeover.xmssKeys()).toMatchObject([{ id: key.id, nextIndex: 3, highestOnChain: 2, frozen: null }]);
    await takeover.close();

    // On chain: three XMSS signatures from one key, at three different indices.
    const indices: number[] = [];
    for (const txid of spends) {
      const info = await pearld.getRawTransaction(txid);
      expect(info.confirmations).toBeGreaterThan(0);
      const tx = parseTransaction(info.hex);
      const view = inspectTransaction(tx, await spentOutputs(tx), network);
      for (const input of view.inputs) {
        if (input.spend.type === 'scriptPath' && input.spend.leaf === 'xmss') indices.push(input.spend.xmssIndex!);
      }
    }
    expect(indices).toEqual([0, 1, 2]);
  });
});
