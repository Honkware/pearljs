// Packs the package, installs the tarball into a fresh project and checks what a
// consumer sees: file list, links between the packed documents, export map, Node ESM and require(), types under
// nodenext and bundler resolution, tree shaking, publint and attw.
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { build } from 'esbuild';
import { installTarball, pack, root, run } from './lib/pack.mjs';

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const failures = [];
const parts = (v) => v.split('.').map(Number);
const compareVersions = (a, b) => {
  const [x, y] = [parts(a.replace(/^v/, '')), parts(b.replace(/^v/, ''))];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};
// The engines range is "^A.B.C || >=D.E.F", the only shapes pearljs uses.
const satisfies = (v, range) =>
  range.split('||').some((r) => {
    const m = /^\s*([\^>=]+)(\d+\.\d+\.\d+)\s*$/.exec(r);
    if (!m) return false;
    const c = compareVersions(v, m[2]);
    return m[1] === '^' ? c >= 0 && parts(v)[0] === parts(m[2])[0] : c >= 0;
  });
const fail = (msg) => {
  failures.push(msg);
  console.error(`FAIL ${msg}`);
};
const ok = (msg) => console.log(`ok   ${msg}`);

// 1. Every module the barrel re-exports has a subpath, and every target is packed.
const barrel = readFileSync(join(root, 'src/index.ts'), 'utf8');
const modules = [...barrel.matchAll(/from '\.\/(\w+)\.js'/g)].map((m) => m[1]);
for (const m of modules) {
  if (!pkg.exports[`./${m}`]) fail(`src/index.ts re-exports ${m} but package.json has no ./${m} subpath`);
}
const { dir: packDir, tarball, files } = pack();
// The guides and examples ship, since the README links to them; the generated API reference does not.
const allowed = /^(dist\/.+|docs\/[\w-]+\.md|examples\/.+\.ts|package\.json|README\.md|CHANGELOG\.md|CONTRIBUTING\.md|SECURITY\.md|LICENSE|NOTICE)$/;
for (const f of files) if (!allowed.test(f)) fail(`unexpected file in package: ${f}`);
for (const f of ['README.md', 'LICENSE', 'NOTICE', 'CHANGELOG.md', 'docs/README.md', 'dist/index.js', 'dist/index.d.ts']) {
  if (!files.includes(f)) fail(`missing from package: ${f}`);
}
// Every relative link in a packed Markdown file leads to a packed file or directory.
for (const f of files.filter((name) => name.endsWith('.md'))) {
  const text = readFileSync(join(root, f), 'utf8').replace(/```[\s\S]*?```/g, '');
  for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const path = join(f, '..', target.split('#')[0]).replace(/\\/g, '/');
    if (!files.includes(path) && !files.some((name) => name.startsWith(`${path}/`))) fail(`${f} links to ${target}, which is not packed`);
  }
}
const mapSources = files.filter((f) => f.endsWith('.map'));
for (const f of mapSources) {
  const map = JSON.parse(readFileSync(join(root, f), 'utf8'));
  if (!map.sourcesContent || map.sourcesContent.some((c) => c == null)) fail(`${f} does not embed its sources`);
}
for (const [sub, target] of Object.entries(pkg.exports)) {
  if (typeof target === 'string') continue;
  for (const t of Object.values(target)) {
    if (!files.includes(t.replace(/^\.\//, ''))) fail(`export ${sub} points at ${t}, which is not packed`);
  }
}
ok(`${files.length} files packed, ${(JSON.parse(run('npm', ['pack', '--dry-run', '--json'], { cwd: root }))[0].size / 1024).toFixed(0)} kB`);

// 2. Install the tarball into a fresh project.
const dir = installTarball(tarball);
const specs = ['pearljs', ...Object.keys(pkg.exports).filter((s) => s !== '.' && s !== './package.json').map((s) => `pearljs/${s.slice(2)}`)];

// 3. Node ESM import of every subpath, and require().
writeFileSync(
  join(dir, 'esm.mjs'),
  `const specs = ${JSON.stringify(specs)};
for (const s of specs) {
  await import(s);
}
const root = await import('pearljs');
for (const [name, value] of Object.entries(root)) if (value === undefined) throw new Error(name + ' is undefined');
console.log('esm', specs.length, 'specifiers,', Object.keys(root).length, 'root exports');
`,
);
try {
  process.stdout.write(run(process.execPath, ['esm.mjs'], { cwd: dir }));
  ok('Node ESM import of every subpath');
} catch {
  fail('Node ESM import');
}
writeFileSync(
  join(dir, 'cjs.cjs'),
  `const p = require('pearljs');
const a = require('pearljs/amount');
if (typeof p.parsePearl !== 'function' || p.parsePearl !== a.parsePearl) throw new Error('require(esm) mismatch');
// keys loads the WebAssembly secp256k1; xmss runs the pure hash-based signer.
const keys = require('pearljs/keys');
const xmss = require('pearljs/xmss');
const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const account = keys.deriveAccountFromSeed(p.mnemonicToSeed(mnemonic), p.networks.mainnet);
if (!account) throw new Error('no account');
const seeds = xmss.generateXmssSeeds();
const pair = xmss.xmssKeygen(seeds.privateSeed, seeds.publicSeed);
const message = new Uint8Array(32).fill(7);
const sig = xmss.xmssSign(pair.secretKey, 0, message);
if (!xmss.xmssVerify(pair.publicKey, message, sig)) throw new Error('xmss round trip failed');
console.log('require(esm) ok on', process.version);
`,
);
// Node versions to try, from nvm, when they satisfy the engines range.
const nodes = [process.execPath];
try {
  const nvmDir = process.env.NVM_DIR ?? join(homedir(), '.nvm');
  const eligible = readdirSync(join(nvmDir, 'versions/node'))
    .filter((v) => /^v\d+\.\d+\.\d+$/.test(v) && satisfies(v.slice(1), pkg.engines.node))
    .sort((x, y) => compareVersions(x, y));
  for (const v of [eligible[0], eligible.at(-1)]) {
    const bin = join(nvmDir, 'versions/node', v, 'bin/node');
    if (v && !nodes.includes(bin) && existsSync(bin) && `v${process.versions.node}` !== v) nodes.push(bin);
  }
} catch {
  // No nvm: the running Node is the only one checked.
}
for (const node of nodes) {
  try {
    process.stdout.write(run(node, ['cjs.cjs'], { cwd: dir }));
    ok(`require() of the ESM package, keys (WebAssembly) and xmss under ${node === process.execPath ? 'the running Node' : node}`);
  } catch {
    fail(`require() of the ESM package under ${node}`);
  }
}

// A TypeScript CommonJS project under node16 resolution.
mkdirSync(join(dir, 'cjs-ts'), { recursive: true });
writeFileSync(join(dir, 'cjs-ts/package.json'), JSON.stringify({ type: 'commonjs' }));
writeFileSync(
  join(dir, 'cjs-ts/index.ts'),
  `import { parsePearl, networks } from 'pearljs';
import { xmssVerify } from 'pearljs/xmss';
import { deriveAccountFromSeed } from 'pearljs/keys';
const grain: bigint = parsePearl('1');
const net: string = networks.mainnet.bech32Hrp;
export { grain, net, xmssVerify, deriveAccountFromSeed };
`,
);
// TypeScript's node16 mode predates require(esm) and reports TS1479 for any import of an ES module from a
// CommonJS file; node20 and nodenext model it. The package must typecheck under the latter two, and node16 must
// report that one diagnostic and no other.
for (const [name, mode] of [['node20', 'Node20'], ['nodenext', 'NodeNext'], ['node16', 'Node16']]) {
  writeFileSync(
    join(dir, `cjs-ts/tsconfig.${name}.json`),
    JSON.stringify({ compilerOptions: { module: mode, ...(name === 'node20' ? {} : { moduleResolution: mode }), target: 'ES2022', strict: true, noEmit: true, types: [], skipLibCheck: false }, include: ['index.ts'] }),
  );
  let output = '';
  try {
    run(process.execPath, [tsc, '-p', `cjs-ts/tsconfig.${name}.json`], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    output = String(e.stdout ?? '');
  }
  const codes = [...output.matchAll(/error (TS\d+)/g)].map((m) => m[1]);
  if (name === 'node16' ? codes.length > 0 && codes.every((c) => c === 'TS1479') : codes.length === 0) {
    ok(name === 'node16' ? 'node16 reports only TS1479 for a CommonJS import (TypeScript predates require(esm))' : `types resolve in a CommonJS project under ${name}`);
  } else fail(`types in a CommonJS project under ${name}: ${output}`);
}

// 4. Types under nodenext and bundler resolution, with lib checking on.
writeFileSync(
  join(dir, 'src/types.ts'),
  `import { parsePearl, networks, mnemonicToSeed, type PearlNetwork } from 'pearljs';
${modules.map((m, i) => `import * as m${i} from 'pearljs/${m}';`).join('\n')}
const n: PearlNetwork = networks.mainnet;
const grain: bigint = parsePearl('1');
const seed: Uint8Array = mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
export { n, grain, seed, ${modules.map((_, i) => `m${i}`).join(', ')} };
`,
);
for (const [name, moduleResolution, module] of [
  ['nodenext', 'NodeNext', 'NodeNext'],
  ['bundler', 'Bundler', 'ESNext'],
]) {
  writeFileSync(
    join(dir, `tsconfig.${name}.json`),
    JSON.stringify({
      compilerOptions: { module, moduleResolution, target: 'ES2022', strict: true, noEmit: true, types: [], skipLibCheck: false },
      include: ['src'],
    }),
  );
  try {
    run(process.execPath, [tsc, '-p', `tsconfig.${name}.json`], { cwd: dir });
    ok(`types resolve under ${name}`);
  } catch {
    fail(`types under ${name}`);
  }
}

// 5. Tree shaking: light entry points must not pull in tiny-secp256k1.
const light = ['pearljs', 'pearljs/amount', 'pearljs/address', 'pearljs/rpc', 'pearljs/block', 'pearljs/xmss', 'pearljs/policy', 'pearljs/mnemonic', 'pearljs/keys'];
const names = { pearljs: 'parsePearl', 'pearljs/amount': 'parsePearl', 'pearljs/address': 'decodeAddress', 'pearljs/rpc': 'PearldClient', 'pearljs/block': 'parseBlock', 'pearljs/xmss': 'xmssVerify', 'pearljs/policy': 'estimateVsize', 'pearljs/mnemonic': 'generateMnemonic', 'pearljs/keys': 'deriveAccountFromSeed' };
for (const spec of light) {
  const entry = join(dir, 'src/light.js');
  writeFileSync(entry, `import { ${names[spec]} } from '${spec}';\nconsole.log(${names[spec]});\n`);
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    metafile: true,
    format: 'esm',
    platform: 'browser',
    loader: { '.wasm': 'empty' },
    logLevel: 'silent',
    absWorkingDir: dir,
  }).catch((e) => ({ errors: [e] }));
  if (result.errors?.length) {
    fail(`bundling ${spec}: ${result.errors[0].message ?? result.errors[0]}`);
    continue;
  }
  // Modules parsed but fully tree-shaken have no bytes in the output.
  const [output] = Object.values(result.metafile.outputs);
  const inputs = Object.entries(output.inputs).filter(([, v]) => v.bytesInOutput > 0).map(([k]) => k);
  const secp = inputs.filter((i) => i.includes('tiny-secp256k1'));
  if (spec === 'pearljs/keys') {
    // Control: the check must be able to see tiny-secp256k1 when it is used.
    if (secp.length) ok('control: pearljs/keys does include tiny-secp256k1');
    else fail('tree-shake check cannot see tiny-secp256k1 in pearljs/keys');
  } else if (secp.length) fail(`${spec} (${names[spec]}) pulls in tiny-secp256k1`);
  else ok(`${spec} bundles without tiny-secp256k1 (${inputs.length} modules)`);
}
rmSync(join(dir, 'src/light.js'));

// 6. publint and attw on the tarball.
if (process.env.PEARLJS_SKIP_LINT_TOOLS) {
  console.log('skip publint and attw (PEARLJS_SKIP_LINT_TOOLS set)');
} else {
  for (const [name, args] of [
    ['publint', ['--yes', 'publint@0.3.25', '--strict', tarball]],
    ['attw', ['--yes', '@arethetypeswrong/cli@0.18.5', '--profile', 'esm-only', tarball]],
  ]) {
    try {
      run(npx, args, { cwd: packDir });
      ok(name);
    } catch (e) {
      process.stdout.write(String(e.stdout ?? ''));
      fail(name);
    }
  }
}

if (!existsSync(tarball)) fail('tarball vanished');
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\npack verification passed');
