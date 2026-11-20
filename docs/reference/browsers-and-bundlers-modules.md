# Browser and bundler reference

## Bundler versions

| Bundler (version run) | For the secp256k1 module | For the verifier's files |
| --- | --- | --- |
| Vite 7.3.8, `vite build` | `vite-plugin-wasm` | nothing |
| Vite 7.3.8, dev server | `vite-plugin-wasm` | `optimizeDeps` ([Vite](../guides/browsers-and-bundlers.md#vite)) |
| webpack 5.112.2 | nothing | nothing |
| webpack 5.98.0 | `experiments.asyncWebAssembly` | nothing |
| esbuild 0.28.2 | `esbuild-plugin-wasm` | copy the four files beside the bundle |
| Rollup 4.68.7 | node-resolve, commonjs, a loader plugin | copy the four files beside the bundle |
| Parcel 2.16.4 | package exports on, a loader alias | nothing |
| Next.js 16.4.6, Turbopack (client component and route handler, build and dev) | nothing | nothing |
| Next.js 16.4.6, `--webpack` | `experiments.asyncWebAssembly` | client component: nothing; route handler: `serverExternalPackages` |
| esbuild 0.28.2, an extension's service worker | `conditions: ['worker']` ([Build a browser extension](../guides/browsers-and-bundlers-extensions.md)) | copy the four files beside the bundle |
| webpack 5.112.2, `target: 'webworker'` | nothing | not run |

None of the bundles contained `pearljs/testing`, the regtest launcher, the file stores, `pearljs/tls-fetch` or an import of a `node:` module. The wallet code without the verifier minifies to about 280 to 300 kB of JavaScript (87 to 95 kB gzipped), plus the 1.2 MB secp256k1 module.

## Bundler configurations

### webpack

webpack 5.112 needs no configuration, because `experiments.asyncWebAssembly` is on by default there. Older webpack 5 releases (5.98 was tested) need the experiment turned on. Both emit the verifier's files:

```js
// webpack.config.js, webpack before 5.112
export default {
  experiments: { asyncWebAssembly: true },
};
```

### esbuild

esbuild loads `.wasm` imports through a plugin, here esbuild-plugin-wasm, with the `esm` format. It leaves `new URL(..., import.meta.url)` as it is, so copy the verifier's files into `verify-proof/` beside the bundle:

```js
// build.mjs
import { cpSync } from 'node:fs';
import { build } from 'esbuild';
import { wasmLoader } from 'esbuild-plugin-wasm';

await build({ entryPoints: ['src/main.js'], bundle: true, format: 'esm', outdir: 'dist', plugins: [wasmLoader()] });
for (const file of ['verifier.wasm', 'v1-cache.bin', 'v2-cache.bin', 'v4-cache.bin']) cpSync(`node_modules/pearljs/dist/verify-proof/${file}`, `dist/verify-proof/${file}`);
```

### Rollup

Rollup needs node-resolve with the browser condition, commonjs for bech32, and a loader for WebAssembly ES modules. The loader is a short plugin, and a second one copies the verifier's files:

```js
// rollup.config.js
import { cpSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import commonjs from '@rollup/plugin-commonjs';
import { nodeResolve } from '@rollup/plugin-node-resolve';

function wasmModules() {
  return {
    name: 'wasm-modules',
    async load(id) {
      if (!id.endsWith('.wasm')) return null;
      const bytes = await readFile(id);
      const module = await WebAssembly.compile(bytes);
      const ref = this.emitFile({ type: 'asset', name: basename(id), source: bytes });
      const from = [...new Set(WebAssembly.Module.imports(module).map((i) => i.module))];
      return [
        ...from.map((f, i) => `import * as m${i} from ${JSON.stringify(f)};`),
        `const bytes = await (await fetch(import.meta.ROLLUP_FILE_URL_${ref})).arrayBuffer();`,
        `const { instance } = await WebAssembly.instantiate(bytes, { ${from.map((f, i) => `${JSON.stringify(f)}: m${i}`).join(', ')} });`,
        ...WebAssembly.Module.exports(module).map((e) => `export const ${e.name} = instance.exports.${e.name};`),
      ].join('\n');
    },
  };
}

export default {
  input: 'src/main.js',
  output: { dir: 'dist', format: 'es' },
  plugins: [
    nodeResolve({ browser: true }),
    commonjs(),
    wasmModules(),
    { name: 'verifier-files', writeBundle: () => ['verifier.wasm', 'v1-cache.bin', 'v2-cache.bin', 'v4-cache.bin'].forEach((file) => cpSync(`node_modules/pearljs/dist/verify-proof/${file}`, `dist/verify-proof/${file}`)) },
  ],
};
```

### Parcel

Parcel resolves subpaths such as `pearljs/verify-proof` only with package exports turned on, and without them it also resolves tiny-secp256k1 to its CommonJS build, which requires Node's `crypto`, `fs` and `path`. Parcel has no loader for WebAssembly ES modules, so replace tiny-secp256k1's loader file with one that fetches the module. In `package.json`:

```json
{
  "@parcel/resolver-default": { "packageExports": true },
  "alias": { "./node_modules/tiny-secp256k1/lib/wasm_loader.browser.js": "./src/secp-loader.js" }
}
```

The replacement loader fetches the module and instantiates it with the `./rand.js` import it expects:

```js
// src/secp-loader.js
import * as rand from '../node_modules/tiny-secp256k1/lib/rand.browser.js';

const bytes = await (await fetch(new URL('../node_modules/tiny-secp256k1/lib/secp256k1.wasm', import.meta.url))).arrayBuffer();
const { instance } = await WebAssembly.instantiate(bytes, { './rand.js': rand });
export default instance.exports;
```

Parcel emits the verifier's files by itself.

### Next.js

With Turbopack, the default in Next.js 16, pearljs and its verifier need no configuration, in a client component or a route handler, under `next build` and `next dev`.

With `next build --webpack`, turn on the WebAssembly experiment, and a client component then verifies proofs with nothing more. A route handler needs one more setting, because webpack's server build turns the verifier's URLs into paths under `/_next/static/media/` that the handler can't fetch. Mark pearljs as an external package so the server loads it from `node_modules` as Node does:

```js
// next.config.mjs, webpack
export default {
  serverExternalPackages: ['pearljs'],
  webpack(config) {
    config.experiments = { ...config.experiments, asyncWebAssembly: true };
    return config;
  },
};
```

## Checking the bundles

`npm run verify:pack` checks this with esbuild. It imports one function from each of `pearljs`, `pearljs/amount`, `pearljs/address`, `pearljs/rpc`, `pearljs/block`, `pearljs/xmss`, `pearljs/policy` and `pearljs/mnemonic`, and each must bundle without the secp256k1 WebAssembly module.

## Node access from a page

### Limited user's methods

pearld's `rpcLimited` list, exported as `PEARLD_LIMITED_METHODS`, covers reading blocks, filters, transactions, the mempool's txids, fee estimates and address searches, and subscribing to notifications. It leaves out `sendrawtransaction`, `gettxspendingprevout`, `getblockchaininfo`, `getmempoolinfo`, `testmempoolaccept` and the `stopnotify` commands.

As the limited user, `pearldBackend` reads the tip with `getbestblock` and finds mempool spends through the address index when `gettxspendingprevout` is refused. If a broadcast is refused, it throws an `UnsupportedMethodError` (`BACKEND_UNSUPPORTED`) that names `sendrawtransaction`.

### Blockbook from a page

A page can also read the chain from Pearl's public Blockbook. Its REST API sends no CORS headers, so `BlockbookClient` can't reach it from a page on another origin, but its websocket accepts connections from any origin, so `BlockbookWsClient` can. `blockbookBackend` over a `BlockbookWsClient` gives a page a wallet backend that makes no REST requests, with blocks left unverified ([Use the Blockbook client](../guides/blockbook-client.md)). A browser extension with `host_permissions` for the server can use both clients.

### pearld's endpoints from a browser

The setup above follows from how pearld's RPC server treats a browser, all of which is in pearld's `node/rpcserver.go`:

- The HTTP endpoint sends no CORS headers and asks for Basic auth on every request, including the browser's preflight `OPTIONS`, which gets a 401. A page on another origin therefore can't call it with `fetch` at all.
- The websocket endpoint, `/ws`, accepts any Origin and lets a client log in after the upgrade with the `authenticate` command, which is how `PearlWsClient` logs in by default. A page can connect to it directly.
- `--rpclimituser` and `--rpclimitpass` create a second user that may call only the methods in `rpcLimited` (lines 261 to 301).

### Setups

| Setup | Reads | Broadcast | Node needs |
| --- | --- | --- | --- |
| Page to pearld's websocket as the limited user, plus a broadcast proxy | `pearldBackend` over `PearlWsClient` | the proxy, through the backend's `broadcast` option | `--rpclimituser`, `--addrindex`, a certificate the browser trusts |
| The same, on a node without the address index | `filterBackend` over `PearlWsClient`, with an IndexedDB store | the proxy, through the backend's `broadcast` option | `--rpclimituser`, the filter index (on by default), a certificate the browser trusts |
| Page to a same-origin proxy for every call | `pearldBackend` over `PearldClient` | the proxy | nothing more; the proxy holds the credentials and chooses the methods |
| Page to pearld's HTTP port | does not work | does not work | pearld would need CORS, which it does not have |

## Extensions

pearljs uses no `eval`, `new Function`, XMLHttpRequest, `window`, `document` or `localStorage`, so it fits inside a service worker. It uses these, all of which a worker has:

- `fetch` and `WebSocket`;
- `crypto.subtle` and `crypto.getRandomValues`;
- `indexedDB`;
- `navigator.locks`.

Firefox runs an MV3 extension's background as an event page instead, declared as `"background": { "scripts": ["background.js"], "type": "module" }`. An event page is a document, and the same bundle runs there.

## Node-only modules

| Module | Holds |
| --- | --- |
| `pearljs/xmss-file-store` | The file-backed XMSS index store |
| `pearljs/store-file` | The file-backed wallet store |
| `pearljs/tls-fetch` | `pearldFetch` |
| `pearljs/testing-regtest` | `startRegtest` |

These import Node built-ins. The main entry does not re-export them, nor `pearljs/testing`, so a browser bundle never sees them unless you import one by name.

## The worker condition

pearljs has a second build of tiny-secp256k1's WebAssembly module for workers, chosen by the `worker` resolution condition (through `#secp256k1` in its package.json `imports`).

- In it the WebAssembly bytes sit inside the JavaScript and are instantiated synchronously, which a worker is allowed to do.
- It adds about 1.7 MB to the worker bundle in place of the separate 1.2 MB `.wasm` file.
- The default build is unchanged, and Node never sets the condition.
- webpack sets the condition itself for `target: 'webworker'`.

## Module format and types

The package is ESM only. Use `import`, or `require()` on Node 20.19 and 22.12 or newer, where it loads ES modules without a flag.

Types resolve under `moduleResolution` `node16`, `nodenext` and `bundler`, not the legacy `node10`. Under `node10` TypeScript cannot find the subpaths.

A CommonJS project can `require('pearljs')` and any subpath, including `pearljs/keys`, which loads WebAssembly, and `pearljs/xmss`. `npm run verify:pack` installs the packed tarball into such a project and runs both on every Node version in the supported range installed on the machine.

In TypeScript, set `module` to `node20` or `nodenext`. `node16` is older than `require()` of ES modules and reports error TS1479 for every import of the package from a CommonJS file. Use `import()` there, or one of the other two settings.
