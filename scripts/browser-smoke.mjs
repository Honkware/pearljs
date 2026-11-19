// Bundles the packed package with Vite and runs it in headless Chrome against Pearl's
// vectors. Needs Chrome, so it is not part of `npm run check`. Set CHROME to use another binary.
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket } from 'undici';
import { build, preview } from 'vite';
import wasm from 'vite-plugin-wasm';
import { installTarball, pack, root } from './lib/pack.mjs';

const candidates = [
  process.env.CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
].filter(Boolean);
const chrome = candidates.find((c) => existsSync(c));
if (!chrome) {
  console.log('skipped: Chrome not found (set CHROME to its path)');
  process.exit(0);
}

const { tarball } = pack();
const dir = installTarball(tarball, 'browser');
copyFileSync(join(root, 'scripts/browser/main.js'), join(dir, 'main.js'));
copyFileSync(join(root, 'vectors/pearl-go.json'), join(dir, 'pearl-go.json'));
copyFileSync(join(root, 'vectors/mining/proofs.json'), join(dir, 'proofs.json'));
writeFileSync(
  join(dir, 'index.html'),
  '<!doctype html><html><head><meta charset="utf-8"><title>pearljs</title></head><body><pre id="out">running</pre><script type="module" src="/main.js"></script></body></html>',
);

const config = {
  root: dir,
  logLevel: 'error',
  plugins: [wasm()],
  resolve: { alias: { 'pearl-vectors': join(dir, 'pearl-go.json'), 'pearl-proof-vectors': join(dir, 'proofs.json') } },
  build: { target: 'esnext' },
};
await build(config);
// [::1] because that is where vite preview listens on this setup.
const server = await preview({ ...config, preview: { host: '::1', port: 0, strictPort: false } });
const url = server.resolvedUrls?.local[0] ?? `http://[::1]:${server.config.preview.port}/`;

// The page reports through window.__pearljs, read over the DevTools protocol once it is set:
// proof verification runs for seconds of real time, which --dump-dom's virtual clock does not wait for.
const profile = mkdtempSync(join(tmpdir(), 'pearljs-chrome-'));
const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, url], { stdio: 'ignore' });
let results;
try {
  results = await pageResults();
} finally {
  const exited = new Promise((resolve) => browser.once('exit', resolve));
  browser.kill();
  await exited;
  await server.close();
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}

async function pageResults() {
  const deadline = Date.now() + 120_000;
  let port;
  while (!port) {
    if (Date.now() > deadline) throw new Error('Chrome did not open its DevTools port');
    await sleep(200);
    try {
      port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
    } catch {
      // Not written yet.
    }
  }
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let id = 0;
  const evaluate = (expression) =>
    new Promise((resolve) => {
      const mine = ++id;
      socket.onmessage = (event) => {
        const reply = JSON.parse(event.data);
        if (reply.id === mine) resolve(reply.result?.result?.value);
      };
      socket.send(JSON.stringify({ id: mine, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    });
  try {
    while (Date.now() < deadline) {
      const value = await evaluate('window.__pearljs === undefined ? null : JSON.stringify(window.__pearljs)');
      if (value) return JSON.parse(value);
      await sleep(250);
    }
    console.error(`no results in page, got: ${String(await evaluate('document.body.innerText')).slice(0, 300)}`);
    process.exit(1);
  } finally {
    socket.close();
  }
}

let bad = 0;
for (const [name, outcome] of Object.entries(results)) {
  console.log(`${outcome === 'pass' ? 'ok  ' : 'FAIL'} ${name}${outcome === 'pass' ? '' : `: ${outcome}`}`);
  if (outcome !== 'pass') bad++;
}
if (bad || Object.keys(results).length === 0) {
  console.error(`${bad} browser check(s) failed`);
  process.exit(1);
}
console.log(`browser smoke passed (${Object.keys(results).length} checks)`);
