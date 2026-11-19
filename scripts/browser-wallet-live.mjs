// A PearlWallet on the IndexedDB store in headless Chrome, against a real
// regtest pearld: receive, sync, send, reload, lock and unlock, two tabs on
// one wallet, a tab killed mid-send, site data cleared underneath, a full
// quota, a private (incognito) context and a database at another version.
//
//   PEARLD=/path/to/pearld [PEARL_LIVE_CHAIN=setup-blocks.json] node scripts/browser-wallet-live.mjs
//
// A page cannot call pearld's RPC (self-signed TLS, Basic auth, no CORS), so
// the harness serves the page and a same-origin /rpc that forwards to pearld
// with the admin credentials. Run `npm run build` first. Prints one line per
// check and exits non-zero if any fails.
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { copyFileSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { build } from 'vite';
import wasm from 'vite-plugin-wasm';
import { deriveSigningAccountFromSeed, mnemonicToSeed, networks, parseBlock, parsePearl, payFromAccount, toOutputScript } from '../dist/index.js';
import { startRegtest, trustingFetch } from '../dist/testing-regtest.js';
import { launchChrome, waitFor } from './browser/drivers.mjs';
import { root } from './lib/pack.mjs';

if (!process.env.PEARLD) {
  console.log('skipped: set PEARLD to a pearld binary');
  process.exit(0);
}
const network = networks.regtest;
const MINER = `${'abandon '.repeat(11)}about`;
const miner = deriveSigningAccountFromSeed(mnemonicToSeed(MINER), network);
const minerAddress = miner.deriveAddress(0);
const PASS = 'browser wallet passphrase';

// The page, bundled from dist/ as a consumer's bundler would bundle the package.
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pearljs-wallet-live-')));
copyFileSync(join(root, 'scripts/browser/wallet-live/page.js'), join(dir, 'page.js'));
writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><title>wallet</title></head><body><script type="module" src="/page.js"></script></body></html>');
await build({
  root: dir,
  logLevel: 'error',
  plugins: [wasm()],
  resolve: { alias: [{ find: /^pearljs$/, replacement: join(root, 'dist/index.js') }] },
  build: { target: 'esnext', outDir: join(dir, 'out') },
});

const regtest = await startRegtest({ pearld: process.env.PEARLD, miningAddress: minerAddress });
const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
};
let server;
let chrome;
try {
  // Mature coinbases: the cached setup chain when it is younger than a day (pearld
  // ignores blocks for fee estimates on an older tip), else 101 freshly proved blocks.
  const cache = process.env.PEARL_LIVE_CHAIN;
  if (cache && Date.now() - statSync(cache).mtimeMs < 20 * 3600 * 1000) {
    for (const block of JSON.parse(await readFile(cache, 'utf8'))) await regtest.node.call('submitblock', [block]);
  } else {
    await regtest.mine(101);
  }
  let nextCoinbase = 1;
  const fund = async (address, amount) => {
    const hash = await regtest.node.getBlockHash(nextCoinbase++);
    const block = parseBlock(await regtest.node.getRawBlock(hash));
    const coinbase = block.transactions[0];
    const payment = payFromAccount(miner, {
      network,
      utxos: [{ txid: coinbase.getId(), vout: 0, value: coinbase.outs[0].value, script: toOutputScript(minerAddress, network), confirmations: 101, index: 0 }],
      recipients: [{ address, amount }],
      feeRate: 2000n,
      changeAddress: minerAddress,
    });
    return regtest.node.sendRawTransaction(payment.hex);
  };

  const forward = trustingFetch(regtest.endpoint.ca);
  const auth = `Basic ${globalThis.btoa(`${regtest.endpoint.username}:${regtest.endpoint.password}`)}`;
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm' };
  server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/rpc') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const reply = await forward(regtest.endpoint.url, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body });
      res.writeHead(reply.status, { 'Content-Type': 'application/json' });
      res.end(await reply.text());
      return;
    }
    const path = req.url === '/' ? '/index.html' : req.url.split('?')[0];
    try {
      const file = await readFile(join(dir, 'out', path));
      res.writeHead(200, { 'Content-Type': types[extname(path)] ?? 'application/octet-stream' });
      res.end(file);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  chrome = await launchChrome();
  const openTab = async (context) => {
    const { targetId } = await chrome.cdp.send('Target.createTarget', { url: `${origin}/`, ...(context ? { browserContextId: context } : {}) });
    const tab = await chrome.attach(targetId);
    await waitFor(tab, 'globalThis.appReady === true ? true : null', 30_000);
    tab.call = (method, ...args) => tab.evaluate(`app.${method}(...${JSON.stringify(args)})`);
    return tab;
  };
  const value = (reply) => {
    if (reply.error) throw new Error(`${reply.code ?? ''} ${reply.error}`);
    return reply.value;
  };
  const sink = 'rprl1p8dhv8twyj9ezfvk62vvsfgw39s4dgl9t42y0549dc4d2947jj4cs30wfpz';
  const step = async (name, fn) => {
    try {
      const detail = await fn();
      record(name, true, typeof detail === 'string' ? detail : '');
    } catch (error) {
      record(name, false, error.message);
    }
  };

  // Receive, sync, send.
  const a = await openTab();
  value(await a.call('create', 'a', 'w1', PASS));
  const address = value(await a.call('receive', 'a'));
  await step('receive and sync a payment from pearld', async () => {
    await fund(address, parsePearl('5'));
    value(await a.call('sync', 'a'));
    const pending = value(await a.call('balance', 'a'));
    await regtest.mine(1);
    value(await a.call('sync', 'a'));
    const confirmed = value(await a.call('balance', 'a'));
    if (pending.unconfirmed === '0' || confirmed.confirmed === '0') throw new Error(`balances ${JSON.stringify({ pending, confirmed })}`);
    return `confirmed ${confirmed.confirmed} grain`;
  });
  let firstSend;
  await step('send, and pearld takes it into its mempool', async () => {
    firstSend = value(await a.call('send', 'a', sink, '1'));
    if (!(await regtest.node.getRawMempool()).includes(firstSend.txid)) throw new Error('not in mempool');
    await regtest.mine(1);
    value(await a.call('sync', 'a'));
    const entry = value(await a.call('history', 'a')).find((e) => e.txid === firstSend.txid);
    if (entry?.status !== 'confirmed') throw new Error(JSON.stringify(entry));
  });

  // Reload the page: the wallet comes back from IndexedDB, locked.
  await step('reload the page and reopen: locked, same balance and history', async () => {
    const before = value(await a.call('balance', 'a'));
    await a.send('Page.reload');
    await sleep(500);
    await waitFor(a, 'globalThis.appReady === true ? true : null', 30_000);
    const locked = value(await a.call('open', 'a', 'w1'));
    const after = value(await a.call('balance', 'a'));
    const history = value(await a.call('history', 'a'));
    if (!locked || JSON.stringify(before) !== JSON.stringify(after) || !history.some((e) => e.txid === firstSend.txid)) throw new Error(JSON.stringify({ locked, before, after }));
  });
  await step('a wrong passphrase is refused and the right one unlocks', async () => {
    const wrong = await a.call('unlock', 'a', 'not it');
    value(await a.call('unlock', 'a', PASS));
    value(await a.call('lock', 'a'));
    const locked = value(await a.call('locked', 'a'));
    value(await a.call('unlock', 'a', PASS));
    if (wrong.code !== 'KEYSTORE_BAD_PASSPHRASE' || !locked) throw new Error(JSON.stringify({ wrong, locked }));
    return `wrong passphrase: ${wrong.code}`;
  });

  // A second tab on the same wallet.
  const b = await openTab();
  await step('a second tab cannot open the wallet while the first has it', async () => {
    const second = await b.call('open', 'b', 'w1');
    if (second.code !== 'STORE_LOCKED') throw new Error(JSON.stringify(second));
    return second.code;
  });
  await step('two tabs past the lock cannot sign with one XMSS index', async () => {
    const key = value(await a.call('addXmssKey', 'a'));
    await fund(key.address, parsePearl('2'));
    await regtest.mine(1);
    value(await a.call('sync', 'a'));
    value(await b.call('open', 'b', 'w1', { unlocked: true }));
    value(await b.call('unlock', 'b', PASS));
    value(await b.call('sync', 'b'));
    const [ra, rb] = await Promise.all([a.call('send', 'a', sink, 'max', { xmss: key.id }), b.call('send', 'b', sink, 'max', { xmss: key.id })]);
    const winners = [ra, rb].filter((r) => r.value);
    const losers = [ra, rb].filter((r) => r.error);
    if (winners.length !== 1 || losers.length !== 1) throw new Error(JSON.stringify({ ra, rb }));
    const mempool = await regtest.node.getRawMempool();
    if (!mempool.includes(winners[0].value.txid)) throw new Error('winner not in mempool');
    return `one sent, the other: ${losers[0].code} ${losers[0].error.slice(0, 90)}`;
  });
  await step('two tabs past the lock spending the same coins keep the send that went out', async () => {
    value(await a.call('sync', 'a'));
    value(await b.call('sync', 'b'));
    const [ra, rb] = await Promise.all([a.call('send', 'a', sink, 'max'), b.call('send', 'b', sink, 'max')]);
    const sent = [ra, rb].filter((r) => r.value).map((r) => r.value.txid);
    const mempool = await regtest.node.getRawMempool();
    value(await b.call('close', 'b'));
    value(await a.call('close', 'a'));
    // Reopen as one tab and look for every send pearld accepted.
    value(await a.call('open', 'a', 'w1'));
    value(await a.call('sync', 'a'));
    const history = value(await a.call('history', 'a'));
    const accepted = sent.filter((txid) => mempool.includes(txid));
    const lost = accepted.filter((txid) => !history.some((e) => e.txid === txid));
    if (lost.length > 0) throw new Error(`pearld holds ${lost.join(', ')} which the wallet lost; replies ${JSON.stringify({ ra: ra.error ?? 'sent', rb: rb.error ?? 'sent' })}`);
    return `sent ${sent.length} (${accepted.length} in mempool), replies a: ${ra.error ?? 'sent'}, b: ${rb.error ?? 'sent'}`;
  });

  // Kill a tab while it sends.
  await step('a tab killed mid-send leaves a wallet that opens, and sync finds the send if it went out', async () => {
    value(await a.call('unlock', 'a', PASS));
    await a.call('sendInBackground', 'a', sink, '0.25');
    await sleep(Number(process.env.KILL_AFTER_MS ?? 40));
    await chrome.cdp.send('Target.closeTarget', { targetId: a.targetId });
    await sleep(1000);
    const c = await openTab();
    const locked = value(await c.call('open', 'c', 'w1'));
    value(await c.call('sync', 'c'));
    const history = value(await c.call('history', 'c'));
    const mempool = await regtest.node.getRawMempool();
    const missing = mempool.filter((txid) => !history.some((e) => e.txid === txid));
    value(await c.call('close', 'c'));
    await chrome.cdp.send('Target.closeTarget', { targetId: c.targetId });
    if (!locked || missing.length > 0) throw new Error(`mempool txids the wallet does not know: ${missing.join(', ')}`);
    return `${history.length} history entries`;
  });

  // Site data cleared while the wallet is open.
  await step('site data cleared under an open wallet', async () => {
    const d = await openTab();
    value(await d.call('open', 'd', 'w1'));
    await d.send('Storage.clearDataForOrigin', { origin, storageTypes: 'indexeddb' });
    const after = await d.call('receive', 'd');
    // close() of a wallet whose store failed rejects without closing the store
    // (test/wallet-close-broken.test.ts), so the tab keeps the lock: reload to let it go.
    const closed = await d.call('close', 'd');
    await d.send('Page.reload');
    await sleep(500);
    await waitFor(d, 'globalThis.appReady === true ? true : null', 30_000);
    const reopened = await d.call('open', 'e', 'w1');
    await chrome.cdp.send('Target.closeTarget', { targetId: d.targetId });
    if (after.code !== 'STORE_UNAVAILABLE' || reopened.code !== 'WALLET_NOT_FOUND') throw new Error(JSON.stringify({ after, reopened }));
    return `next call: ${after.code}; close: ${closed.code ?? 'closed'}; reopen after reload: ${reopened.code}`;
  });

  // A quota too small for the next write.
  await step('a write past the quota', async () => {
    const q = await openTab();
    value(await q.call('openStore', 'quota'));
    value(await q.call('storeCall', 'set', 'small', 1));
    await q.send('Storage.overrideQuotaForOrigin', { origin, quotaSize: 1 });
    const big = await q.call('storeCall', 'set', 'big', 'x'.repeat(5_000_000));
    await q.send('Storage.overrideQuotaForOrigin', { origin });
    const read = await q.call('storeCall', 'get', 'small');
    await chrome.cdp.send('Target.closeTarget', { targetId: q.targetId });
    // Chrome 157 headless accepted a 5 MB write under a 1-byte override; the mapping is covered by test/store-indexeddb-versions.test.ts.
    if (!big.error) return 'skipped: the quota override did not refuse the write';
    if (big.code !== 'STORE_WRITE_FAILED' || read.value !== 1) throw new Error(JSON.stringify({ big, read }));
    return `${big.code ?? 'no code'}: ${big.error.slice(0, 120)}`;
  });

  // An incognito-like context: a browser context with its own storage, thrown away when closed.
  await step('a wallet in a private browser context', async () => {
    const { browserContextId } = await chrome.cdp.send('Target.createBrowserContext', { disposeOnDetach: true });
    const p = await openTab(browserContextId);
    value(await p.call('create', 'p', 'private', PASS));
    const addr = value(await p.call('receive', 'p'));
    value(await p.call('close', 'p'));
    const locked = value(await p.call('open', 'p', 'private'));
    await chrome.cdp.send('Target.disposeBrowserContext', { browserContextId });
    if (!locked || !addr) throw new Error('did not reopen');
  });

  // The database already at a later version, as a newer pearljs or another app on the origin would leave it.
  await step('a database at a later version', async () => {
    const v = await openTab();
    await v.evaluate(`new Promise((resolve, reject) => { const r = indexedDB.open('later', 2); r.onupgradeneeded = () => r.result.createObjectStore('entries'); r.onsuccess = () => { r.result.close(); resolve(true); }; r.onerror = () => reject(r.error); })`);
    const opened = await v.call('openStore', 'later');
    await chrome.cdp.send('Target.closeTarget', { targetId: v.targetId });
    if (opened.code !== 'STORE_INVALID') throw new Error(JSON.stringify(opened));
    return `${opened.code ?? 'no code'}: ${opened.error.slice(0, 120)}`;
  });

  await step('an open store does not block another tab upgrading the database', async () => {
    const s = await openTab();
    value(await s.call('openStore', 'upgrade'));
    const u = await openTab();
    const upgraded = await u.evaluate(`new Promise((resolve) => { const r = indexedDB.open('upgrade', 2); r.onupgradeneeded = () => {}; r.onsuccess = () => { r.result.close(); resolve('upgraded'); }; r.onblocked = () => resolve('blocked'); r.onerror = () => resolve(String(r.error)); setTimeout(() => resolve('no answer in 5 s'), 5000); })`);
    const afterwards = await s.call('storeCall', 'get', 'k');
    await chrome.cdp.send('Target.closeTarget', { targetId: s.targetId });
    await chrome.cdp.send('Target.closeTarget', { targetId: u.targetId });
    if (upgraded !== 'upgraded' || afterwards.code !== 'STORE_UNAVAILABLE') throw new Error(`the other tab's upgrade: ${upgraded}; the open store: ${JSON.stringify(afterwards)}`);
    return `the open store afterwards: ${afterwards.code ?? ''} ${afterwards.error ?? 'answered'}`;
  });
} finally {
  await chrome?.close();
  server?.close();
  await regtest.stop();
  rmSync(dir, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed} of ${results.length} passed`);
process.exit(failed ? 1 : 0);
