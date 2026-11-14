// One small wallet history, served as pearld's address index and as Oyster
// report it (backendFixtures in vectors/rpcfixtures_test.go): BIP86 account 0
// of a fixed seed, paid on receive/0 twice and receive/2 by a coinbase, with
// a mempool transaction spending one of those to change/0.

import { OysterClient, PearldClient, deriveSigningAccountFromSeed, networks } from '../src/index.js';
import { expected, fakeFetch, type Route, type SentRequest } from './rpc-helpers.js';
import { hexToBytes } from './vector-helpers.js';

export const network = networks.regtest;
const scenario = (key: string) => expected('backend-search-receive0', key);
export const text = (key: string) => scenario(key) as string;
export const grain = (key: string) => BigInt(text(key));

export const account = deriveSigningAccountFromSeed(hexToBytes(text('seed')), network);
export const receive0 = text('receive0');
export const receive1 = text('receive1');
export const receive2 = text('receive2');
export const change0 = text('change0');
export const txids = { a1: text('a1'), a2: text('a2'), a3: text('a3'), m1: text('m1') };
export const tipHeight = scenario('tip') as number;
export const blockHeights = scenario('blocks') as Record<string, number>;

const byAddress = (prefix: string, none: string) => (request: SentRequest) => {
  const param = request.body.params[0];
  const address = Array.isArray(param) ? (param[0] as string) : (param as string);
  const name = { [receive0]: 'receive0', [receive2]: 'receive2', [change0]: 'change0' }[address];
  return name === undefined ? none : `${prefix}-${name}`;
};

/** A pearld with the address index, answering for the scenario. */
export function indexedPearld(routes: Record<string, Route> = {}) {
  const fake = fakeFetch({
    searchrawtransactions: byAddress('backend-search', 'searchrawtransactions-none'),
    getblockheader: (r) => `backend-header-${tipHeight - blockHeights[r.body.params[0] as string]! + 1}`,
    getblockchaininfo: 'getblockchaininfo',
    getinfo: 'getinfo',
    estimatefee: 'estimatefee',
    sendrawtransaction: 'sendrawtransaction',
    ...routes,
  });
  return { client: new PearldClient({ url: 'https://127.0.0.1:18334', fetch: fake.fetch }), sent: fake.sent };
}

/** An Oyster holding the scenario's wallet. */
export function scenarioOyster(routes: Record<string, Route> = {}) {
  const fake = fakeFetch({
    listunspent: 'backend-listunspent',
    listalltransactions: 'backend-listalltransactions',
    listaddresstransactions: byAddress('backend-listaddresstransactions', 'backend-listaddresstransactions-none'),
    getbestblock: 'backend-getbestblock',
    ...routes,
  });
  return { client: new OysterClient({ url: 'https://127.0.0.1:18332', fetch: fake.fetch }), sent: fake.sent };
}
