// Clean build: stale files from renamed modules must not end up in the package.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
rmSync(new URL('../dist', import.meta.url), { recursive: true, force: true });
const { status } = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], {
  cwd: new URL('..', import.meta.url),
  stdio: 'inherit',
});
if (status !== 0) process.exit(status ?? 1);
// pearljs/verify-proof reads these beside itself at run time; wasm/build.sh makes them.
cpSync(new URL('../src/verify-proof', import.meta.url), new URL('../dist/verify-proof', import.meta.url), { recursive: true });

// The `worker` build of `#secp256k1` (package.json "imports"): tiny-secp256k1
// with its WebAssembly inlined and instantiated synchronously. Its browser
// loader imports the module as an ES module, which bundlers turn into a
// top-level await, and a service worker refuses top-level await.
const require = createRequire(import.meta.url);
// The package root above a resolved file: neither package exports its package.json.
const root = (file) => (existsSync(join(file, 'package.json')) ? file : root(dirname(file)));
const secp = root(dirname(require.resolve('tiny-secp256k1')));
const loader = join(secp, 'lib', 'wasm_loader.browser.js');
const licence = (dir) => readFileSync(join(dir, 'LICENSE'), 'utf8').trim();
const tools = root(dirname(createRequire(join(secp, 'lib', 'index.js')).resolve('uint8array-tools')));
const { version } = JSON.parse(readFileSync(join(secp, 'package.json'), 'utf8'));
await build({
  entryPoints: [join(secp, 'lib', 'index.js')],
  outfile: fileURLToPath(new URL('../dist/secp256k1-worker.js', import.meta.url)),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  loader: { '.wasm': 'binary' },
  logLevel: 'warning',
  banner: { js: `/*\n * tiny-secp256k1 ${version} for workers, built by scripts/build.mjs.\n *\n * tiny-secp256k1:\n${licence(secp).replace(/^/gm, ' * ')}\n *\n * uint8array-tools:\n${licence(tools).replace(/^/gm, ' * ')}\n */` },
  plugins: [
    {
      name: 'sync-wasm-loader',
      setup(b) {
        b.onLoad({ filter: /wasm_loader\.browser\.js$/ }, (args) => {
          if (args.path !== loader) return undefined;
          return {
            resolveDir: dirname(loader),
            contents: [
              "import bytes from './secp256k1.wasm';",
              "import * as rand from './rand.browser.js';",
              "export default new WebAssembly.Instance(new WebAssembly.Module(bytes), { './rand.js': rand }).exports;",
            ].join('\n'),
          };
        });
      },
    },
  ],
});
