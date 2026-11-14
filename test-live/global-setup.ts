// Starts one regtest pearld for the whole live suite, mines past coinbase
// maturity to a pearljs address, and starts Oyster when OYSTER is set. The
// returned teardown stops both even when tests fail.

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { deriveSigningAccountFromSeed, mnemonicToSeed, networks } from '../src/index.js';
import { MINER_MNEMONIC, OYSTER_MNEMONIC, OYSTER_PASSPHRASE, mineBlocks, type LiveContext } from './context.js';
import { startOyster, startPearld, type RunningPearld } from './processes.js';

declare module 'vitest' {
  export interface ProvidedContext {
    live: LiveContext | null;
  }
}

// Coinbase outputs spend after 100 blocks, so 101 leaves the first one mature.
const INITIAL_BLOCKS = 101;

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const pearld = process.env.PEARLD;
  if (pearld === undefined || pearld === '') {
    console.warn(
      '\nSkipping live tests: set PEARLD to a pearld binary (and OYSTER to an oyster binary for the wallet tests).\n',
    );
    project.provide('live', null);
    return async () => {};
  }

  const root = await mkdtemp(join(process.env.PEARL_LIVE_DIR ?? tmpdir(), 'pearljs-live-'));
  const running: { stop(): Promise<void> }[] = [];
  const teardown = async (): Promise<void> => {
    for (const child of running.reverse()) await child.stop();
    if (process.env.PEARL_LIVE_KEEP === undefined) await rm(root, { recursive: true, force: true });
    else console.warn(`Kept live test data in ${root}`);
  };

  try {
    const miner = deriveSigningAccountFromSeed(mnemonicToSeed(MINER_MNEMONIC), networks.regtest);
    const options = { exe: pearld, dir: join(root, 'pearld'), miningAddress: miner.deriveAddress(0) };
    const node: RunningPearld = await startPearld(options);
    running.push(node);
    // PEARL_LIVE_CHAIN names a file that caches the setup blocks between
    // runs. pearld wipes its regtest database on every start, so the blocks
    // are submitted again, which needs no proving.
    const cache = process.env.PEARL_LIVE_CHAIN;
    if (cache !== undefined && cache !== '' && (await exists(cache))) {
      const blocks = JSON.parse(await readFile(cache, 'utf8')) as string[];
      for (const block of blocks) await node.client.call('submitblock', [block]);
      if ((await node.client.getBlockCount()) !== blocks.length) throw new Error(`pearld refused the blocks in ${cache}`);
    } else {
      console.warn(`pearld is up, mining ${INITIAL_BLOCKS} blocks (each needs a real ZK proof, a few seconds apiece)`);
      const hashes = await mineBlocks(node.client, INITIAL_BLOCKS);
      if (cache !== undefined && cache !== '') {
        const blocks: string[] = [];
        for (const hash of hashes) blocks.push(await node.client.getBlockHex(hash));
        await writeFile(cache, JSON.stringify(blocks));
      }
    }

    let oyster: Awaited<ReturnType<typeof startOyster>> | null = null;
    const oysterExe = process.env.OYSTER;
    if (oysterExe !== undefined && oysterExe !== '') {
      oyster = await startOyster({
        exe: oysterExe,
        dir: join(root, 'oyster'),
        pearld: node.endpoint,
        mnemonic: OYSTER_MNEMONIC,
        passphrase: OYSTER_PASSPHRASE,
      });
      running.push(oyster);
    } else {
      console.warn('Skipping Oyster tests: set OYSTER to an oyster binary to run them.');
    }
    project.provide('live', {
      pearld: node.endpoint,
      limited: node.limited,
      p2p: node.p2p,
      oyster: oyster?.endpoint ?? null,
      dir: root,
    });
  } catch (error) {
    await teardown();
    throw error;
  }
  return teardown;
}
