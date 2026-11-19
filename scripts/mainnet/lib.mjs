// Shared plumbing for the mainnet checks: a read-only JSON-RPC client for the
// local pearld that never has more than two requests in flight, refuses any
// method outside a read-only list, and backs off on HTTP 503; and a counting
// Blockbook client with a hard request cap.

/* global Response */
import { Agent, request } from 'node:https';
import { Buffer } from 'node:buffer';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

export const WORK = join(homedir(), 'pearl-work');
export const OUT = process.env.PEARL_WALK_DIR ?? join(WORK, 'mainnet-walk');
export const RPC_URL = process.env.PEARLD_URL ?? 'https://127.0.0.1:44107';
export const RPC_CERT = process.env.PEARLD_CERT ?? join(WORK, 'mainnet', 'rpc.cert');
export const RPC_USER = 'dashboard';

mkdirSync(OUT, { recursive: true });

// Methods that read. Anything else is refused before it leaves the process.
export const READ_ONLY = new Set([
  'getinfo', 'getblockcount', 'getblockhash', 'getblock', 'getblockheader', 'getbestblockhash', 'getbestblock',
  'getrawtransaction', 'searchrawtransactions', 'getcfilter', 'getcfilterheader', 'estimatefee', 'getchaintips',
  'getdifficulty', 'gettxout', 'getrawmempool', 'getcurrentnet', 'version', 'uptime', 'validateaddress',
  'decoderawtransaction', 'decodescript', 'getnettotals', 'getnetworkhashps', 'help', 'getheaders',
]);

export function password() {
  const value = process.env.PEARLD_PASS;
  if (!value) throw new Error('PEARLD_PASS is not set; source ~/pearl-work/mainnet/secrets.env first');
  return value;
}

class Gate {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.waiting = [];
  }
  async run(fn) {
    while (this.active >= this.limit) await new Promise((resolve) => this.waiting.push(resolve));
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

// Two in flight at most across everything that runs at once: the walk keeps
// one, so a script beside it runs with PEARL_RPC_INFLIGHT=1.
const rpcGate = new Gate(Number(process.env.PEARL_RPC_INFLIGHT ?? 2));

// The same limit across processes: a request holds one of PEARL_RPC_SLOTS
// (default 2) lock directories while it is in flight. PEARL_RPC_SLOT_FIRST
// keeps a process off the lower slots, so a long job on slot 0 and a
// follower on slot 1 never wait for each other.
const SLOTS = Number(process.env.PEARL_RPC_SLOTS ?? 2);
const FIRST_SLOT = Number(process.env.PEARL_RPC_SLOT_FIRST ?? 0);
const LOCKS = join(WORK, 'mainnet-walk', 'rpc-slots');
mkdirSync(LOCKS, { recursive: true });

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function withSlot(fn) {
  for (;;) {
    for (let i = FIRST_SLOT; i < SLOTS; i++) {
      const dir = join(LOCKS, `slot-${i}`);
      try {
        mkdirSync(dir);
      } catch {
        let pid = 0;
        try {
          pid = Number(readFileSync(join(dir, 'pid'), 'utf8'));
        } catch {
          continue;
        }
        if (pid !== 0 && !alive(pid)) rmSync(dir, { recursive: true, force: true });
        continue;
      }
      writeFileSync(join(dir, 'pid'), String(process.pid));
      try {
        return await fn();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    await sleep(15);
  }
}
const agent = new Agent({ ca: readFileSync(RPC_CERT), keepAlive: true, maxSockets: 2 });
export const rpcStats = { requests: 0, calls: 0, bytes: 0, retries503: 0 };

function post(body) {
  return new Promise((resolve, reject) => {
    const req = request(RPC_URL, {
      agent,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Basic ${Buffer.from(`${RPC_USER}:${password()}`).toString('base64')}`,
      },
      timeout: 300_000,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('RPC timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

let nextId = 1;

/** Sends calls as one JSON-RPC batch (or one call) and returns their results in order. Throws on any error. */
export async function rpcBatch(calls) {
  for (const [method] of calls) {
    if (!READ_ONLY.has(method)) throw new Error(`refusing ${method}: not a read-only method`);
  }
  const payload = calls.map(([method, params = []]) => ({ jsonrpc: '1.0', id: nextId++, method, params }));
  const body = JSON.stringify(payload.length === 1 ? payload[0] : payload);
  return rpcGate.run(async () => {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await withSlot(() => post(body));
      } catch (error) {
        if (attempt < 20 && /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|timed out/.test(String(error))) {
          await sleep(1000 * 2 ** Math.min(attempt, 5));
          continue;
        }
        throw error;
      }
      rpcStats.requests += 1;
      if (res.status === 503 && attempt < 12) {
        rpcStats.retries503 += 1;
        await sleep(250 * 2 ** Math.min(attempt, 6));
        continue;
      }
      rpcStats.bytes += res.body.length;
      let parsed;
      try {
        parsed = JSON.parse(res.body.toString('utf8'));
      } catch {
        throw new Error(`HTTP ${res.status}: ${res.body.toString('utf8').slice(0, 200)}`);
      }
      const list = Array.isArray(parsed) ? parsed : [parsed];
      const byId = new Map(list.map((item) => [item.id, item]));
      rpcStats.calls += calls.length;
      return payload.map((p) => {
        const item = byId.get(p.id);
        if (!item) throw new Error(`no reply for ${p.method}`);
        if (item.error) {
          const err = new Error(`${p.method}: ${item.error.message} (${item.error.code})`);
          err.rpcCode = item.error.code;
          throw err;
        }
        return item.result;
      });
    }
  });
}

export async function rpc(method, ...params) {
  return (await rpcBatch([[method, params]]))[0];
}

/**
 * A transport for PearldClient that goes through the same gate and allowlist.
 * The rpc.ts HttpTransport options take a fetch, so this is a fetch.
 */
export async function gatedFetch(_url, init) {
  const parsed = JSON.parse(init.body);
  const list = Array.isArray(parsed) ? parsed : [parsed];
  for (const call of list) {
    if (!READ_ONLY.has(call.method)) throw new Error(`refusing ${call.method}: not a read-only method`);
  }
  return rpcGate.run(async () => {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await withSlot(() => post(init.body));
      } catch (error) {
        // The node sometimes stops accepting connections for a while under the dashboard's indexer.
        if (attempt < 20 && /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|timed out/.test(String(error))) {
          await sleep(1000 * 2 ** Math.min(attempt, 5));
          continue;
        }
        throw error;
      }
      rpcStats.requests += 1;
      if (res.status === 503 && attempt < 12) {
        rpcStats.retries503 += 1;
        await sleep(250 * 2 ** Math.min(attempt, 6));
        continue;
      }
      rpcStats.bytes += res.body.length;
      return new Response(res.body, { status: res.status, headers: { 'content-type': 'application/json' } });
    }
  });
}

export function closeRpc() {
  agent.destroy();
}

// Blockbook: hard cap across every script, kept in a counter file.
const BLOCKBOOK = 'https://blockbook.pearlresearch.ai';
const BB_CAP = 300;
// The cap is counted in one place whatever PEARL_WALK_DIR says.
const BB_COUNT = join(WORK, 'mainnet-walk', 'blockbook-requests.json');
const bbGate = new Gate(2);

function bbUsed() {
  return existsSync(BB_COUNT) ? JSON.parse(readFileSync(BB_COUNT, 'utf8')).used : 0;
}

/** fetch for blockbook.pearlresearch.ai only, counted against the cap, at most two in flight. */
export async function blockbookFetch(input, init) {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith(`${BLOCKBOOK}/`)) throw new Error(`refusing ${url}: not the mainnet Blockbook`);
  if ((init?.method ?? 'GET') !== 'GET') throw new Error('refusing a non-GET Blockbook request');
  return bbGate.run(async () => {
    const used = bbUsed();
    if (used >= BB_CAP) throw new Error(`Blockbook request cap of ${BB_CAP} reached`);
    writeFileSync(BB_COUNT, JSON.stringify({ used: used + 1 }));
    appendFileSync(join(WORK, 'mainnet-walk', 'blockbook-requests.log'), `${new Date().toISOString()} ${url}\n`);
    return fetch(url, init);
  });
}
export const blockbookUsed = bbUsed;
export const BLOCKBOOK_URL = BLOCKBOOK;

export function readJson(path, fallback) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
}

export function writeJson(path, value) {
  writeFileSync(`${path}.tmp`, JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 1));
  renameSync(`${path}.tmp`, path);
}

export const hex = (bytes) => Buffer.from(bytes).toString('hex');
export const fromHex = (text) => new Uint8Array(Buffer.from(text, 'hex'));
