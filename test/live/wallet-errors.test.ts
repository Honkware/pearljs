// The error classes and stable codes of docs/errors.md, raised by a real
// Oyster: its wallet codes, a wrong password, a TLS version it refuses and
// the batch it answers with one error. Runs after oyster.test.ts, which needs a
// wallet nobody has asked for an address yet.

import { expect, it } from 'vitest';
import { JsonRpcClient, OysterClient, PearlError, PearlRpcError, RPC_ERROR_CODES } from '../../src/index.js';
import { clientOptions, OYSTER_PASSPHRASE, trustingAgent } from './context.js';
import { describeOyster, live, miner, nowhere, oyster } from './chain.js';

async function failure(promise: Promise<unknown>): Promise<PearlRpcError> {
  const error = await promise.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(PearlRpcError);
  expect(error).toBeInstanceOf(PearlError);
  return error as PearlRpcError;
}

describeOyster('typed errors from Oyster', () => {
  const endpoint = live?.oyster ?? nowhere;

  it('gives RPC_ERROR with Oyster\'s wallet codes and for a batch, RPC_HTTP for a wrong password and RPC_NETWORK for TLS 1.2', async () => {
    await oyster.walletLock();
    const address = await oyster.getNewAddress();
    const refusals: [() => Promise<unknown>, number][] = [
      [() => oyster.call('nosuchmethod'), RPC_ERROR_CODES.METHOD_NOT_FOUND],
      [() => oyster.getTransaction('00'.repeat(32)), RPC_ERROR_CODES.INVALID_ADDRESS_OR_KEY],
      [() => oyster.dumpPrivKey(address), RPC_ERROR_CODES.WALLET_UNLOCK_NEEDED],
      [() => oyster.walletPassphrase('not the passphrase', 60), RPC_ERROR_CODES.WALLET_PASSPHRASE_INCORRECT],
      [() => oyster.getSyncProgress(), RPC_ERROR_CODES.WALLET],
    ];
    for (const [call, rpcCode] of refusals) {
      expect(await failure(call()), String(rpcCode)).toMatchObject({ name: 'PearlRpcError', code: 'RPC_ERROR', kind: 'rpc', rpcCode });
    }
    await oyster.walletPassphrase(OYSTER_PASSPHRASE, 3600);
    const balance = await oyster.getBalance();
    // Oyster has a code for this, -6, and does not use it: its error mapping sends coin selection's failure as an internal error.
    expect(await failure(oyster.sendToAddress(miner.deriveAddress(0), balance + 1n, 1000n))).toMatchObject({
      code: 'RPC_ERROR',
      rpcCode: RPC_ERROR_CODES.INTERNAL,
      message: expect.stringContaining('insufficient funds') as string,
    });

    const wrong = new OysterClient(clientOptions(endpoint, { username: endpoint.username, password: 'wrong' }));
    expect(await failure(wrong.getBalance())).toMatchObject({ code: 'RPC_HTTP', kind: 'http', status: 401 });
    const tls12 = new JsonRpcClient({ ...clientOptions(endpoint), init: { dispatcher: trustingAgent(endpoint.ca, { maxVersion: 'TLSv1.2' }) } });
    expect(await failure(tls12.call('getinfo'))).toMatchObject({ code: 'RPC_NETWORK', kind: 'network' });

    // Oyster answers a batch with one error for the lot, and every call in it gets that error.
    const batched = new JsonRpcClient({ ...clientOptions(endpoint), batch: true });
    const answers = await Promise.all([failure(batched.call('getbalance')), failure(batched.call('walletislocked'))]);
    for (const answer of answers) expect(answer).toMatchObject({ code: 'RPC_ERROR', kind: 'rpc', rpcCode: RPC_ERROR_CODES.INVALID_REQUEST });
  });
});
