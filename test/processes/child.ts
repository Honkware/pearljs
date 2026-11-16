// The child process of store-processes.test.ts, bundled with esbuild and
// run with node. As `wallet` it opens the wallet in a store directory and
// takes commands on stdin, answering each with one line of JSON; as
// `counter` and `xmss-file` it fights other children for one store, opening
// it with breakLock each time, and prints what it won.

import { createInterface } from 'node:readline';
import { PearlError, PearlWallet, parsePearl, parseTransaction } from '../../src/index.js';
import type { JsonValue } from '../../src/index.js';
import { createFileStore } from '../../src/store-file.js';
import type { FileStore } from '../../src/store-file.js';
import { createFileXmssIndexStore } from '../../src/xmss-file-store.js';
import { FakeChain, PASSPHRASE, STRANGER } from '../wallet-chain.js';

/** The chain every process builds for itself: the same coins at the XMSS address, so the same txids. */
export function chainFor(address: string): FakeChain {
  const chain = new FakeChain();
  for (let i = 0; i < 12; i += 1) chain.pay(address, parsePearl('1'));
  chain.mine();
  return chain;
}

const say = (value: unknown): void => void process.stdout.write(`${JSON.stringify(value)}\n`);
const failure = (error: unknown): { error: string; message: string } => ({
  error: error instanceof PearlError ? error.code : 'OTHER',
  message: error instanceof Error ? error.message : String(error),
});

async function walletChild(directory: string): Promise<void> {
  let store: FileStore | null = null;
  let wallet: PearlWallet | null = null;
  for await (const line of createInterface({ input: process.stdin })) {
    const [command, argument] = [line.split(' ')[0], line.slice(line.indexOf(' ') + 1)];
    try {
      if (command === 'open') {
        store = createFileStore(directory, JSON.parse(argument) as object);
        const empty = new FakeChain();
        const key = (await PearlWallet.open({ store: { ...store, close: async () => undefined }, backend: empty, transactions: empty })).xmssKeys()[0]!;
        const chain = chainFor(key.address);
        wallet = await PearlWallet.open({ store, backend: chain, transactions: chain });
        await wallet.unlock(PASSPHRASE);
        say({ ok: true, next: key.nextIndex });
      } else if (command === 'send') {
        const key = wallet!.xmssKeys()[0]!;
        const sent = await wallet!.send({ recipients: [{ address: STRANGER, amount: parsePearl('0.1') }], feeRate: 2000n, from: { xmss: key.id } });
        const witness = parseTransaction(sent.hex).ins[0]!.witness[0]!;
        say({ index: new DataView(witness.buffer, witness.byteOffset, 4).getUint32(0), txid: sent.txid });
      } else if (command === 'close') {
        await wallet?.close().catch(() => store?.close());
        say({ ok: true });
      } else {
        process.exit(0);
      }
    } catch (error) {
      say(failure(error));
    }
  }
}

async function counterChild(directory: string, rounds: number): Promise<void> {
  const won: number[] = [];
  for (let round = 0; round < rounds; round += 1) {
    try {
      const store = createFileStore(directory, { breakLock: true });
      const n = (await store.get('n')) as number;
      const expected = [{ key: 'n', value: n as JsonValue }];
      if (await store.compareAndSet(expected, [{ type: 'set', key: 'n', value: n + 1 }, { type: 'set', key: `won:${n}`, value: process.pid }])) won.push(n);
      await store.close();
    } catch (error) {
      if (!(error instanceof PearlError)) throw error;
    }
  }
  say({ won });
}

function xmssFileChild(path: string, rounds: number): void {
  const key = new Uint8Array(64).fill(0xa1);
  const won: number[] = [];
  for (let round = 0; round < rounds; round += 1) {
    try {
      const store = createFileXmssIndexStore(path, { breakLock: true });
      try {
        won.push(store.reserve(key));
      } finally {
        store.close();
      }
    } catch (error) {
      if (!(error instanceof PearlError)) throw error;
    }
  }
  say({ won });
}

const [mode, target, rounds] = process.argv.slice(2);
if (mode === 'wallet') await walletChild(target!);
else if (mode === 'counter') await counterChild(target!, Number(rounds));
else if (mode === 'xmss-file') xmssFileChild(target!, Number(rounds));
