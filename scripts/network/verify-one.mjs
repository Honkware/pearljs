// verifyBlockProof on one raw block, in a worker thread of its own: a
// verifier that overflows its stack is left in a state no later
// verification can trust, so each block gets a fresh one.
//
//   node scripts/network/verify-one.mjs <height>...   prints one JSON line per block
import { Buffer } from 'node:buffer';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { parseBlock } from 'pearljs';
import { verifyBlockProof } from 'pearljs/verify-proof';

export function verifyInWorker(hex, stackSizeMb) {
  return new Promise((resolve) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: hex, ...(stackSizeMb === undefined ? {} : { resourceLimits: { stackSizeMb } }) });
    worker.once('message', resolve);
    worker.once('error', (error) => resolve({ valid: false, outcome: 'threw', message: `${error.constructor.name}: ${error.message}` }));
  });
}

if (!isMainThread) {
  const block = parseBlock(Buffer.from(workerData, 'hex'));
  try {
    parentPort.postMessage(await verifyBlockProof(block));
  } catch (error) {
    parentPort.postMessage({ valid: false, outcome: 'threw', message: `${error.constructor.name}: ${error.message}` });
  }
} else if (process.argv[1]?.endsWith('verify-one.mjs')) {
  const { client } = await import('./node.mjs');
  const rpc = client();
  const stack = process.env.PEARL_VERIFY_STACK_MB === undefined ? undefined : Number(process.env.PEARL_VERIFY_STACK_MB);
  for (const height of process.argv.slice(2).map(Number)) {
    const hex = await rpc.call('getblock', [await rpc.getBlockHash(height), 0]);
    const started = Date.now();
    const verdict = await verifyInWorker(hex, stack);
    console.log(JSON.stringify({ height, version: parseBlock(Buffer.from(hex, 'hex')).certificate?.version, ms: Date.now() - started, ...verdict }));
  }
}
