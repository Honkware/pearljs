// The public API, name by name: every runtime export and every exported type
// of each subpath in package.json, compared with test/fixtures/exports.json.
// An export added or removed by accident shows up here; one changed on
// purpose shows up in review as a diff of that file.
//
//   PEARLJS_UPDATE_EXPORTS=1 npm test -- test/exports.test.ts

import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const pkg = JSON.parse(read('../package.json')) as { exports: Record<string, unknown> };
const subpaths = Object.keys(pkg.exports)
  .filter((key) => key !== './package.json')
  .map((key) => (key === '.' ? 'index' : key.slice(2)));
const fixture = new URL('./fixtures/exports.json', import.meta.url);

/** Exported type names of a module, following its `export *` and `export type { }` lines. */
function typesOf(name: string, seen = new Set<string>()): string[] {
  if (seen.has(name)) return [];
  seen.add(name);
  const source = read(`../src/${name}.ts`);
  const names = [...source.matchAll(/^export (?:interface|type) (\w+)/gm)].map((m) => m[1]!);
  for (const m of source.matchAll(/^export type \{([^}]+)\}/gm)) {
    names.push(...m[1]!.split(',').map((part) => part.trim().split(/\s+as\s+/).pop()!).filter(Boolean));
  }
  for (const m of source.matchAll(/^export \* from '\.\/([\w/-]+)\.js'/gm)) names.push(...typesOf(m[1]!, seen));
  return names;
}

describe('public exports', () => {
  it('are exactly the ones recorded for each subpath', async () => {
    const actual: Record<string, { values: string[]; types: string[] }> = {};
    for (const name of subpaths) {
      const module = (await import(`../src/${name}.ts`)) as Record<string, unknown>;
      actual[name] = { values: Object.keys(module).sort(), types: [...new Set(typesOf(name))].sort() };
    }
    if (process.env.PEARLJS_UPDATE_EXPORTS === '1') writeFileSync(fixture, `${JSON.stringify(actual, null, 2)}\n`);
    expect(actual).toEqual(JSON.parse(readFileSync(fixture, 'utf8')));
  });

  it('keeps the internal modules out of the package exports', () => {
    expect(subpaths.filter((name) => name.includes('internal'))).toEqual([]);
    expect(read('../src/index.ts')).not.toContain('internal');
  });
});
