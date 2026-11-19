// Runs pearljs/verify-proof over mainnet blocks: every 200th block, 50 on each
// side of the V1 to V2 and V2 to V3 forks, and the latest 200. Every block
// was accepted by the network, so every proof must verify.
//
//   PEARL_RPC_INFLIGHT=1 scripts/mainnet/run.sh proofs.mjs [--label NAME]
//
// Blocks are verified in child processes of PEARL_PROOF_CHUNK blocks each
// (default 100), so one verifier instance never sees more than that many
// proofs: its memory grows with every proof. PEARL_VERIFIER_WASM names another
// verifier.wasm to load in place of the shipped one, to try a rebuilt module.
import { appendFileSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fork } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { rpc, rpcBatch, closeRpc, OUT, writeJson, fromHex } from './lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHUNK = Number(process.env.PEARL_PROOF_CHUNK ?? 100);
const labelAt = process.argv.indexOf('--label');
const label = labelAt > 0 ? process.argv[labelAt + 1] : 'shipped';
const LOG = join(OUT, `proofs-${label}.jsonl`);

async function child(heights) {
  const { parseBlock } = await import(join(root, 'dist', 'block.js'));
  const { verifyBlockProof, loadProofVerifier } = await import(join(root, 'dist', 'verify-proof.js'));
  const wasm = process.env.PEARL_VERIFIER_WASM;
  const shipped = (asset) => pathToFileURL(join(root, 'dist', 'verify-proof', asset));
  await loadProofVerifier([2, 3], { locate: (asset) => (asset === 'verifier.wasm' && wasm ? pathToFileURL(wasm) : shipped(asset)) });
  for (let i = 0; i < heights.length; i += 10) {
    const chunk = heights.slice(i, i + 10);
    const hashes = await rpcBatch(chunk.map((h) => ['getblockhash', [h]]));
    const raws = await rpcBatch(hashes.map((h) => ['getblock', [h, 0]]));
    for (const [j, raw] of raws.entries()) {
      const block = parseBlock(fromHex(raw));
      const start = performance.now();
      let verdict;
      try {
        verdict = await verifyBlockProof(block);
      } catch (error) {
        // verifyBlockProof promises a verdict; a throw is a finding of its own.
        verdict = { outcome: `throws ${error.constructor.name}`, message: String(error.message) };
      }
      const ms = performance.now() - start;
      const row = { height: chunk[j], version: block.certificate.version, outcome: verdict.outcome, ms: Math.round(ms), message: verdict.message.slice(0, 200), rssMb: Math.round(process.memoryUsage().rss / 1e6) };
      appendFileSync(LOG, `${JSON.stringify(row)}\n`);
    }
  }
  closeRpc();
}

async function parent() {
  const { mainnet } = await import(join(root, 'dist', 'networks.js'));
  const tip = await rpc('getblockcount');
  closeRpc();
  const heights = new Set();
  for (let h = 200; h <= tip; h += 200) heights.add(h);
  for (const forkHeight of [mainnet.forkHeights.moe, mainnet.forkHeights.saltedSeed]) {
    for (let h = forkHeight - 50; h <= forkHeight + 50; h++) heights.add(h);
  }
  for (let h = tip - 199; h <= tip; h++) heights.add(h);
  const list = [...heights].sort((a, b) => a - b);
  writeFileSync(LOG, '');
  const t0 = performance.now();
  for (let i = 0; i < list.length; i += CHUNK) {
    await new Promise((resolve, reject) => {
      const proc = fork(fileURLToPath(import.meta.url), ['--label', label, '--child', ...list.slice(i, i + CHUNK).map(String)], { stdio: 'inherit' });
      proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`child exited ${code}`))));
    });
    console.log(`${Math.min(i + CHUNK, list.length)}/${list.length}`);
  }
  const rows = readFileSync(LOG, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const groups = {};
  for (const r of rows) (groups[`v${r.version} ${r.outcome}`] ??= []).push(r.ms);
  const pct = (xs, p) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))];
  const report = { label, tip, blocks: rows.length, chunk: CHUNK, seconds: Math.round((performance.now() - t0) / 1000), groups: {} };
  for (const [key, ms] of Object.entries(groups)) {
    ms.sort((a, b) => a - b);
    report.groups[key] = { count: ms.length, min: ms[0], p50: pct(ms, 0.5), p90: pct(ms, 0.9), p99: pct(ms, 0.99), max: ms.at(-1) };
  }
  report.notAccepted = rows.filter((r) => r.outcome !== 'accepted' && r.version !== 1).map((r) => [r.height, r.outcome, r.message.slice(0, 60)]);
  report.v1 = [...new Set(rows.filter((r) => r.version === 1).map((r) => `${r.outcome}: ${r.message}`))];
  writeJson(join(OUT, `proofs-${label}-summary.json`), report);
  console.log(JSON.stringify({ ...report, notAccepted: report.notAccepted.length }, null, 1));
}

const childAt = process.argv.indexOf('--child');
if (childAt > 0) await child(process.argv.slice(childAt + 1).map(Number));
else await parent();
