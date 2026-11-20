// Walks the mainnet chain from genesis to the tip through the local pearld and
// runs pearljs over every block and transaction. It keeps its own UTXO set so
// every input's prevout is known: fees, coinbase value, the script
// interpreter on every input and checkStandard on every transaction come
// from it. Resumable: state and the UTXO set are saved every CHECKPOINT
// blocks under $PEARL_WORK_DIR/mainnet-walk/, and a restart continues there.
//
//   scripts/mainnet/run.sh walk.mjs [--to HEIGHT]
//
// run.sh gives node a 24 GB heap: past height 66000 the UTXO set holds
// millions of small outputs.
//
// Findings go to failures.jsonl; each refused or mis-hashed block is saved
// raw under test-mainnet/fixtures/.

import { writeFileSync, appendFileSync, existsSync, renameSync, openSync, writeSync, closeSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { setImmediate } from 'node:timers';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { rpcBatch, rpc, rpcStats, closeRpc, OUT, readJson, writeJson, hex, fromHex } from './lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dist = (name) => import(join(root, 'dist', `${name}.js`));
const blockMod = await dist('block');
const headerMod = await dist('blockheader');
const consensus = await dist('consensus');
const { mainnet } = await dist('networks');
const mining = await dist('mining');
const policy = await dist('policy');
const scriptMod = await dist('script');
const txMod = await dist('transaction');
const inspect = await dist('inspect');
const interp = await dist('interpreter');
const tools = await dist('scripttools');
const { OPCODE_NAMES } = await dist('opcodes');

const argTo = process.argv.indexOf('--to');
const STOP_AT = argTo > 0 ? Number(process.argv[argTo + 1]) : Infinity;
const RANGE = 10;
const CHECKPOINT = 2000;
const STATE = join(OUT, 'walk-state.json');
const UTXO = join(OUT, 'walk-utxo.jsonl');
const FAILURES = join(OUT, 'failures.jsonl');
const FEES = join(OUT, 'block-fees.jsonl');
const NONSTD = join(OUT, 'nonstandard.jsonl');
const LOG = join(OUT, 'walk.log');
const FIXTURES = process.env.PEARL_WALK_FIXTURES ?? join(root, 'test-mainnet', 'fixtures');

const log = (line) => {
  const text = `${new Date().toISOString()} ${line}`;
  console.log(text);
  appendFileSync(LOG, `${text}\n`);
};

const freshTallies = () => ({
  blocks: 0, transactions: 0, inputs: 0, outputs: 0, coinbaseOutputs: 0,
  certVersions: {}, outputClasses: {}, coinbaseOutputClasses: {}, inputSpends: {}, sighashTypes: {},
  leafKinds: {}, leafOpcodes: {}, uniqueLeaves: 0, annexes: 0, opReturns: 0, p2mrTxs: 0, scriptPathTxs: 0,
  nonDefaultSighashTxs: 0, interpreterVerified: 0, interpreterFailed: 0, interpreterMs: 0,
  standardChecked: 0, nonStandard: {}, vsizeChecked: 0, vsizeExact: 0, vsizeMismatch: 0,
  coinbaseTexts: {}, unclaimedPositive: 0, unclaimedZero: 0, unclaimedTotal: '0', feesTotal: '0',
  v1BlockWork: {}, failures: 0, wtemaChecked: 0, wtemaMismatch: 0, timestampChecked: 0,
  bip34Mismatch: 0, maturityViolations: 0, txVersions: {}, sanityChecked: 0,
});

let state = readJson(STATE, null);
const utxo = new Map();
if (state === null) {
  state = { next: 0, prevHash: null, timestamps: [], prevBits: null, tallies: freshTallies(), started: new Date().toISOString(), seconds: 0, bytes: 0, leafSeen: [] };
} else if (existsSync(UTXO)) {
  // Line by line: the set outgrows the longest string V8 can hold.
  for await (const line of createInterface({ input: createReadStream(UTXO), crlfDelay: Infinity })) {
    if (line === '') continue;
    const [key, value, script, height, coinbase] = JSON.parse(line);
    utxo.set(key, { value: BigInt(value), script, height, coinbase });
  }
}
const T = state.tallies;
const leafSeen = new Set(state.leafSeen);
const bump = (map, key, by = 1) => { map[key] = (map[key] ?? 0) + by; };

function save() {
  const fd = openSync(`${UTXO}.tmp`, 'w');
  let lines = [];
  for (const [key, u] of utxo) {
    lines.push(JSON.stringify([key, u.value.toString(), u.script, u.height, u.coinbase]));
    if (lines.length === 20000) {
      writeSync(fd, `${lines.join('\n')}\n`);
      lines = [];
    }
  }
  if (lines.length > 0) writeSync(fd, `${lines.join('\n')}\n`);
  closeSync(fd);
  state.leafSeen = [...leafSeen];
  writeJson(`${STATE}.next`, state);
  renameSync(`${UTXO}.tmp`, UTXO);
  renameSync(`${STATE}.next`, STATE);
}

function fail(height, kind, detail, raw) {
  T.failures += 1;
  appendFileSync(FAILURES, `${JSON.stringify({ height, kind, ...detail })}\n`);
  log(`FINDING height ${height} ${kind} ${JSON.stringify(detail).slice(0, 300)}`);
  if (raw !== undefined) {
    const path = join(FIXTURES, `block-${height}.hex`);
    if (!existsSync(path)) writeFileSync(path, raw);
  }
}

const msg = (error) => `${error?.code ?? error?.name ?? 'Error'}: ${error?.message ?? error}`;
const displayHex = (bytes) => hex(Uint8Array.from(bytes).reverse());

function leafOpcodes(script) {
  try {
    for (const chunk of tools.decompileScript(script)) {
      const name = typeof chunk === 'number' ? (OPCODE_NAMES[chunk] ?? `0x${chunk.toString(16)}`) : `PUSH${chunk.length}`;
      bump(T.leafOpcodes, name);
    }
  } catch (error) {
    bump(T.leafOpcodes, `undecodable(${msg(error)})`);
  }
}

function spendEstimate(input, spend) {
  if (spend.type === 'keyPath') return { type: 'keyPath', sighashType: spend.sighashType };
  if (spend.type === 'scriptPath') {
    const proof = spend.controlBlock.subarray(spend.p2mr ? 1 : 33);
    const tree = { root: new Uint8Array(32), leaves: [{ script: spend.script, proof, leafVersion: spend.leafVersion }] };
    const last = spend.stack.at(-1);
    const sighashType = spend.leaf === 'checksig' && last?.length === 65 ? last[64] : spend.leaf === 'multiA' ? (spend.stack.find((s) => s.length === 65)?.[64] ?? 0) : 0;
    const base = { type: 'scriptPath', tree, leafIndex: 0, p2mr: spend.p2mr, sighashType };
    return spend.leaf === 'other' ? { ...base, stack: spend.stack.map((s) => s.length) } : base;
  }
  return { type: 'witness', items: input.witness.map((w) => w.length) };
}

function processBlock(height, hash, raw, verbose) {
  const bytes = fromHex(raw);
  let block;
  try {
    block = blockMod.parseBlock(bytes);
  } catch (error) {
    fail(height, 'parseBlock', { error: msg(error) }, raw);
    return null;
  }
  try {
    const legacy = blockMod.parseBlock(bytes, { fp8: false });
    if (hex(blockMod.serializeBlock(legacy, { fp8: false })) !== raw) fail(height, 'reserialize(fp8:false)', {}, raw);
  } catch (error) {
    fail(height, 'parseBlock(fp8:false)', { error: msg(error) }, raw);
  }
  if (hex(blockMod.serializeBlock(block)) !== raw) fail(height, 'reserialize', {}, raw);
  const header = block.header;
  const computedHash = headerMod.blockHashHex(header);
  if (computedHash !== hash) fail(height, 'blockHash', { computed: computedHash, node: hash }, raw);
  const tries = [
    ['checkMerkleRoot', () => blockMod.checkMerkleRoot(block)],
    ['checkWitnessCommitment', () => blockMod.checkWitnessCommitment(block)],
  ];
  if (height > 0) {
    tries.push(['checkCertificateBinding', () => blockMod.checkCertificateBinding(block)]);
    tries.push(['checkCertificateRules', () => consensus.checkCertificateRules(block.certificate, mainnet, height)]);
  }
  for (const [name, fn] of tries) {
    try {
      fn();
    } catch (error) {
      fail(height, name, { error: msg(error) }, raw);
    }
  }
  const version = block.certificate?.version ?? 0;
  bump(T.certVersions, version);
  if (height > 0 && consensus.requiredCertVersion(mainnet, height) !== version) {
    fail(height, 'requiredCertVersion', { want: consensus.requiredCertVersion(mainnet, height), got: version });
  }
  if (height > 0) {
    try {
      mining.checkBlockWork(block, mainnet, height);
      if (version === 1) bump(T.v1BlockWork, 'passes');
    } catch (error) {
      if (version === 1) bump(T.v1BlockWork, msg(error));
      else fail(height, 'checkBlockWork', { error: msg(error) }, raw);
    }
  }

  // Against the node's own view of the block.
  const merkle = displayHex(header.merkleRoot);
  const vs = blockMod.blockVsize(block);
  const compare = [
    ['merkleroot', merkle, verbose.merkleroot],
    ['size', blockMod.blockSize(block), verbose.size],
    ['strippedsize', blockMod.blockStrippedSize(block), verbose.strippedsize],
    ['bits', header.bits.toString(16).padStart(8, '0'), verbose.bits],
    ['time', header.timestamp, verbose.time],
    ['version', header.version, verbose.version],
    ['difficulty', consensus.difficultyForBits(header.bits, mainnet), verbose.difficulty],
    ['txcount', block.transactions.length, verbose.tx.length],
  ];
  if (verbose.weight !== undefined) compare.push(['vsize', vs, Math.ceil(verbose.weight / 4)]);
  if (height > 0) compare.push(['previousblockhash', displayHex(header.prevBlock), verbose.previousblockhash]);
  for (const [field, ours, node] of compare) {
    if (ours !== node) fail(height, `node.${field}`, { pearljs: ours, node });
  }
  if (consensus.targetToBits(consensus.bitsToTarget(header.bits)) !== header.bits) fail(height, 'bitsRoundTrip', { bits: header.bits });

  // Linkage, timestamp and difficulty.
  if (height > 0) {
    if (displayHex(header.prevBlock) !== state.prevHash) fail(height, 'linkage', { prev: displayHex(header.prevBlock), expected: state.prevHash });
    const prevTime = state.timestamps.at(-1);
    T.timestampChecked += 1;
    if (header.timestamp < prevTime + 1) fail(height, 'timestamp', { time: header.timestamp, prevTime });
    const parentTimestamp = state.timestamps.length >= 2 ? state.timestamps.at(-2) : null;
    const want = consensus.nextBlockBits(mainnet, { bits: state.prevBits, timestamp: prevTime, parentTimestamp }, header.timestamp);
    T.wtemaChecked += 1;
    if (want !== header.bits) {
      T.wtemaMismatch += 1;
      fail(height, 'wtema', { bits: header.bits.toString(16), expected: want.toString(16) });
    }
    if (consensus.bitsToTarget(header.bits) > mainnet.powLimit) fail(height, 'powLimit', { bits: header.bits });
  }
  const sortedTimes = [...state.timestamps.slice(-11)].sort((a, b) => a - b);
  const mtpPrev = sortedTimes.length === 0 ? 0 : sortedTimes[Math.floor(sortedTimes.length / 2)];

  // Transactions.
  let fees = 0n;
  const created = [];
  const window = height >= (state.windowStart ?? Infinity);
  const blockRates = [];
  block.transactions.forEach((tx, index) => {
    checkTx(tx, index);
    // Later transactions of the block may spend this one's outputs.
    for (const [key, value] of created.splice(0)) utxo.set(key, value);
  });
  function checkTx(tx, index) {
    T.transactions += 1;
    bump(T.txVersions, tx.version);
    const txid = txMod.transactionId(tx);
    if (txid !== verbose.tx[index]) fail(height, 'txid', { index, pearljs: txid, node: verbose.tx[index] }, raw);
    const wtxid = txMod.witnessTransactionId(tx);
    try {
      const again = txMod.parseTransaction(hex(tx.toBuffer()));
      if (txMod.transactionId(again) !== txid || txMod.witnessTransactionId(again) !== wtxid || txMod.serializeTransaction(again) !== tx.toHex()) {
        fail(height, 'txRoundTrip', { txid });
      }
    } catch (error) {
      fail(height, 'parseTransaction', { txid, error: msg(error) }, raw);
    }
    T.sanityChecked += 1;
    const coinbase = index === 0;
    try {
      policy.checkSanity(tx);
      if (coinbase) fail(height, 'checkSanityCoinbasePassed', { txid });
    } catch (error) {
      // checkSanity refuses a lone coinbase as pearld's mempool does; anything
      // else about a mined coinbase, or any refusal of a mined spend, is a finding.
      if (coinbase && error.code === 'SANITY_COINBASE') bump(T, 'coinbaseSanityAsMempool');
      else if (height === 0) bump(T, `genesis ${error.code}`);
      else fail(height, 'checkSanity', { txid, error: msg(error) }, raw);
    }
    let hasP2mr = false;
    let hasScriptPath = false;
    let hasNonDefault = false;
    let hasOpReturn = false;
    tx.outs.forEach((out, vout) => {
      T.outputs += 1;
      const cls = scriptMod.classifyOutputScript(out.script);
      bump(coinbase ? T.coinbaseOutputClasses : T.outputClasses, cls);
      if (coinbase) T.coinbaseOutputs += 1;
      if (cls === 'p2mr') hasP2mr = true;
      if (cls === 'nulldata') {
        hasOpReturn = true;
        if (!coinbase) T.opReturns += 1;
      } else if (height > 0) {
        created.push([`${txid}:${vout}`, { value: out.value, script: hex(out.script), height, coinbase }]);
      }
    });
    if (coinbase) {
      const text = inspect.coinbaseText(tx.ins[0].script);
      bump(T.coinbaseTexts, text.slice(0, 60));
      return;
    }
    const prevouts = [];
    for (const input of tx.ins) {
      const key = `${displayHex(input.hash)}:${input.index}`;
      const u = utxo.get(key);
      if (u === undefined) {
        fail(height, 'missingPrevout', { txid, key });
        return;
      }
      if (u.coinbase && height - u.height < mainnet.coinbaseMaturity) {
        T.maturityViolations += 1;
        fail(height, 'coinbaseMaturity', { txid, key, created: u.height });
      }
      utxo.delete(key);
      prevouts.push({ script: fromHex(u.script), value: u.value });
    }
    T.inputs += tx.ins.length;
    let info;
    try {
      info = inspect.inspectTransaction(tx, prevouts, mainnet);
    } catch (error) {
      fail(height, 'inspectTransaction', { txid, error: msg(error) });
      return;
    }
    fees += info.fee;
    blockRates.push(Number(info.feeRate));
    info.inputs.forEach((input, i) => {
      const s = input.spend;
      if (scriptMod.classifyOutputScript(input.script) === 'p2mr') hasP2mr = true;
      if (input.annex !== undefined) T.annexes += 1;
      if (s.type === 'keyPath') {
        bump(T.inputSpends, 'p2tr keyPath');
        bump(T.sighashTypes, `keyPath 0x${s.sighashType.toString(16)}`);
        if (s.sighashType !== 0) hasNonDefault = true;
      } else if (s.type === 'scriptPath') {
        hasScriptPath = true;
        bump(T.inputSpends, `${s.p2mr ? 'p2mr' : 'p2tr'} scriptPath ${s.leaf}`);
        bump(T.leafKinds, `${s.p2mr ? 'p2mr' : 'p2tr'} ${s.leaf}${s.threshold === undefined ? '' : ` ${s.threshold}-of-${s.keys.length}`}`);
        if (!s.commits) fail(height, 'scriptPathCommits', { txid, input: i });
        const sig = s.stack.find((item) => item.length === 65);
        if (sig !== undefined) {
          hasNonDefault = true;
          bump(T.sighashTypes, `scriptPath 0x${sig[64].toString(16)}`);
        } else if (s.leaf !== 'xmss') bump(T.sighashTypes, 'scriptPath 0x0');
        const leafId = hex(s.leafHash);
        if (!leafSeen.has(leafId)) {
          leafSeen.add(leafId);
          T.uniqueLeaves += 1;
        }
        leafOpcodes(s.script);
      } else {
        bump(T.inputSpends, s.type);
      }
    });
    if (hasP2mr) T.p2mrTxs += 1;
    if (hasScriptPath) T.scriptPathTxs += 1;
    if (hasNonDefault) T.nonDefaultSighashTxs += 1;

    // PEARL_WALK_SAMPLE=1 verifies large plain consolidations only in every
    // 50th block, for a quicker walk; without it every input is verified.
    const unusual = hasP2mr || hasScriptPath || hasNonDefault || hasOpReturn || info.inputs.some((input) => input.annex !== undefined);
    if (process.env.PEARL_WALK_SAMPLE === '1' && height % 50 !== 0 && !unusual && tx.ins.length > 64) {
      T.interpreterSkipped = (T.interpreterSkipped ?? 0) + tx.ins.length;
    } else {
    const t0 = performance.now();
    const verdict = interp.verifyTransaction(tx, prevouts);
    T.interpreterMs += performance.now() - t0;
    if (verdict.ok) T.interpreterVerified += tx.ins.length;
    else {
      T.interpreterFailed += 1;
      fail(height, 'interpreter', { txid, input: verdict.inputIndex, code: verdict.code, message: verdict.message }, raw);
    }
    }

    T.standardChecked += 1;
    try {
      policy.checkStandard(tx, { prevouts, height, medianTimePast: mtpPrev });
    } catch (error) {
      bump(T.nonStandard, error.code ?? 'other');
      appendFileSync(NONSTD, `${JSON.stringify({ height, txid, window, error: msg(error), version: tx.version, vsize: info.vsize, fee: info.fee.toString() })}\n`);
    }
    try {
      const estimate = policy.estimateVsize(tx, info.inputs.map((input, i) => spendEstimate(tx.ins[i], input.spend)));
      T.vsizeChecked += 1;
      if (estimate === info.vsize) T.vsizeExact += 1;
      else {
        T.vsizeMismatch += 1;
        const kinds = info.inputs.map((input) => (input.spend.type === 'scriptPath' ? `${input.spend.leaf}` : input.spend.type));
        appendFileSync(join(OUT, 'vsize.jsonl'), `${JSON.stringify({ height, txid, estimate, vsize: info.vsize, kinds })}\n`);
      }
    } catch (error) {
      appendFileSync(join(OUT, 'vsize.jsonl'), `${JSON.stringify({ height, txid, error: msg(error) })}\n`);
    }
  }

  // Coinbase value against subsidy plus fees, and BIP 34.
  if (height > 0) {
    const coinbase = block.transactions[0];
    const reward = coinbase.outs.reduce((sum, out) => sum + out.value, 0n);
    const subsidy = consensus.blockSubsidy(mainnet, height);
    const unclaimed = subsidy + fees - reward;
    T.feesTotal = (BigInt(T.feesTotal) + fees).toString();
    if (unclaimed < 0n) fail(height, 'coinbaseValue', { reward: reward.toString(), subsidy: subsidy.toString(), fees: fees.toString() }, raw);
    else if (unclaimed === 0n) T.unclaimedZero += 1;
    else {
      T.unclaimedPositive += 1;
      T.unclaimedTotal = (BigInt(T.unclaimedTotal) + unclaimed).toString();
    }
    const cb = inspect.inspectTransaction(coinbase, [], mainnet, { blockFees: fees, height }).coinbase;
    if (cb.height !== height) {
      T.bip34Mismatch += 1;
      fail(height, 'bip34', { read: cb.height });
    }
    if (cb.unclaimed !== unclaimed) fail(height, 'inspectUnclaimed', { inspect: String(cb.unclaimed), walk: unclaimed.toString() });
  }
  if (blockRates.length > 0) {
    blockRates.sort((a, b) => a - b);
    appendFileSync(FEES, `${JSON.stringify({ height, txs: blockRates.length, min: blockRates[0], median: blockRates[Math.floor(blockRates.length / 2)], fees: fees.toString(), vsize: vs })}\n`);
  }

  T.blocks += 1;
  state.prevHash = hash;
  state.prevBits = header.bits;
  state.timestamps = [...state.timestamps, header.timestamp].slice(-11);
  return block;
}

async function fetchRange(start, count) {
  const hashes = await rpcBatch(Array.from({ length: count }, (_, i) => ['getblockhash', [start + i]]));
  const calls = hashes.flatMap((h) => [['getblock', [h, 0]], ['getblock', [h, 1]]]);
  const replies = await rpcBatch(calls);
  return hashes.map((hash, i) => ({ height: start + i, hash, raw: replies[2 * i], verbose: replies[2 * i + 1] }));
}

const tip = Math.min(await rpc('getblockcount'), STOP_AT);
state.windowStart ??= tip - 1999;
log(`walk from ${state.next} to ${tip}; latest-2000 window from ${state.windowStart}; utxo ${utxo.size}`);
let pending = state.next <= tip ? fetchRange(state.next, Math.min(RANGE, tip - state.next + 1)) : null;
let sinceSave = 0;
let windowStartTime = performance.now();
let windowBlocks = 0;
const baseSeconds = state.seconds;
const baseBytes = state.bytes;
const sessionStart = performance.now();
while (pending !== null) {
  const range = await pending;
  const after = range.at(-1).height + 1;
  pending = after <= tip ? fetchRange(after, Math.min(RANGE, tip - after + 1)) : null;
  for (const item of range) {
    if (item.verbose.height !== item.height) fail(item.height, 'node.height', { node: item.verbose.height });
    processBlock(item.height, item.hash, item.raw, item.verbose);
    // Let replies land and RPC slots be released between blocks.
    await new Promise((resolve) => setImmediate(resolve));
    state.next = item.height + 1;
    sinceSave += 1;
    windowBlocks += 1;
  }
  if (sinceSave >= CHECKPOINT || pending === null) {
    const now = performance.now();
    state.seconds = baseSeconds + (now - sessionStart) / 1000;
    state.bytes = baseBytes + rpcStats.bytes;
    const rate = windowBlocks / ((now - windowStartTime) / 1000);
    log(`height ${state.next - 1} | ${rate.toFixed(1)} blocks/s | utxo ${utxo.size} | tx ${T.transactions} | inputs verified ${T.interpreterVerified} | failures ${T.failures} | ${(state.bytes / 1e9).toFixed(2)} GB | 503s ${rpcStats.retries503}`);
    save();
    sinceSave = 0;
    windowBlocks = 0;
    windowStartTime = now;
  }
}
save();
log(`done at ${state.next - 1}: ${T.blocks} blocks, ${T.transactions} transactions, ${T.failures} failures, ${state.seconds.toFixed(0)} s, ${(state.bytes / 1e9).toFixed(2)} GB`);
closeRpc();
