// The Blockbook client and backend against a real server, skipped unless
// PEARL_BLOCKBOOK_URL names one, e.g.
//
//   PEARL_BLOCKBOOK_URL=https://blockbook.pearlresearch.ai npx vitest run test/blockbook-live.test.ts
//
// PEARL_BLOCKBOOK_NETWORK picks the network (mainnet unless given; testnet2
// for Pearl's testnet server), and PEARL_BLOCKBOOK_ADDRESSES, a comma
// separated list, adds a balance check of those addresses, which costs a
// request for every transaction they have and every block holding one. The
// rest asks some 20 requests of the server.

import { describe, expect, it } from 'vitest';
import {
  BlockbookClient,
  BlockbookWsClient,
  blockHashHex,
  blockbookBackend,
  checkCertificateBinding,
  checkCertificateRules,
  checkMerkleRoot,
  checkWitnessCommitment,
  difficultyForBits,
  networks,
  parseBlock,
  type PearlNetworkName,
} from '../src/index.js';
import { fromHex } from '../src/internal/bytes.js';

const url = process.env.PEARL_BLOCKBOOK_URL;
const network = networks[(process.env.PEARL_BLOCKBOOK_NETWORK ?? 'mainnet') as PearlNetworkName];
const addresses = (process.env.PEARL_BLOCKBOOK_ADDRESSES ?? '').split(',').filter((address) => address !== '');

describe.skipIf(url === undefined)('a live Blockbook', () => {
  const client = new BlockbookClient({ url: url ?? 'https://unused.example', network, retry: true, maxConcurrentRequests: 2 });
  const backend = blockbookBackend(client, { concurrency: 2 });

  it('serves the network, in sync with its pearld', async () => {
    const status = await client.getStatus();
    expect(status.backend.chain).toBe(network.name);
    expect(status.blockbook.inSync).toBe(true);
    expect(Math.abs((status.backend.blocks ?? 0) - status.blockbook.bestHeight)).toBeLessThanOrEqual(2);
  }, 60_000);

  it('describes a recent block as its serialization does, and the block passes the backend\'s checks', async () => {
    const height = (await client.getStatus()).blockbook.bestHeight - 6;
    const block = await client.getBlock(height);
    const raw = fromHex(await client.getRawBlock(block.hash));
    const parsed = parseBlock(raw);
    expect(blockHashHex(parsed.header)).toBe(block.hash);
    expect(block.size).toBe(raw.length);
    expect(block.difficulty).toBe(difficultyForBits(parsed.header.bits, network).toFixed(8));
    checkMerkleRoot(parsed);
    checkWitnessCommitment(parsed);
    checkCertificateBinding(parsed);
    checkCertificateRules(parsed.certificate, network, height);

    const coinbase = block.txs![0]!.txid;
    expect(await backend.getTransaction(coinbase)).toMatchObject({ txid: coinbase, block: { height, hash: block.hash } });
    const said = (await client.getTransaction(coinbase)).vout[0]!;
    expect((await backend.getSpendStatus({ txid: coinbase, vout: 0 })).status).toBe(said.spent === true ? 'spent' : 'unspent');
  }, 120_000);

  it('estimates fees in grain per 1000 vbytes, and answers HTTP 500 where pearld has no estimate', async () => {
    expect(await client.estimateFee(6)).toBeGreaterThan(0n);
    await expect(client.estimateFee(0)).rejects.toMatchObject({ kind: 'rpc', status: 500 });
  }, 60_000);

  it('answers over the websocket as over REST', async () => {
    const ws = new BlockbookWsClient({ url: url!, network, reconnect: false });
    try {
      const info = await ws.getInfo();
      expect(info.block0Hash).toBe(network.genesisHash);
      expect(await ws.getBlockHash(info.bestHeight - 1)).toBe(await client.getBlockHash(info.bestHeight - 1));
      expect(await ws.getBlockHash(info.bestHeight + 1000)).toBeNull();
      await expect(ws.call('estimateFee', { blocks: [6] })).rejects.toMatchObject({ kind: 'rpc' });
    } finally {
      await ws.close();
    }
  }, 60_000);

  it.skipIf(addresses.length === 0)('finds the balance the server reports for the addresses', async () => {
    const tip = await backend.getTip();
    const balance = await backend.getBalance(addresses);
    const said = await Promise.all(addresses.map((address) => client.getAddress(address, { details: 'basic' })));
    // Blockbook's balance counts every confirmed output, immature coinbases included.
    if ((await backend.getTip()).height === tip.height) expect(balance.confirmed + balance.immature).toBe(said.reduce((sum, reply) => sum + reply.balance, 0n));
  }, 600_000);
});
