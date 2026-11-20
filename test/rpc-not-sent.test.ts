// A call is sent again as never-sent only when the transport says no attempt
// carried it. Audit 5, finding 1: fallbackTransport surfaced the second
// server's connect timeout after the first had received the send.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OysterClient, PearldClient, PearlRpcError, fallbackTransport, httpTransport, type RpcTransport } from '../src/index.js';
import { fixture, rejection } from './rpc-helpers.js';

const realFetch = globalThis.fetch;
const connectTimeout = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) });

// A server that reads each request in full and then drops the connection without answering.
async function swallowing(): Promise<{ url: string; received: () => number; close: () => Promise<void> }> {
  let received = 0;
  const server = http.createServer((req) => {
    req.on('data', () => {});
    req.on('end', () => {
      received++;
      req.socket.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, received: () => received, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

const reply = (name: string, init: RequestInit) => {
  const { id } = JSON.parse(init.body as string) as { id: number };
  return new Response(fixture(name).body.replace(/"id":\d+}/, `"id":${id}}`));
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sending again after a connection that never opened', () => {
  it('sends a payment once when the first fallback server took it and the next one timed out connecting', async () => {
    const a = await swallowing();
    try {
      const transport = fallbackTransport([
        httpTransport({ url: a.url, username: 'u', password: 'p' }),
        httpTransport({ url: 'http://127.0.0.1:9', username: 'u', password: 'p', fetch: (async () => { throw connectTimeout(); }) as typeof fetch }),
      ]);
      const err = await rejection(new OysterClient({ transport }).sendToAddress('prl1qexample', 1000n, 1000n));
      expect(err.kind).toBe('network');
      expect(err.notSent).toBe(false);
      expect(a.received()).toBe(1);

      // The same with the second server on the default fetch, whose connect timeout is certain to have carried nothing.
      vi.stubGlobal('fetch', (async (url: string, init: RequestInit) => (url.startsWith(a.url) ? realFetch(url, init) : Promise.reject(connectTimeout()))) as typeof fetch);
      const both = fallbackTransport([
        httpTransport({ url: a.url, username: 'u', password: 'p' }),
        httpTransport({ url: 'http://127.0.0.1:9', username: 'u', password: 'p' }),
      ]);
      await rejection(new OysterClient({ transport: both, retry: 3 }).sendToAddress('prl1qexample', 1000n, 1000n));
      expect(a.received()).toBe(2);
    } finally {
      await a.close();
    }
  });

  it('sends again when every fallback server timed out connecting', async () => {
    let attempts = 0;
    vi.stubGlobal('fetch', (async (_url: string, init: RequestInit) => (++attempts <= 4 ? Promise.reject(connectTimeout()) : reply('sendrawtransaction', init))) as typeof fetch);
    const transport = fallbackTransport([httpTransport({ url: 'http://127.0.0.1:1' }), httpTransport({ url: 'http://127.0.0.1:2' })]);
    await new PearldClient({ transport }).sendRawTransaction('00');
    expect(attempts).toBe(5);
  });

  it('sends again after the default fetch timed out connecting, and not after a custom fetch did', async () => {
    let attempts = 0;
    const failing = (async (_url: string, init: RequestInit) => (++attempts < 3 ? Promise.reject(connectTimeout()) : reply('sendrawtransaction', init))) as typeof fetch;
    const url = 'https://127.0.0.1:18334';

    vi.stubGlobal('fetch', failing);
    await new PearldClient({ url }).sendRawTransaction('00');
    expect(attempts).toBe(3);

    attempts = 0;
    const err = await rejection(new PearldClient({ url, fetch: failing, retry: 5 }).sendRawTransaction('00'));
    expect(err.notSent).toBe(false);
    expect(attempts).toBe(1);

    // A read is still retried after any connect timeout.
    attempts = 0;
    const reads = (async (_url: string, init: RequestInit) => (++attempts < 3 ? Promise.reject(connectTimeout()) : reply('getblockcount', init))) as typeof fetch;
    expect(await new PearldClient({ url, fetch: reads }).getBlockCount()).toBe(321);
    expect(attempts).toBe(3);
  });

  it('sends again after a custom transport says the request was not sent, and not otherwise', async () => {
    for (const notSent of [true, false]) {
      let attempts = 0;
      const transport: RpcTransport = {
        origin: 'mock',
        async send(_body, request) {
          if (++attempts < 3) throw new PearlRpcError('network', request.method, 'connect timed out', { cause: connectTimeout().cause, notSent });
          return fixture('sendrawtransaction').body.replace(/"id":\d+}/, '"id":1}');
        },
      };
      const sent = new PearldClient({ transport }).sendRawTransaction('00');
      if (notSent) await sent;
      else await rejection(sent);
      expect(attempts).toBe(notSent ? 3 : 1);
    }
  });

  it('retries a batch of sends whole only when its connection never opened', async () => {
    let attempts = 0;
    const batchReply = (init: RequestInit) => {
      const calls = JSON.parse(init.body as string) as { id: number }[];
      const one = JSON.parse(fixture('sendrawtransaction').body) as Record<string, unknown>;
      return new Response(JSON.stringify(calls.map(({ id }) => ({ ...one, id }))));
    };
    const failing = (async (_url: string, init: RequestInit) => (++attempts < 2 ? Promise.reject(connectTimeout()) : batchReply(init))) as typeof fetch;
    const url = 'https://127.0.0.1:18334';

    vi.stubGlobal('fetch', failing);
    const client = new PearldClient({ url, batch: true });
    await Promise.all([client.sendRawTransaction('00'), client.sendRawTransaction('01')]);
    expect(attempts).toBe(2);

    attempts = 0;
    const custom = new PearldClient({ url, batch: true, fetch: failing });
    const failed = await Promise.allSettled([custom.sendRawTransaction('00'), custom.sendRawTransaction('01')]);
    expect(failed.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(attempts).toBe(1);
  });

  it('does not send again when the caller aborted during the connect', async () => {
    let attempts = 0;
    const controller = new AbortController();
    vi.stubGlobal('fetch', (async (_url: string, init: RequestInit) => {
      attempts++;
      return new Promise<Response>((_, reject) => {
        init.signal!.addEventListener('abort', () => reject(connectTimeout()), { once: true });
        controller.abort();
      });
    }) as typeof fetch);
    await rejection(new PearldClient({ url: 'https://127.0.0.1:18334', retry: 3 }).call('sendrawtransaction', ['00'], { signal: controller.signal }));
    expect(attempts).toBe(1);
  });
});
