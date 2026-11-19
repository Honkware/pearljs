// The block checks filterBackend and pearldBackend's P2MR scan make, on real
// regtest blocks: the limited user reads raw headers with getblockheader
// over HTTP and the websocket, a match download passes the header, witness
// commitment and certificate checks, and crossCheck against a second pearld
// scans only to the lower tip, refuses one too far behind, one on another
// fork and one that cannot be reached. Runs after reorg.test.ts: the second
// node mines a fork of its own.

import { join } from 'node:path';
import { WebSocket } from 'undici';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  assembleScriptTree,
  blockHashHex,
  checksigScript,
  deriveSigningAccountFromSeed,
  filterBackend,
  generateMnemonic,
  mnemonicToSeed,
  p2mrAddress,
  parseBlockHeader,
  pearldBackend,
  PearlWsClient,
  toOutputScript,
} from '../src/index.js';
import type { PearldClient } from '../src/index.js';
import { describeLive, eventually, fund, limited, live, mine, network, nowhere, pearld } from './chain.js';
import { startPearld } from './processes.js';
import type { RunningPearld } from './processes.js';
import { trustingAgent } from './context.js';

const account = deriveSigningAccountFromSeed(mnemonicToSeed(generateMnemonic()), network);
const failure = (promise: Promise<unknown>): Promise<unknown> => promise.then(() => null, (err: unknown) => err);

describeLive('block checks on real blocks', () => {
  let peer: RunningPearld;
  let peerClient: PearldClient;

  const together = async (): Promise<void> => {
    await peerClient.call('node', ['connect', live!.p2p, 'temp']);
    const tip = await pearld.getBestBlockHash();
    await eventually(() => peerClient.getBestBlockHash(), (hash) => hash === tip, 120_000);
  };
  const apart = async (): Promise<void> => {
    await peerClient.call('node', ['disconnect', live!.p2p]);
    await eventually(() => peerClient.call<unknown[]>('getpeerinfo'), (peers) => peers.length === 0);
  };

  beforeAll(async () => {
    peer = await startPearld({ exe: process.env.PEARLD!, dir: join(live!.dir, 'pearld-crosscheck'), miningAddress: account.deriveAddress(90), withoutIndexes: true });
    peerClient = peer.client;
    await together();
  });
  afterAll(async () => {
    await peer?.stop();
  });

  it('gives the limited user raw headers over HTTP and the websocket', async () => {
    const hash = await pearld.getBestBlockHash();
    const header = await limited.getRawBlockHeader(hash);
    expect(header).toHaveLength(108);
    expect(blockHashHex(parseBlockHeader(header))).toBe(hash);
    const endpoint = live?.pearld ?? nowhere;
    const agent = trustingAgent(endpoint.ca);
    const ws = new PearlWsClient({ url: endpoint.url, username: live!.limited.username, password: live!.limited.password, WebSocket, webSocketInit: { dispatcher: agent } });
    try {
      expect(await ws.getRawBlockHeader(hash)).toEqual(header);
    } finally {
      await ws.close();
      await agent.close();
    }
  });

  it('downloads matching blocks past every check, cross-checked against a second node, and finds a P2MR payment by its filters', async () => {
    const birthday = await pearld.getBlockCount();
    const address = account.deriveAddress(0);
    const p2mr = p2mrAddress({ merkleRoot: assembleScriptTree([checksigScript(account.derivePublicKey(1))]).root }, network);
    const funding = await fund([
      { script: toOutputScript(address, network), value: 3_000_000n },
      { script: toOutputScript(p2mr, network), value: 2_000_000n },
    ]);
    await mine(2);
    await together();
    const progress: number[] = [];
    const backend = filterBackend(limited, { network, birthday, watch: [address, p2mr], crossCheck: [peerClient] });
    const tip = await backend.sync({ onProgress: (round) => void progress.push(round.blocksFetched) });
    expect(tip).toEqual({ height: birthday + 3, hash: await pearld.getBestBlockHash() });
    expect(progress.at(-1)).toBe(1);
    expect(await backend.getUtxos([address, p2mr])).toMatchObject([
      { txid: funding.getId(), vout: 0, value: 3_000_000n, confirmations: 3 },
      { txid: funding.getId(), vout: 1, value: 2_000_000n, confirmations: 3 },
    ]);
    // pearldBackend reads P2MR addresses through the same filters and header checks, as the limited user too.
    const scanned = pearldBackend(limited, { network, scanFrom: birthday });
    expect(await scanned.getHistory(p2mr)).toMatchObject([{ txid: funding.getId(), block: { height: birthday + 1 }, received: 2_000_000n }]);
  });

  it('scans to the lower tip of a node behind, and refuses one more than crossCheckLag behind', async () => {
    await apart();
    const birthday = await pearld.getBlockCount();
    const peerTip = await peerClient.getBestBlock();
    await mine(3);
    const backend = filterBackend(limited, { network, birthday, crossCheck: [peerClient], crossCheckLag: 6, maxAge: 0 });
    expect(await backend.sync()).toEqual({ height: peerTip.height, hash: peerTip.hash });
    await mine(4);
    const refused = await failure(backend.sync());
    expect(refused).toMatchObject({ code: 'CROSS_CHECK_FAILED', message: expect.stringContaining('more than crossCheckLag (6)') as string });
    await together();
    expect((await backend.sync()).hash).toBe(await pearld.getBestBlockHash());
  });

  it('refuses a cross-check node on another fork, and one that cannot be reached', async () => {
    await together();
    const birthday = await pearld.getBlockCount() - 2;
    await apart();
    // The second node leaves its tip and mines a branch of its own.
    const shared = await peerClient.getBestBlockHash();
    await peerClient.invalidateBlock(shared);
    const fork = await peerClient.call<string[]>('generate', [1]);
    expect(fork[0]).not.toBe(shared);
    expect(await pearld.getBestBlockHash()).toBe(shared);
    const backend = filterBackend(limited, { network, birthday, crossCheck: [peerClient], maxAge: 0 });
    const refused = await failure(backend.sync());
    expect(refused).toMatchObject({ code: 'CROSS_CHECK_FAILED', message: expect.stringContaining(`where the node has ${shared}`) as string });

    await peer.stop();
    const unreachable = await failure(filterBackend(limited, { network, birthday, crossCheck: [peerClient], maxAge: 0 }).sync());
    expect(unreachable).toMatchObject({ code: 'CROSS_CHECK_FAILED', message: expect.stringContaining('could not be asked') as string });
  });
});
