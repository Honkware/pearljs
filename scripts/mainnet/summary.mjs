// Summarises what walk.mjs recorded: counts, findings by kind, the script
// usage tally, the policy results and the fee rates of recent blocks.
//
//   node scripts/mainnet/summary.mjs
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { OUT, writeJson } from './lib.mjs';

const lines = (name) => (existsSync(join(OUT, name)) ? readFileSync(join(OUT, name), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const state = JSON.parse(readFileSync(join(OUT, 'walk-state.json'), 'utf8'));
const T = state.tallies;
const height = state.next - 1;
const windowStart = state.windowStart;
const count = (items, key) => items.reduce((m, x) => ((m[key(x)] = (m[key(x)] ?? 0) + 1), m), {});
const top = (map, n) => Object.fromEntries(Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, n));

// A restart repeats the blocks after the last checkpoint; keep each height once.
const byHeight = (rows) => [...new Map(rows.map((r) => [`${r.height}:${r.txid ?? ''}:${r.kind ?? ''}`, r])).values()].filter((r) => r.height <= height);
const failures = byHeight(lines('failures.jsonl'));
const nonstandard = byHeight(lines('nonstandard.jsonl'));
const vsize = byHeight(lines('vsize.jsonl'));
const fees = [...new Map(lines('block-fees.jsonl').map((r) => [r.height, r])).values()].filter((r) => r.height <= height);

// Pushes by size class, so the opcode tally reads.
const opcodes = {};
for (const [name, n] of Object.entries(T.leafOpcodes)) {
  const m = /^PUSH(\d+)$/.exec(name);
  const key = m === null ? name : Number(m[1]) <= 75 ? `push 1-75 bytes` : Number(m[1]) <= 255 ? 'OP_PUSHDATA1 (76-255 bytes)' : 'OP_PUSHDATA2 (256-520 bytes)';
  opcodes[key] = (opcodes[key] ?? 0) + n;
}

const recent = fees.filter((r) => r.height >= windowStart);
const mins = recent.map((r) => r.min).sort((a, b) => a - b);
const pct = (xs, p) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))];
const summary = {
  height,
  blocks: T.blocks,
  transactions: T.transactions,
  inputs: T.inputs,
  outputs: T.outputs,
  seconds: Math.round(state.seconds),
  gigabytes: +(state.bytes / 1e9).toFixed(2),
  blocksPerSecond: +(T.blocks / state.seconds).toFixed(1),
  failuresByKind: count(failures, (f) => f.kind),
  certVersions: T.certVersions,
  v1BlockWork: T.v1BlockWork,
  wtema: { checked: T.wtemaChecked, mismatch: T.wtemaMismatch },
  timestampsChecked: T.timestampChecked,
  coinbase: { claimedAll: T.unclaimedZero, leftSome: T.unclaimedPositive, unclaimedTotal: T.unclaimedTotal, feesTotal: T.feesTotal, bip34Mismatch: T.bip34Mismatch, sanityAsMempool: T.coinbaseSanityAsMempool },
  coinbaseTexts: top(T.coinbaseTexts, 15),
  distinctCoinbaseTexts: Object.keys(T.coinbaseTexts).length,
  txVersions: T.txVersions,
  outputClasses: T.outputClasses,
  coinbaseOutputClasses: T.coinbaseOutputClasses,
  interpreter: { inputsVerified: T.interpreterVerified, transactionsFailed: T.interpreterFailed, seconds: Math.round(T.interpreterMs / 1000) },
  inputSpends: T.inputSpends,
  sighashTypes: T.sighashTypes,
  leafKinds: T.leafKinds,
  uniqueLeaves: T.uniqueLeaves,
  leafOpcodes: Object.fromEntries(Object.entries(opcodes).sort((a, b) => b[1] - a[1])),
  annexes: T.annexes,
  transactionsWith: { p2mr: T.p2mrTxs, scriptPath: T.scriptPathTxs, nonDefaultSighash: T.nonDefaultSighashTxs, opReturn: T.opReturns },
  standard: {
    checked: T.standardChecked,
    nonStandard: T.nonStandard,
    latest2000: { from: windowStart, nonStandard: count(nonstandard.filter((r) => r.height >= windowStart), (r) => r.error.split(':')[0]) },
    examples: nonstandard.slice(0, 20),
  },
  vsize: { checked: T.vsizeChecked, exact: T.vsizeExact, mismatch: T.vsizeMismatch, byInputKinds: count(vsize, (r) => (r.error ? `error ${r.error.slice(0, 60)}` : [...new Set(r.kinds)].sort().join('+'))), examples: vsize.slice(0, 10) },
  recentFeeRates: recent.length === 0 ? null : {
    blocksWithTransactions: recent.length,
    lowestRatePaid: mins[0],
    medianOfBlockMinimums: pct(mins, 0.5),
    p10OfBlockMinimums: pct(mins, 0.1),
    blocksWithMinimumUnder1000: mins.filter((m) => m < 1000).length,
  },
};
writeJson(join(OUT, 'walk-summary.json'), summary);
console.log(JSON.stringify(summary, null, 1));
