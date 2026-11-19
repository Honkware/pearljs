// A fetch for PearldClient and OysterClient that trusts a server's own
// certificate, over node:https with a keep-alive agent. Node's built-in fetch
// takes a CA only through an undici dispatcher, which is not a dependency of
// pearljs, and a new TLS handshake per request is most of the time a client
// spends against a real node.

/**
 * A Node fetch that trusts pearld's or Oyster's self-signed rpc.cert and
 * keeps its connections open between requests. Node only; not re-exported
 * from the main entry.
 *
 * @module
 */

import { Agent, request } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';

/** The certificate pearldFetch trusts, and how it keeps connections. */
export interface PearldFetchOptions {
  /** The server's certificate, PEM: the contents of its rpc.cert. */
  readonly ca: string | Uint8Array;
  /** Keep connections open between requests. Default true. */
  readonly keepAlive?: boolean;
  /** Most connections open to one server at once. Default: no limit beyond the client's own maxConcurrentRequests. */
  readonly maxSockets?: number;
}

/** A fetch with the agent its connections live in. */
export type PearldFetch = typeof globalThis.fetch & {
  /** Closes the open connections. Idle ones do not keep the process alive, so this is for a clean shutdown. */
  close(): void;
};

// Statuses a Response may not carry a body with.
const NO_BODY = new Set([101, 103, 204, 205, 304]);

function responseHeaders(res: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(res.headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  return headers;
}

/**
 * A fetch that trusts `ca` and reuses connections:
 * `new PearldClient({ url, username, password, fetch: pearldFetch({ ca: readFileSync(certPath) }) })`.
 * It sends string and byte bodies, honours the request's signal, never
 * follows a redirect, and streams the reply.
 */
export function pearldFetch(options: PearldFetchOptions): PearldFetch {
  const agent = new Agent({
    ca: typeof options.ca === 'string' ? options.ca : Buffer.from(options.ca),
    keepAlive: options.keepAlive ?? true,
    ...(options.maxSockets === undefined ? {} : { maxSockets: options.maxSockets }),
  });
  const fetch = (input: string | URL | Request, init: RequestInit = {}): Promise<Response> =>
    new Promise<Response>((resolve, reject) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith('https:')) {
        reject(new TypeError(`pearldFetch speaks https only, not ${url.slice(0, url.indexOf(':') + 1)}`));
        return;
      }
      const body = init.body;
      if (body !== undefined && body !== null && typeof body !== 'string' && !(body instanceof Uint8Array)) {
        reject(new TypeError('pearldFetch sends string and Uint8Array bodies only'));
        return;
      }
      const signal = init.signal ?? undefined;
      const req = request(url, {
        agent,
        method: init.method ?? 'GET',
        headers: Object.fromEntries(new Headers(init.headers)),
        ...(signal === undefined ? {} : { signal }),
      }, (res) => {
        const status = res.statusCode ?? 502;
        const stream = NO_BODY.has(status) ? null : (Readable.toWeb(res) as ReadableStream<Uint8Array>);
        if (stream === null) res.resume();
        resolve(new Response(stream, { status, statusText: res.statusMessage ?? '', headers: responseHeaders(res) }));
      });
      req.on('error', reject);
      req.end(body ?? undefined);
    });
  return Object.assign(fetch as typeof globalThis.fetch, { close: () => agent.destroy() });
}
