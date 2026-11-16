// The error classes and stable codes of docs/errors.md, raised by a real
// pearld and a real Oyster: every kind of PearlRpcError over HTTPS and over
// the websocket with the number pearld sends, and the codes that leave a
// process as JSON. Oyster's are in wallet-errors.test.ts. Policy, replacement, backend and wallet codes are
// asserted next to the node's own refusals in the files that provoke them.

import { Agent, WebSocket } from 'undici';
import { expect, it } from 'vitest';
import {
  PearldClient,
  PearlError,
  PearlRpcError,
  PearlWsClient,
  RPC_ERROR_CODES,
  searchAllTransactions,
  serializeTransaction,
} from '../src/index.js';
import type { PearlErrorJson } from '../src/index.js';
import { clientOptions } from './context.js';
import { describeLive, fund, limited, live, miner, minerScript, nowhere, pearld } from './chain.js';
import { freePort } from './processes.js';

async function failure(promise: Promise<unknown>): Promise<PearlRpcError> {
  const error = await promise.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(PearlRpcError);
  expect(error).toBeInstanceOf(PearlError);
  return error as PearlRpcError;
}

describeLive('typed errors from pearld', () => {
  const endpoint = live?.pearld ?? nowhere;

  it('gives RPC_ERROR and the number pearld sent for each kind of refusal', async () => {
    const funding = await fund([{ script: minerScript, value: 1_000_000n }]);
    const tip = await pearld.getBlockHex(await pearld.getBestBlockHash());
    const refusals: [() => Promise<unknown>, number, string][] = [
      [() => pearld.call('nosuchmethod'), RPC_ERROR_CODES.METHOD_NOT_FOUND, 'nosuchmethod'],
      [() => pearld.getRawTransaction('00'.repeat(32)), RPC_ERROR_CODES.INVALID_ADDRESS_OR_KEY, 'getrawtransaction'],
      [() => pearld.getBlock('00'.repeat(32)), RPC_ERROR_CODES.INVALID_ADDRESS_OR_KEY, 'getblock'],
      [() => pearld.searchRawTransactions('not an address'), RPC_ERROR_CODES.INVALID_ADDRESS_OR_KEY, 'searchrawtransactions'],
      [() => pearld.getBlockHash(1_000_000), RPC_ERROR_CODES.MISC, 'getblockhash'],
      [() => pearld.estimateFee(0), RPC_ERROR_CODES.INVALID_PARAMETER, 'estimatefee'],
      [() => pearld.sendRawTransaction('zz'), RPC_ERROR_CODES.DESERIALIZATION, 'sendrawtransaction'],
      [() => pearld.sendRawTransaction(serializeTransaction(funding)), RPC_ERROR_CODES.TX_ALREADY_IN_CHAIN, 'sendrawtransaction'],
      // submitblock answers a rejection as a result; the client turns it into the error pearld's other verify failures are.
      [() => pearld.submitBlock(tip), RPC_ERROR_CODES.VERIFY, 'submitblock'],
      [() => pearld.call('getblockhash', ['one']), RPC_ERROR_CODES.INVALID_PARAMS, 'getblockhash'],
      [() => limited.getBlockchainInfo(), RPC_ERROR_CODES.INTERNAL, 'getblockchaininfo'],
    ];
    for (const [call, rpcCode, method] of refusals) {
      const error = await failure(call());
      expect(error, method).toMatchObject({ name: 'PearlRpcError', code: 'RPC_ERROR', kind: 'rpc', rpcCode, method, status: undefined });
    }
    // An altered copy of a mined transaction spends an output that is gone. pearld calls it an orphan and answers -25, not -26.
    const spend = funding.clone();
    spend.outs[0]!.value -= 1n;
    expect(await failure(pearld.sendRawTransaction(serializeTransaction(spend)))).toMatchObject({
      code: 'RPC_ERROR',
      rpcCode: RPC_ERROR_CODES.VERIFY,
      message: expect.stringContaining('orphan transaction') as string,
    });
  });

  it('gives RPC_HTTP with the status, RPC_NETWORK for a server that cannot be reached or is given up on, and RPC_RESPONSE for an answer that cannot be used', async () => {
    const wrong = new PearldClient(clientOptions(endpoint, { username: endpoint.username, password: 'wrong' }));
    expect(await failure(wrong.getBlockCount())).toMatchObject({ code: 'RPC_HTTP', kind: 'http', status: 401, rpcCode: undefined });
    const plain = new PearldClient({ ...clientOptions(endpoint), url: endpoint.url.replace('https:', 'http:') });
    expect(await failure(plain.getBlockCount())).toMatchObject({ code: 'RPC_HTTP', status: 400 });

    const refused = new PearldClient({ ...clientOptions(endpoint), url: `https://127.0.0.1:${await freePort()}` });
    const untrusting = new PearldClient({ url: endpoint.url, username: endpoint.username, password: endpoint.password });
    for (const call of [
      () => refused.getBlockCount(),
      () => untrusting.getBlockCount(),
      () => pearld.call('getblockcount', [], { timeout: 1 }),
      () => pearld.call('getblockcount', [], { signal: AbortSignal.abort() }),
    ]) {
      expect(await failure(call())).toMatchObject({ code: 'RPC_NETWORK', kind: 'network', rpcCode: undefined, status: undefined });
    }

    // The miner's address has more transactions than one page of one, and the walk is told to stop there.
    const tooMany = await failure(searchAllTransactions(pearld, miner.deriveAddress(0), { pageSize: 1, maxPages: 1 }));
    expect(tooMany).toMatchObject({ code: 'RPC_RESPONSE', kind: 'response', method: 'searchrawtransactions' });
  });

  it('gives the same codes over the websocket', async () => {
    const agent = new Agent({ connect: { ca: endpoint.ca } });
    const socket = (password: string, extra: { auth?: 'header' | 'command' } = {}): PearlWsClient =>
      new PearlWsClient({ url: endpoint.url, username: endpoint.username, password, WebSocket, webSocketInit: { dispatcher: agent }, reconnect: false, ...extra });
    const ws = socket(endpoint.password);
    try {
      expect(await failure(ws.call('nosuchmethod'))).toMatchObject({ code: 'RPC_ERROR', rpcCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
      expect(await failure(ws.getRawTransaction('00'.repeat(32)))).toMatchObject({ code: 'RPC_ERROR', rpcCode: RPC_ERROR_CODES.INVALID_ADDRESS_OR_KEY });
      expect(await failure(ws.sendRawTransaction('zz'))).toMatchObject({ code: 'RPC_ERROR', rpcCode: RPC_ERROR_CODES.DESERIALIZATION });
      expect(await failure(ws.call('getblockcount', [], { signal: AbortSignal.abort() }))).toMatchObject({ code: 'RPC_NETWORK', kind: 'network' });
      expect(await ws.getBlockCount()).toBe(await pearld.getBlockCount());

      const wrong = socket('not the password');
      expect(await failure(wrong.connect())).toMatchObject({ code: 'RPC_HTTP', kind: 'http', status: 401 });
      await wrong.close();
      const untrusting = new PearlWsClient({ url: endpoint.url, username: endpoint.username, password: endpoint.password, WebSocket, reconnect: false });
      expect(await failure(untrusting.connect())).toMatchObject({ code: 'RPC_NETWORK', kind: 'network' });
      await untrusting.close();
    } finally {
      await ws.close();
      await agent.close();
    }
  });

  it('carries a node error across a process boundary as its name, code and message', async () => {
    const error = await failure(pearld.getRawTransaction('00'.repeat(32)));
    const wire = JSON.parse(JSON.stringify(error)) as PearlErrorJson;
    expect(wire).toEqual({ name: 'PearlRpcError', code: 'RPC_ERROR', message: error.message });
    const revived = PearlError.fromJSON(wire);
    expect(revived).toBeInstanceOf(PearlError);
    expect(revived).toMatchObject({ code: 'RPC_ERROR', message: error.message });
    // Nothing in it names the password.
    expect(JSON.stringify(error)).not.toContain(endpoint.password);
  });
});
