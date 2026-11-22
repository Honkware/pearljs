// Typechecks every ```ts block in README.md and docs/, folders included, against src/.
// Given paths, checks only those files; CHECK_DOCS_OUT names another scratch folder in the
// package, so two runs can go at once.
//
// Each block becomes a module whose lines sit where they sit in the Markdown,
// so tsc's line numbers are the document's. `pearljs` and `pearljs/<module>`
// resolve to src/ through the paths in tsconfig.json. Three marks change how
// a block is read, written after the language on the fence line:
//
//   ```ts continues   joins the block before it in the same file
//   ```ts fragment    wraps the statements after the imports in an async
//                     function, for a block that uses `return` or shows part
//                     of a larger program
//   ```ts run         is also executed after the typecheck, against dist/, and
//                     must exit cleanly; for examples that need no node
//   ```ts no-check    is left out; needs a reason in the line above
//
// A comment `<!-- check-docs: declare const x: T; -->` directly above a block
// is prepended to it, for names a fragment takes from its surroundings.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { transform } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = join(root, process.env.CHECK_DOCS_OUT ?? '.check-docs');
// `--show` prints what the executed blocks print, to compare with the comments in them.
const show = process.argv.includes('--show');
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');

const guides = existsSync(join(root, 'docs'))
  ? readdirSync(join(root, 'docs'), { recursive: true })
      .map((name) => String(name).replaceAll('\\', '/'))
      // docs/api/ is TypeDoc's output.
      .filter((name) => name.endsWith('.md') && !name.startsWith('api/'))
      .sort()
  : [];
const only = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const sources = only.length > 0 ? only : ['README.md', ...guides.map((name) => `docs/${name}`)];

/** The modules of one Markdown file: arrays of lines as long as the file, blank outside their blocks. */
function modulesOf(lines, file) {
  const modules = [];
  let current = null;
  let inside = null;
  let pendingContext = null;
  lines.forEach((line, i) => {
    if (inside === null) {
      const context = /^<!--\s*check-docs:(.*?)-->\s*$/.exec(line);
      if (context) {
        pendingContext = { line: i, text: context[1].trim() };
        return;
      }
      const fence = /^```(ts|typescript)\b(.*)$/.exec(line);
      if (!fence) {
        if (line.trim() !== '') pendingContext = null;
        return;
      }
      const marks = fence[2].trim().split(/\s+/).filter(Boolean);
      for (const mark of marks) {
        if (!['continues', 'fragment', 'run', 'no-check'].includes(mark)) throw new Error(`${file}:${i + 1}: unknown mark "${mark}"`);
      }
      if (marks.includes('no-check')) {
        inside = { skip: true };
        return;
      }
      if (marks.includes('continues')) {
        if (current === null) throw new Error(`${file}:${i + 1}: nothing to continue`);
      } else {
        current = new Array(lines.length).fill('');
        current.run = marks.includes('run');
        modules.push(current);
      }
      if (pendingContext !== null) current[pendingContext.line] = pendingContext.text;
      pendingContext = null;
      inside = { skip: false, fragment: marks.includes('fragment'), start: i, opened: false, importOpen: false };
      return;
    }
    if (/^```\s*$/.test(line)) {
      if (!inside.skip && inside.fragment) {
        if (!inside.opened) current[inside.start] += 'void (async () => {';
        current[i] = '});';
      }
      inside = null;
      return;
    }
    if (inside.skip) return;
    current[i] = line;
    if (!inside.fragment || inside.opened) return;
    // Imports stay at the top level; the wrapper opens after the last of them.
    if (inside.importOpen) {
      if (/from\s+['"][^'"]+['"];?\s*$/.test(line)) inside.importOpen = false;
    } else if (/^import\b/.test(line)) {
      inside.importOpen = !/from\s+['"][^'"]+['"];?\s*$/.test(line) && !/^import\s+['"]/.test(line);
    } else if (line.trim() !== '' && !/^\s*\/\//.test(line)) {
      current[i] = `void (async () => { ${line}`;
      inside.opened = true;
    }
  });
  if (inside !== null) throw new Error(`${file}: unclosed code block`);
  return modules;
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'docs'), { recursive: true });
const runnable = [];
let blocks = 0;
for (const file of sources) {
  const lines = readFileSync(join(root, file), 'utf8').split('\n');
  modulesOf(lines, file).forEach((moduleLines, n) => {
    const name = `${file}.${n}.ts`;
    mkdirSync(dirname(join(out, name)), { recursive: true });
    // `export {}` makes every block a module, so top-level await works and names do not collide.
    writeFileSync(join(out, name), `${moduleLines.join('\n')}\nexport {};\n`);
    if (moduleLines.run) runnable.push({ name, file, line: moduleLines.findIndex((text) => text !== '') + 1 });
    blocks += 1;
  });
}
writeFileSync(
  join(out, 'tsconfig.json'),
  JSON.stringify(
    {
      extends: '../tsconfig.json',
      compilerOptions: {
        types: ['node'],
        lib: ['ES2023', 'DOM', 'DOM.Iterable'],
        paths: { pearljs: ['../src/index.ts'], 'pearljs/*': ['../src/*.ts'] },
      },
      include: ['./**/*.ts'],
    },
    null,
    2,
  ),
);

const result = spawnSync(process.execPath, [tsc, '-p', join(out, 'tsconfig.json'), '--pretty', 'false'], { cwd: root, encoding: 'utf8' });
const report = (result.stdout + result.stderr)
  .split('\n')
  .filter((line) => line.trim() !== '')
  // .check-docs/docs/guides/payments.md.2.ts(41,7): error ... -> docs/guides/payments.md:41:7: error ...
  .map((line) => {
    const match = /^(.*?\.check-docs[\w-]*[\\/])?(.+?\.md)\.\d+\.ts\((\d+),(\d+)\): (.*)$/.exec(line);
    return match ? `${match[2]}:${match[3]}:${match[4]}: ${match[5]}` : line;
  });
if (result.status !== 0) {
  console.error(report.join('\n'));
  console.error(`\ncheck-docs: ${report.length} problems in the TypeScript blocks of ${sources.length} files`);
  process.exit(1);
}

// Blocks marked `run` import pearljs by name, which Node resolves to dist/
// through the package's own exports because .check-docs/ sits inside it.
if (runnable.length > 0 && !existsSync(join(root, 'dist/index.js'))) {
  console.error('check-docs: dist/ is missing; run `npm run build` first');
  process.exit(1);
}
for (const { name, file, line } of runnable) {
  const { code } = await transform(readFileSync(join(out, name), 'utf8'), { loader: 'ts', format: 'esm' });
  const script = join(out, name.replace(/\.ts$/, '.mjs'));
  writeFileSync(script, code);
  const ran = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
  if (ran.status !== 0) {
    console.error(`${file}:${line}: the block marked \`run\` failed\n${ran.stderr || ran.stdout}`);
    process.exit(1);
  }
  if (show) console.log(`-- ${file}:${line}\n${ran.stdout}`);
}

rmSync(out, { recursive: true, force: true });
console.log(`check-docs: ${blocks} TypeScript blocks in ${sources.length} files typecheck against src/, ${runnable.length} of them ran`);
