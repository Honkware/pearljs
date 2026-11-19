// The `worker` export condition: a bundle built with it instantiates the
// secp256k1 WebAssembly synchronously from bytes inside the bundle, so it
// needs no WebAssembly loader plugin and has no top-level await, which a
// service worker refuses. esbuild's iife format stands in for the worker:
// it refuses top-level await as a classic script would. Without the
// condition the default build, which imports the module as an ES module,
// is what a bundler gets. Needs dist/ (npm run build runs before the tests in
// npm run check).

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { afterAll, describe, expect, it } from 'vitest';
import vectors from '../vectors/pearl-go.json' with { type: 'json' };

const root = fileURLToPath(new URL('..', import.meta.url));
const out = fileURLToPath(new URL('../node_modules/.cache/pearljs-worker-condition/', import.meta.url));
mkdirSync(out, { recursive: true });
afterAll(() => rmSync(out, { recursive: true, force: true }));

const { seed, children } = vectors.bip86;
const program = `
  import { deriveAccountFromSeed } from './src/keys.ts';
  import { mainnet } from './src/networks.ts';
  globalThis.address = deriveAccountFromSeed(Uint8Array.from(${JSON.stringify(seed)}.match(/../g), (b) => parseInt(b, 16)), mainnet).deriveAddress(0);
`;

const bundle = (conditions: string[]) =>
  build({
    stdin: { contents: program, resolveDir: root, loader: 'ts' },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    conditions,
    logLevel: 'silent',
  });

describe('the worker condition', () => {
  it('bundles key derivation with no WebAssembly loader and no top-level await, and derives Pearl\'s vector address', async () => {
    expect(existsSync(new URL('../dist/secp256k1-worker.js', import.meta.url))).toBe(true);
    const result = await bundle(['worker']);
    const code = result.outputFiles[0]!.text;
    const context: Record<string, unknown> = { WebAssembly, crypto, TextEncoder, TextDecoder, atob, Uint8Array };
    runInNewContext(code, context);
    expect(context.address).toBe(children[0]!.address);
  });

  it('leaves the default build importing the module as an ES module', async () => {
    await expect(bundle([])).rejects.toThrow(/No loader is configured for "\.wasm" files/);
  });
});
