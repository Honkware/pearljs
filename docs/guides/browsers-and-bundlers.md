# Bundle pearljs for a browser

pearljs runs in browsers as well as Node, and it needs no `Buffer` global. A web page needs three things from its bundler: to import only the modules the page uses, to load the WebAssembly that signing depends on, and to serve the proof verifier's files. Each common bundler has its own configuration for them.

A page also needs a way to reach a node. It can't call pearld's HTTP RPC, but it can use pearld's websocket, and [Reach a node from a page](browsers-and-bundlers-node-access.md) sets that up.

## Import only what a page needs

`import ... from 'pearljs'` reaches everything. Each module is also a subpath named after its file in `src/`, such as `pearljs/amount`, `pearljs/address`, `pearljs/networks`, `pearljs/rpc`, `pearljs/block`, `pearljs/blockheader`, `pearljs/xmss`, `pearljs/policy`, `pearljs/mnemonic` and `pearljs/keys`. A page that only formats amounts and checks addresses can import just those, so the signing code never loads:

```ts run
import { isValidAddress } from 'pearljs/address';
import { formatPearl, parsePearl } from 'pearljs/amount';
import { networks } from 'pearljs/networks';

console.log(formatPearl(parsePearl('0.1') * 3n)); // "0.3", exactly
console.log(isValidAddress('prl1pr6yuq8u2r95wjzzgpdy8cpnncpl7l8zgy6x5q0367pnc53s2famqg7pt74', networks.mainnet)); // true
```

The package is marked side-effect free, so a bundler that tree-shakes also drops the unused parts of the main entry. In Node, or with a bundler that does not tree-shake, the main entry loads every module.

The modules that use Node built-ins are the two file stores, the TLS fetch and the regtest launcher, and the main entry leaves them out ([Node-only modules](../reference/browsers-and-bundlers-modules.md#node-only-modules)), so a browser bundle only contains them if the page imports one by name.

## Load the WebAssembly

Modules that sign, derive keys or build Taproot addresses load the secp256k1 code, which is WebAssembly. These include `pearljs/keys`, `pearljs/payments`, `pearljs/scriptpath`, `pearljs/scripttree`, `pearljs/transaction`, `pearljs/message`, `pearljs/wif`, `pearljs/sweep`, and the modules built on them, such as `pearljs/builder`.

The WebAssembly comes from tiny-secp256k1, which imports it as an ES module (`import * as wasm from './secp256k1.wasm'`, following the WebAssembly ESM integration proposal) and gives it one import, `./rand.js`. The bundler has to know how to load that kind of import, and [Configure your bundler](#configure-your-bundler) shows how for each one.

XMSS is plain TypeScript and needs no WebAssembly. Generating an XMSS key takes most of a second, though, so run it in a worker if the page must stay responsive meanwhile.

## Serve the verifier's files

`pearljs/verify-proof` loads a second WebAssembly module and its circuit caches the first time it verifies, from `verify-proof/` beside its own module. It names each file with `new URL('./verify-proof/<file>', import.meta.url)`, which Vite, webpack, Parcel and Next.js recognise, so they emit those four files and nothing else from that directory. Whatever serves the files, the verifier checks each one's SHA-256 against the digest pinned in the package before using it.

esbuild and Rollup leave the URL as it is, so with those the files have to sit in `verify-proof/` beside the bundle. If the page serves them from somewhere else, name the location once, before the first verification:

```ts fragment
import { loadProofVerifier } from 'pearljs/verify-proof';

await loadProofVerifier([3, 4], { locate: (asset) => new URL(`/verify-proof/${asset}`, location.href) });
```

## Configure your bundler

Each bundler needs at most two things: a way to load the secp256k1 WebAssembly module, and, where it leaves `new URL(...)` alone, a copy of the verifier's four files. webpack 5.112 and Next.js with Turbopack need neither. [Bundler versions](../reference/browsers-and-bundlers-modules.md#bundler-versions) lists the versions tested and what each one needs, and [Bundler configurations](../reference/browsers-and-bundlers-modules.md#bundler-configurations) has the setup for webpack, esbuild, Rollup, Parcel and Next.js. Vite is shown here.

### Vite

Add vite-plugin-wasm:

```js
// vite.config.js
import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';

export default defineConfig({
  plugins: [wasm()],
});
```

The default build target accepts the top-level await that vite-plugin-wasm emits, and `vite build` emits the verifier's files by itself.

The dev server is different, because it prebundles dependencies into `node_modules/.vite/deps/`, where the verifier's URLs point at files that are not there. The server then sends something else in their place, and the digest check refuses it. For `vite dev`, keep the verifier out of prebundling, which also means listing bech32, a CommonJS dependency, for prebundling by name:

```js
// vite.config.js, for the dev server
optimizeDeps: { exclude: ['pearljs/verify-proof'], include: ['pearljs > bech32'] },
```

## Next steps

- [Reach a node from a page](browsers-and-bundlers-node-access.md)
- [Build a browser extension](browsers-and-bundlers-extensions.md)
- [Keys in a page](../concepts/browsers-and-bundlers-keys.md)
- [Browser and bundler reference](../reference/browsers-and-bundlers-modules.md)
