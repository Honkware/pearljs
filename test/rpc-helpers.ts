// The fake fetch and fixture lookups shared by the RPC, backend and discovery
// tests. Fixtures come from vectors/rpcfixtures_test.go.

import { expect } from 'vitest';
import { PearlRpcError } from '../src/index.js';
import fixtureFile from './fixtures/rpc-responses.json' with { type: 'json' };

export interface Fixture {
  body: string;
  expect?: Record<string, unknown>;
}
export const fixtures = fixtureFile as Record<string, Fixture>;
export const fixture = (name: string): Fixture => {
  const found = fixtures[name];
  if (found === undefined) throw new Error(`missing fixture ${name}`);
  return found;
};
export const expected = (name: string, key: string) => fixture(name).expect![key];

export interface SentRequest {
  url: string;
  init: RequestInit & Record<string, unknown>;
  body: { jsonrpc: string; id: number; method: string; params: unknown[] };
  text: string;
}

export type Route = string | Response | ((request: SentRequest) => string | Response);

/** A fetch that answers each method from a fixture, with the reply id set to the request's. */
export function fakeFetch(routes: Record<string, Route>, from: Record<string, Fixture> = fixtures) {
  const sent: SentRequest[] = [];
  const fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const text = init.body as string;
    const request = { url: String(input), init, body: JSON.parse(text), text } as SentRequest;
    sent.push(request);
    const route = routes[request.body.method];
    if (route === undefined) throw new Error(`unexpected method ${request.body.method}`);
    const answer = typeof route === 'function' ? route(request) : route;
    if (answer instanceof Response) return answer;
    const found = from[answer];
    if (found === undefined) throw new Error(`missing fixture ${answer}`);
    const body = found.body.replace(/"id":\d+}\n$/, `"id":${request.body.id}}\n`);
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { fetch: fetch as typeof globalThis.fetch, sent };
}

export async function rejection(promise: Promise<unknown>): Promise<PearlRpcError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(PearlRpcError);
    return err as PearlRpcError;
  }
  throw new Error('expected the call to fail');
}

