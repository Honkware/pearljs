// Compares pearljs's wallet backends on real mainnet addresses: coins,
// balance and history from filterBackend over the local pearld (header
// checks on), pearldBackend where the node's indexes allow it, and
// blockbookBackend against the public Blockbook, all against the UTXO set
// walk.mjs built from the node's blocks. Then a watch-only PearlWallet over
// each backend for one account, and the backends' fee estimates.
//
//   PEARL_RPC_INFLIGHT=1 scripts/mainnet/run.sh backends.mjs
//
// Run walk.mjs to the tip first; this script brings it up to date if the
// node has moved on. Blockbook requests count against the 300-request cap in
// lib.mjs and the script stops asking Blockbook before it is reached.
import { readFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { OUT, RPC_URL, RPC_USER, password, gatedFetch, rpc, closeRpc, writeJson, blockbookFetch, blockbookUsed, BLOCKBOOK_URL, rpcStats } from './lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const load = (name) => import(join(root, 'dist', `${name}.js`));
const { PearldClient } = await load('rpc');
const { mainnet } = await load('networks');
const { filterBackend } = await load('backend-filters');
const { pearldBackend, sumBalance } = await load('backend');
const { blockbookBackend } = await load('backend-blockbook');
const { BlockbookClient } = await load('blockbook');
const { fromOutputScript } = await load('address');
const { PearlWallet } = await load('wallet');
const { createMemoryStore } = await load('store');
const { mnemonicToSeed } = await load('mnemonic');
const { deriveAccountFromSeed } = await load('keys');
const { DEFAULT_RELAY_FEE_RATE, feeForVsize, minRelayFee } = await load('policy');

const REPORT = join(OUT, 'backends.json');
const LOG = join(OUT, 'backends.log');
const log = (line) => {
  const text = `${new Date().toISOString()} ${line}`;
  console.log(text);
  appendFileSync(LOG, `${text}\n`);
};
const report = { findings: [], notTested: [] };
const finding = (what) => {
  report.findings.push(what);
  log(`FINDING ${JSON.stringify(what, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 400)}`);
};
const BB_BUDGET = 290;

// 1. The walk's UTXO set at the node's tip.
let tip = await rpc('getblockcount');
let state = JSON.parse(readFileSync(join(OUT, 'walk-state.json'), 'utf8'));
if (state.next - 1 !== tip) {
  log(`walk is at ${state.next - 1}, node at ${tip}: bringing the walk up to date`);
  execFileSync(process.execPath, [join(root, 'scripts', 'mainnet', 'walk.mjs')], { stdio: 'inherit', env: process.env });
  state = JSON.parse(readFileSync(join(OUT, 'walk-state.json'), 'utf8'));
}
const height = state.next - 1;
const truthHash = state.prevHash;
const byScript = new Map();
for (const line of readFileSync(join(OUT, 'walk-utxo.jsonl'), 'utf8').split('\n')) {
  if (line === '') continue;
  const [key, value, script, h, coinbase] = JSON.parse(line);
  const [txid, vout] = key.split(':');
  let list = byScript.get(script);
  if (list === undefined) byScript.set(script, (list = []));
  list.push({ txid, vout: Number(vout), value: BigInt(value), height: h, coinbase });
}
log(`truth at ${height} ${truthHash}: ${byScript.size} scripts hold coins`);

// 2. Candidates.
const scripts = [...byScript.entries()];
const isP2mr = (s) => s.startsWith('5220');
const pool = scripts.filter(([, l]) => l.some((u) => u.coinbase)).sort((a, b) => b[1].length - a[1].length)[0];
const oneCoinbase = scripts.filter(([s, l]) => !isP2mr(s) && l.length === 1 && l[0].coinbase);
const small = scripts.filter(([s, l]) => !isP2mr(s) && l.length <= 2 && l.every((u) => !u.coinbase));
const p2mr = scripts.filter(([s]) => isP2mr(s));
const spread = (list, n) => list.length <= n ? list : Array.from({ length: n }, (_, i) => list[Math.floor((i * list.length) / n)]);
const candidates = new Map();
for (const [s] of [pool, ...spread(oneCoinbase, 15), ...spread(small, 40), ...spread(p2mr, 15)]) candidates.set(s, fromOutputScript(Buffer.from(s, 'hex'), mainnet));
log(`candidates: pool ${candidates.get(pool[0])} with ${pool[1].length} coins, ${oneCoinbase.length} one-coinbase scripts, ${small.length} small, ${p2mr.length} P2MR`);

// 3. filterBackend over the node, from genesis, for every candidate.
const client = new PearldClient({ url: RPC_URL, username: RPC_USER, password: password(), fetch: gatedFetch, batch: true, maxConcurrentRequests: 2 });
const filters = filterBackend(client, { network: mainnet, birthday: 0, watch: [...candidates.values()], concurrency: 8, batchSize: 500 });
let t0 = Date.now();
await filters.sync({ onProgress: (p) => (p.height % 10000 < 500 ? log(`filters at ${p.height}/${p.tip}, ${p.blocksFetched} blocks fetched`) : undefined) });
report.filterSyncSeconds = Math.round((Date.now() - t0) / 1000);
report.filterStatus = await filters.status();
log(`filter sync took ${report.filterSyncSeconds} s`);

const keyOf = (u) => `${u.txid}:${u.vout}`;
const sameCoins = (a, b) => {
  const left = new Map(a.map((u) => [keyOf(u), u.value]));
  const right = new Map(b.map((u) => [keyOf(u), u.value]));
  const onlyA = [...left.keys()].filter((k) => right.get(k) !== left.get(k));
  const onlyB = [...right.keys()].filter((k) => left.get(k) !== right.get(k));
  return onlyA.length === 0 && onlyB.length === 0 ? null : { onlyA, onlyB };
};
const truthUtxos = (script, at) => (byScript.get(script) ?? []).map((u) => ({ ...u, confirmations: at - u.height + 1 }));

// Histories, to choose addresses Blockbook can answer within the cap.
const history = new Map();
for (const [script, address] of candidates) history.set(script, await filters.getHistory(address));

// 4. The 30 addresses.
const cheap = (s) => history.get(s).length <= 2;
const chosen = [pool[0]];
const take = (list, n) => {
  for (const [s] of list) {
    if (n === 0) break;
    if (candidates.has(s) && cheap(s) && !chosen.includes(s)) {
      chosen.push(s);
      n -= 1;
    }
  }
};
take(spread(p2mr, 15), 4);
take(spread(oneCoinbase, 15), 8);
take(spread(small, 40), 30 - chosen.length);
report.addresses = chosen.map((s) => ({ address: candidates.get(s), script: s, kind: s === pool[0] ? 'pool' : isP2mr(s) ? 'p2mr' : byScript.get(s)[0].coinbase ? 'coinbase' : 'small', coins: byScript.get(s).length, history: history.get(s).length }));
log(`chosen ${chosen.length}: ${JSON.stringify(report.addresses.map((a) => [a.kind, a.coins, a.history]))}`);

// 5. Each backend against the truth and the filter backend.
const nodeTip = await rpc('getblockcount');
if (nodeTip !== height) finding({ item: 'tip moved during the comparison', walk: height, node: nodeTip });
const pearld = pearldBackend(client, { network: mainnet, concurrency: 2 });
const bbClient = new BlockbookClient({ url: BLOCKBOOK_URL, network: mainnet, fetch: blockbookFetch, maxConcurrentRequests: 2 });
const blockbook = blockbookBackend(bbClient, { concurrency: 2 });
const rows = [];
for (const script of chosen) {
  const address = candidates.get(script);
  const row = { address, kind: report.addresses.find((a) => a.script === script).kind };
  const truth = truthUtxos(script, height);
  const truthBalance = sumBalance(truth, mainnet.coinbaseMaturity);
  const fUtxos = await filters.getUtxos([address]);
  const fBalance = await filters.getBalance([address]);
  const fHistory = history.get(script);
  row.filter = { coins: fUtxos.length, balance: fBalance };
  const diff = sameCoins(truth, fUtxos);
  if (diff) finding({ item: 'filterBackend coins differ from the chain', address, ...diff });
  for (const k of ['confirmed', 'unconfirmed', 'immature']) {
    if (fBalance[k] !== truthBalance[k]) finding({ item: `filterBackend ${k} balance differs from the chain`, address, filter: fBalance[k], chain: truthBalance[k] });
  }
  try {
    const pUtxos = await pearld.getUtxos([address]);
    const pBalance = await pearld.getBalance([address]);
    const pHistory = await pearld.getHistory(address);
    row.pearld = { coins: pUtxos.length, balance: pBalance, history: pHistory.length };
    const d = sameCoins(truth, pUtxos);
    if (d) finding({ item: 'pearldBackend coins differ from the chain', address, ...d });
    if (pBalance.confirmed !== truthBalance.confirmed || pBalance.immature !== truthBalance.immature) finding({ item: 'pearldBackend balance differs from the chain', address, pearld: pBalance, chain: truthBalance });
    const h1 = fHistory.map((e) => `${e.txid}@${e.block?.height}:${e.received}:${e.spent}`).sort().join();
    const h2 = pHistory.map((e) => `${e.txid}@${e.block?.height}:${e.received}:${e.spent}`).sort().join();
    if (h1 !== h2) finding({ item: 'pearldBackend history differs from filterBackend', address, filter: h1, pearld: h2 });
  } catch (error) {
    row.pearld = { error: `${error.code ?? error.name}: ${error.message}`.slice(0, 160) };
  }
  if (row.kind === 'pool') {
    // Blockbook's backend reads every transaction of an address and the block
    // it is in; the pool's thousands would take the whole cap. One balance
    // query instead.
    if (blockbookUsed() < BB_BUDGET) {
      const info = await bbClient.getAddress(address, { details: 'basic' });
      row.blockbookRaw = { balance: String(info.balance), txs: info.txs };
      if (BigInt(info.balance) !== truthBalance.confirmed + truthBalance.immature) finding({ item: 'Blockbook balance of the pool address differs from the chain', address, blockbook: String(info.balance), chain: String(truthBalance.confirmed + truthBalance.immature), blockbookHeight: info.blockbook?.bestHeight });
    }
  } else if (blockbookUsed() + 4 + 2 * fHistory.length <= BB_BUDGET) {
    try {
      const before = blockbookUsed();
      const bUtxos = await blockbook.getUtxos([address]);
      const bBalance = await blockbook.getBalance([address]);
      const bHistory = await blockbook.getHistory(address);
      row.blockbook = { coins: bUtxos.length, balance: bBalance, history: bHistory.length, requests: blockbookUsed() - before };
      const d = sameCoins(truth, bUtxos);
      if (d) finding({ item: 'blockbookBackend coins differ from the chain', address, ...d });
      if (bBalance.confirmed !== truthBalance.confirmed || bBalance.immature !== truthBalance.immature) finding({ item: 'blockbookBackend balance differs from the chain', address, blockbook: bBalance, chain: truthBalance });
      const h1 = fHistory.map((e) => `${e.txid}@${e.block?.height}:${e.received}:${e.spent}`).sort().join();
      const h2 = bHistory.map((e) => `${e.txid}@${e.block?.height}:${e.received}:${e.spent}`).sort().join();
      if (h1 !== h2) finding({ item: 'blockbookBackend history differs from filterBackend', address, filter: h1, blockbook: h2 });
    } catch (error) {
      row.blockbook = { error: `${error.code ?? error.name}: ${error.message}`.slice(0, 200) };
      finding({ item: 'blockbookBackend failed', address, error: row.blockbook.error });
    }
  } else {
    row.blockbook = { skipped: 'request cap' };
  }
  rows.push(row);
  log(`${row.kind} ${address}: ${JSON.stringify(row, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 300)}`);
}
report.rows = rows;
report.height = height;
report.nodeTipAfter = await rpc('getblockcount');

// 6. A watch-only wallet over each backend. BIP86 account 0 of the BIP39 test
// phrase: public, so anyone may have paid it, and no secret is involved.
const account = deriveAccountFromSeed(mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'), mainnet, 0);
const xpub = account.extendedPublicKey();
report.wallet = { xpub, firstAddress: account.deriveAddress(0) };
const walletOver = async (name, backend, transactions) => {
  try {
    const wallet = await PearlWallet.create({ store: createMemoryStore(), backend, ...(transactions ? { transactions } : {}), watchOnly: xpub, gapLimit: 5 });
    await wallet.sync();
    const snapshot = wallet.getSnapshot();
    await wallet.close();
    return { balance: snapshot.balance, transactions: snapshot.transactions };
  } catch (error) {
    return { error: `${error.code ?? error.name}: ${error.message}`.slice(0, 200) };
  }
};
const walletFilters = filterBackend(client, { network: mainnet, birthday: 0, concurrency: 8, batchSize: 500 });
report.wallet.filter = await walletOver('filter', walletFilters);
report.wallet.pearld = await walletOver('pearld', pearld, walletFilters);
report.wallet.blockbook = blockbookUsed() + 30 <= BB_BUDGET ? await walletOver('blockbook', blockbook) : { skipped: 'request cap' };
log(`wallet: ${JSON.stringify(report.wallet, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);

// 7. Fee estimates.
const nodeEstimate = await rpc('estimatefee', 6);
report.fees = {
  nodeEstimatefee6: nodeEstimate,
  pearld: String(await pearld.estimateFeeRate(6).catch((e) => e.message)),
  filter: String(await filters.estimateFeeRate(6).catch((e) => e.message)),
  blockbook: blockbookUsed() + 2 <= BB_BUDGET ? String(await blockbook.estimateFeeRate(6).catch((e) => e.message)) : 'skipped',
  relayDefault: String(DEFAULT_RELAY_FEE_RATE),
  minRelayFee141: String(minRelayFee(141)),
  feeForVsize141At1000: String(feeForVsize(141, 1000n)),
};
report.blockbookRequests = blockbookUsed();
report.rpcRequests = rpcStats.requests;
writeJson(REPORT, report);
log(`done: ${report.findings.length} findings, ${report.blockbookRequests} Blockbook requests`);
closeRpc();
