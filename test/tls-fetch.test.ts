// pearldFetch against a local TLS server with a throwaway certificate, as
// pearld serves its RPC: it trusts that certificate and no other, reuses one
// connection across sequential calls, opens no more than the client keeps in
// flight, stops on the caller's signal and streams a reply the client may cut
// short.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:https';
import type { Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PearldClient } from '../src/index.js';
import { pearldFetch } from '../src/tls-fetch.js';

const work = mkdtempSync(join(tmpdir(), 'pearljs-tls-fetch-'));

// Made by the machine's openssl; without it these tests are skipped.
function makePair(name: string): { cert: string; key: string } | null {
  if (process.platform === 'win32') return null;
  const [key, cert] = [join(work, `${name}.key`), join(work, `${name}.cert`)];
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', key, '-out', cert], { stdio: 'ignore' });
    return { cert: readFileSync(cert, 'utf8'), key: readFileSync(key, 'utf8') };
  } catch {
    return null;
  }
}
const pair = makePair('server');
const other = makePair('other');

describe.skipIf(pair === null || other === null)('pearldFetch', () => {
  let server: Server;
  let url = '';
  let connections = 0;
  let delay = 0;
  let replyBytes = 0;

  beforeAll(async () => {
    server = createServer({ cert: pair!.cert, key: pair!.key }, (req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        const { id } = JSON.parse(body) as { id: number };
        setTimeout(() => {
          res.setHeader('Content-Type', 'application/json');
          if (replyBytes > 0) res.end(`{"result":"${'a'.repeat(replyBytes)}","error":null,"id":${id}}`);
          else res.end(`{"result":321,"error":null,"id":${id}}\n`);
        }, delay);
      });
    });
    server.on('secureConnection', () => connections++);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    url = `https://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(work, { recursive: true, force: true });
  });

  const reset = (): void => {
    connections = 0;
    delay = 0;
    replyBytes = 0;
  };

  it('reuses one connection for calls made one after another', async () => {
    reset();
    const fetch = pearldFetch({ ca: pair!.cert });
    const client = new PearldClient({ url, username: 'u', password: 'p', fetch });
    for (let i = 0; i < 10; i++) expect(await client.getBlockCount()).toBe(321);
    expect(connections).toBe(1);
    fetch.close();
  });

  it('opens a connection per call when keep-alive is off', async () => {
    reset();
    const fetch = pearldFetch({ ca: Buffer.from(pair!.cert), keepAlive: false });
    const client = new PearldClient({ url, username: 'u', password: 'p', fetch });
    for (let i = 0; i < 5; i++) await client.getBlockCount();
    expect(connections).toBe(5);
    fetch.close();
  });

  it('opens no more connections than the client keeps in flight', async () => {
    reset();
    delay = 20;
    const fetch = pearldFetch({ ca: pair!.cert });
    const client = new PearldClient({ url, username: 'u', password: 'p', fetch });
    await Promise.all(Array.from({ length: 12 }, () => client.getBlockCount()));
    expect(connections).toBe(4);
    await Promise.all(Array.from({ length: 12 }, () => client.getBlockCount()));
    expect(connections).toBe(4);
    fetch.close();
  });

  it('trusts the certificate it was given and no other', async () => {
    reset();
    const fetch = pearldFetch({ ca: other!.cert });
    await expect(new PearldClient({ url, fetch }).getBlockCount()).rejects.toMatchObject({ code: 'RPC_NETWORK' });
    await expect(new PearldClient({ url, fetch: pearldFetch({ ca: pair!.cert }) }).getBlockCount()).resolves.toBe(321);
    fetch.close();
  });

  it('stops on a timeout or the caller\'s signal', async () => {
    reset();
    delay = 2000;
    const fetch = pearldFetch({ ca: pair!.cert });
    const client = new PearldClient({ url, fetch });
    await expect(client.call('getblockcount', [], { timeout: 50 })).rejects.toMatchObject({ code: 'RPC_NETWORK', message: expect.stringContaining('within 50 ms') });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await expect(client.call('getblockcount', [], { signal: controller.signal })).rejects.toMatchObject({ code: 'RPC_NETWORK' });
    fetch.close();
  });

  it('streams the reply, so the client stops reading at maxReplySize', async () => {
    reset();
    replyBytes = 200_000;
    const fetch = pearldFetch({ ca: pair!.cert });
    await expect(new PearldClient({ url, fetch, maxReplySize: 1000 }).getBlockCount()).rejects.toMatchObject({ kind: 'response' });
    expect(typeof (await new PearldClient({ url, fetch }).call('getblockcount'))).toBe('string');
    fetch.close();
  });

  it('refuses plain http and bodies it cannot send', async () => {
    const fetch = pearldFetch({ ca: pair!.cert });
    await expect(fetch('http://127.0.0.1:1/')).rejects.toThrow('https only');
    await expect(fetch(url, { method: 'POST', body: new Blob(['x']) })).rejects.toThrow('string and Uint8Array');
    fetch.close();
  });
});
