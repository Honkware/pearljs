/**
 * Print blocks as pearld connects and disconnects them, over its websocket.
 *
 * Needs a running pearld. Settings come from the environment (see
 * lib/env.ts). Stops after WATCH_BLOCKS blocks (default 3) or on Ctrl-C.
 *
 *   npm run build && npx tsc -p tsconfig.examples.json
 *   node dist-examples/examples/watch-blocks.js
 */
import { WebSocket } from 'undici';
import { PearlWsClient } from 'pearljs';
import { dispatcher, pearld } from './lib/env.js';

const agent = dispatcher();
const ws = new PearlWsClient({
  ...pearld(), // an https:// URL becomes wss:// and gets the /ws path
  // Node 20 has no global WebSocket, and Node's own takes no dispatcher.
  WebSocket,
  ...(agent === undefined ? {} : { webSocketInit: { dispatcher: agent } }),
});

ws.on('connect', ({ reconnect }) => console.log(reconnect ? 'reconnected' : 'connected'));
ws.on('disconnect', ({ error }) => console.log('disconnected:', error.message));
ws.on('error', (error) => console.error('error:', error.message));
process.once('SIGINT', () => void ws.close());

console.log('tip', await ws.getBlockCount());

let left = Number(process.env.WATCH_BLOCKS ?? 3);
for await (const block of ws.blocks()) {
  console.log(block.type, block.height, block.hash, new Date(block.time * 1000).toISOString());
  if (block.type === 'connected' && (left -= 1) <= 0) break;
}

await ws.close();
await agent?.close();
