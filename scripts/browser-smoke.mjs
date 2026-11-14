// Bundles the packed package with Vite and runs it in headless Chrome against Pearl's
// vectors. Needs Chrome, so it is not part of `npm run check`. Set CHROME to use another binary.
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build, preview } from 'vite';
import wasm from 'vite-plugin-wasm';
import { promisify } from 'node:util';
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
writeFileSync(
  join(dir, 'index.html'),
  '<!doctype html><html><head><meta charset="utf-8"><title>pearljs</title></head><body><pre id="out">running</pre><script type="module" src="/main.js"></script></body></html>',
);

const config = {
  root: dir,
  logLevel: 'error',
  plugins: [wasm()],
  resolve: { alias: { 'pearl-vectors': join(dir, 'pearl-go.json') } },
  build: { target: 'esnext' },
};
await build(config);
// [::1] because that is where vite preview listens on this setup.
const server = await preview({ ...config, preview: { host: '::1', port: 0, strictPort: false } });
const url = server.resolvedUrls?.local[0] ?? `http://[::1]:${server.config.preview.port}/`;

let dom = '';
try {
  // Async, so the preview server in this process can answer while Chrome loads the page.
  ({ stdout: dom } = await promisify(execFile)(
    chrome,
    ['--headless=new', '--disable-gpu', '--no-first-run', '--virtual-time-budget=30000', '--dump-dom', url],
    { timeout: 90_000, maxBuffer: 16 * 1024 * 1024 },
  ));
} finally {
  await server.close();
}

const match = /<pre id="out">([\s\S]*?)<\/pre>/.exec(dom);
let results;
try {
  results = JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
} catch {
  console.error(`no results in page, got: ${match ? match[1].slice(0, 300) : dom.slice(0, 300)}`);
  process.exit(1);
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
