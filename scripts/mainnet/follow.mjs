// Follows mainnet with followChain and a PearlWsClient block subscription for
// a while, then checks the follower's chain against the node's best chain.
// Records every reorg, reconnect and notification the two disagree on.
//
//   PEARL_RPC_INFLIGHT=1 scripts/mainnet/run.sh follow.mjs [--minutes 130]
//
// Over the websocket only authenticate and notifyblocks are sent.
/* global AbortController */
import { appendFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { Agent, WebSocket } from 'undici';
import { RPC_URL, RPC_CERT, RPC_USER, OUT, gatedFetch, password, rpc, closeRpc, writeJson, rpcStats } from './lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { PearldClient } = await import(join(root, 'dist', 'rpc.js'));
const { PearlWsClient } = await import(join(root, 'dist', 'ws.js'));
const { followChain } = await import(join(root, 'dist', 'follow.js'));
const { checkMerkleRoot, checkCertificateBinding } = await import(join(root, 'dist', 'block.js'));
const { checkCertificateRules } = await import(join(root, 'dist', 'consensus.js'));
const { mainnet } = await import(join(root, 'dist', 'networks.js'));

const minutesAt = process.argv.indexOf('--minutes');
const MINUTES = minutesAt > 0 ? Number(process.argv[minutesAt + 1]) : 130;
const LOG = join(OUT, 'follow.jsonl');
const now = () => new Date().toISOString();
const record = (event) => appendFileSync(LOG, `${JSON.stringify({ at: now(), ...event })}\n`);

const client = new PearldClient({ url: RPC_URL, username: RPC_USER, password: password(), fetch: gatedFetch, maxConcurrentRequests: 1 });
const ws = new PearlWsClient({
  url: RPC_URL,
  username: RPC_USER,
  password: password(),
  WebSocket,
  webSocketInit: { dispatcher: new Agent({ connect: { ca: readFileSync(RPC_CERT, 'utf8') } }) },
});
const summary = { started: now(), minutes: MINUTES, connected: 0, disconnected: 0, synced: 0, notifications: 0, wsConnects: 0, wsReconnects: 0, wsDisconnects: 0, wsErrors: [], blockCheckFailures: [] };
ws.on('connect', ({ reconnect }) => {
  summary.wsConnects += 1;
  if (reconnect) summary.wsReconnects += 1;
  record({ type: 'ws-connect', reconnect });
});
ws.on('disconnect', ({ error }) => {
  summary.wsDisconnects += 1;
  record({ type: 'ws-disconnect', error: error?.message });
});
const notified = new Map();
const stopWatching = ws.watchBlocks({
  onBlock: (event) => {
    summary.notifications += 1;
    notified.set(event.hash, { height: event.height, at: Date.now() });
    record({ type: 'notification', height: event.height, hash: event.hash });
  },
  onError: (error) => {
    summary.wsErrors.push(error.message);
    record({ type: 'ws-error', error: error.message });
  },
});

const controller = new AbortController();
setTimeout(() => controller.abort(), MINUTES * 60_000);
const start = (await rpc('getblockcount')) - 3;
const chain = new Map();
const connectedAt = new Map();
const follower = followChain(client, {
  from: { height: start },
  ws,
  signal: controller.signal,
  onRetry: (error, attempt) => record({ type: 'retry', attempt, error: error.message }),
});
for await (const event of follower) {
  if (event.type === 'connected') {
    summary.connected += 1;
    chain.set(event.height, event.hash);
    connectedAt.set(event.hash, Date.now());
    try {
      checkMerkleRoot(event.block);
      checkCertificateBinding(event.block);
      checkCertificateRules(event.block.certificate, mainnet, event.height);
    } catch (error) {
      summary.blockCheckFailures.push([event.height, error.message]);
    }
    record({ type: 'connected', height: event.height, hash: event.hash });
  } else if (event.type === 'disconnected') {
    summary.disconnected += 1;
    chain.delete(event.height);
    record({ type: 'disconnected', height: event.height, hash: event.hash });
  } else {
    summary.synced += 1;
    record({ type: 'synced', height: event.height, hash: event.hash });
  }
}
stopWatching();

// The follower's chain against the node's: every block it holds must be the
// node's block at that height, unless the node has moved on past a reorg.
const best = await rpc('getbestblockhash');
const bestHeader = await rpc('getblockheader', best, true);
const heights = [...chain.keys()].sort((a, b) => a - b);
const mismatches = [];
for (const height of heights) {
  if (height > bestHeader.height) continue;
  const node = await rpc('getblockhash', height);
  if (node !== chain.get(height)) mismatches.push({ height, follower: chain.get(height), node });
}
const live = heights.filter((h) => h > start + 3);
const missed = live.map((h) => chain.get(h)).filter((hash) => !notified.has(hash));
const extra = [...notified.keys()].filter((hash) => ![...chain.values()].includes(hash));
const lag = live.map((h) => chain.get(h)).filter((hash) => notified.has(hash)).map((hash) => connectedAt.get(hash) - notified.get(hash).at).sort((a, b) => a - b);
Object.assign(summary, {
  ended: now(),
  startHeight: start,
  followerTip: heights.at(-1),
  nodeTip: bestHeader.height,
  liveBlocks: live.length,
  ancestryMismatches: mismatches,
  missedNotifications: missed,
  notificationsWithoutBlock: extra,
  notifyToConnectMs: lag.length ? { min: lag[0], p50: lag[Math.floor(lag.length / 2)], max: lag.at(-1) } : null,
  rpcRequests: rpcStats.requests,
});
writeJson(join(OUT, 'follow-summary.json'), summary);
console.log(JSON.stringify(summary, null, 1));
await ws.close();
closeRpc();
