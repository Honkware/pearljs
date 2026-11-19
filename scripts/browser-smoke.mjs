// Bundles the packed package with Vite and runs it against Pearl's vectors in
// headless browsers. Needs a browser, so it is not part of `npm run check`.
//
//   BROWSERS=chrome,firefox,safari npm run test:browser   (default: chrome; also firefox-private)
//   npm run test:browser -- --serve                        builds, serves and prints the URL to open by hand
//
// CHROME and FIREFOX override the binaries. A browser that is not installed,
// or Safari before `safaridriver --enable`, is reported as skipped.
import { copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build, preview } from 'vite';
import wasm from 'vite-plugin-wasm';
import { binaries, launchers, waitFor } from './browser/drivers.mjs';
import { installTarball, pack, root } from './lib/pack.mjs';

const wanted = (process.env.BROWSERS ?? 'chrome').split(',').map((b) => b.trim()).filter(Boolean);
for (const name of wanted) if (!launchers[name]) throw new Error(`unknown browser ${name}; use chrome, firefox, firefox-private or safari`);
const serveOnly = process.argv.includes('--serve');

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
const server = await preview({ ...config, preview: { host: '127.0.0.1', port: 0, strictPort: false } });
const url = server.resolvedUrls?.local[0] ?? `http://127.0.0.1:${server.config.preview.port}/`;
if (serveOnly) {
  console.log(`open ${url} in the browser to check; the page lists every check and its result. Ctrl-C stops the server.`);
  await new Promise(() => undefined);
}

let bad = 0;
let ran = 0;
try {
  for (const name of wanted) {
    if (!binaries[name]()) {
      console.log(`skipped ${name}: not installed`);
      continue;
    }
    let browser;
    try {
      browser = await launchers[name]();
    } catch (error) {
      console.log(`skipped ${name}: ${error.message}`);
      continue;
    }
    ran++;
    try {
      // Proof verification runs for seconds of real time; the page sets globalThis.__pearljs when it is done.
      await browser.open(url);
      const results = JSON.parse(await waitFor(browser, 'globalThis.__pearljs === undefined ? null : JSON.stringify(globalThis.__pearljs)'));
      console.log(`${browser.version}`);
      for (const [check, outcome] of Object.entries(results)) {
        console.log(`  ${outcome === 'pass' ? 'ok  ' : 'FAIL'} ${check}${outcome === 'pass' ? '' : `: ${outcome}`}`);
        if (outcome !== 'pass') bad++;
      }
      if (Object.keys(results).length === 0) bad++;
    } catch (error) {
      console.log(`FAIL ${name}: ${error.message}`);
      bad++;
    } finally {
      await browser.close();
    }
  }
} finally {
  await server.close();
}
if (bad || ran === 0) {
  console.error(ran === 0 ? 'no browser ran' : `${bad} browser check(s) failed`);
  process.exit(1);
}
console.log(`browser smoke passed in ${ran} browser(s)`);
