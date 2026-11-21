// Follows the testnet2 node with followChain from block 1 and checks every
// block it hands over the way pearljs would before trusting it: the block
// parses, its merkle root and witness commitment hold, its certificate binds
// the header and has the version and kind checkCertificateRules wants at that
// height. Every 500th block and the 20 blocks around the FP8 fork also go
// through verifyBlockProof, each in a fresh worker (verify-one.mjs), and their raw bytes through parseBlock and back.
// The node accepted every block it hands over, so any failure here is a
// disagreement between pearljs and pearld.
//
// It keeps following once caught up and records every disconnected block, so
// a run over a whole session is also the record of natural reorgs. Progress
// is kept in <dir>/check/state.json and resumed from there; findings go to
// <dir>/check/events.jsonl, one JSON object per line.
//
//   node scripts/network/check-chain.mjs [--once]
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import {
  checkCertificateBinding,
  checkCertificateRules,
  checkMerkleRoot,
  checkWitnessCommitment,
  followChain,
  parseBlock,
  serializeBlock,
  testnet2,
} from 'pearljs';
import { client, nodeDir } from './node.mjs';
import { verifyInWorker } from './verify-one.mjs';

const dir = join(nodeDir, 'check');
mkdirSync(dir, { recursive: true });
const stateFile = join(dir, 'state.json');
const eventsFile = join(dir, 'events.jsonl');
const once = process.argv.includes('--once');
const fork = testnet2.forkHeights.fp8;
const sampled = (height) => height % 500 === 0 || (height >= fork - 10 && height < fork + 10);

const state = existsSync(stateFile)
  ? JSON.parse(readFileSync(stateFile, 'utf8'))
  : { cursor: null, checked: 0, failures: 0, proofs: { accepted: 0, rejected: 0, error: 0 }, versions: {}, disconnected: 0, started: Date.now() };
const record = (event) => appendFileSync(eventsFile, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
const save = (cursor) => writeFileSync(stateFile, JSON.stringify({ ...state, cursor, saved: Date.now() }, null, 1));

const rpc = client({ maxConcurrentRequests: 2 });
const controller = new globalThis.AbortController();
process.on('SIGTERM', () => controller.abort());
process.on('SIGINT', () => controller.abort());

function check(name, height, hash, fn) {
  try {
    fn();
    return true;
  } catch (error) {
    state.failures++;
    record({ kind: 'failure', check: name, height, hash, code: error.code, message: error.message });
    return false;
  }
}

const follower = followChain(rpc, {
  from: state.cursor === null ? { height: 1 } : { cursor: state.cursor },
  depth: 1000,
  pollInterval: 10_000,
  signal: controller.signal,
  stopAtTip: once,
  onRetry: (error, attempt) => record({ kind: 'retry', attempt, message: error.message }),
});

let lastSave = Date.now();
for await (const event of follower) {
  if (event.type === 'disconnected') {
    state.disconnected++;
    record({ kind: 'disconnected', height: event.height, hash: event.hash });
    save(follower.cursor());
    continue;
  }
  if (event.type === 'synced') {
    record({ kind: 'synced', height: event.height, hash: event.hash, checked: state.checked, failures: state.failures });
    save(follower.cursor());
    continue;
  }
  const { block, height, hash } = event;
  const version = block.certificate?.version ?? 'none';
  state.versions[version] = (state.versions[version] ?? 0) + 1;
  check('merkle root', height, hash, () => checkMerkleRoot(block));
  check('witness commitment', height, hash, () => checkWitnessCommitment(block));
  check('certificate binding', height, hash, () => checkCertificateBinding(block));
  check('certificate rules', height, hash, () => checkCertificateRules(block.certificate, testnet2, height));
  if (sampled(height)) {
    const hex = await rpc.call('getblock', [hash, 0]);
    check('round trip', height, hash, () => {
      if (Buffer.from(serializeBlock(parseBlock(Buffer.from(hex, 'hex')))).toString('hex') !== hex) throw new Error('serializeBlock(parseBlock(raw)) differs from raw');
    });
    // V1 proofs go through pearld's own V1 verifier, which verify-proof does not carry.
    if (version !== 1) {
      const started = Date.now();
      const verdict = await verifyInWorker(hex);
      state.proofs[verdict.outcome] = (state.proofs[verdict.outcome] ?? 0) + 1;
      record({ kind: 'proof', height, hash, version, ms: Date.now() - started, ...verdict });
    }
  }
  state.checked++;
  if (Date.now() - lastSave > 30_000) {
    save(follower.cursor());
    lastSave = Date.now();
  }
}
save(follower.cursor());
console.log(JSON.stringify({ ...state, cursor: follower.cursor()?.height }, null, 1));
