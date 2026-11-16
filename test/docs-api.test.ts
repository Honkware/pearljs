// The API reference covers every subpath export: typedoc.json has an entry
// point for each, and docs/api.md a row naming each, so a module added to
// package.json cannot go undocumented.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const pkg = JSON.parse(read('../package.json')) as { exports: Record<string, unknown> };
const subpaths = Object.keys(pkg.exports)
  .filter((key) => key !== './package.json')
  .map((key) => (key === '.' ? 'index' : key.slice(2)))
  .sort();

describe('the API reference', () => {
  it('has a TypeDoc entry point for every subpath export, and no other', () => {
    const typedoc = JSON.parse(read('../typedoc.json')) as { entryPoints: string[]; disableSources?: boolean };
    const entries = typedoc.entryPoints.map((path) => /^src\/([\w-]+)\.ts$/.exec(path)?.[1] ?? path).sort();
    expect(entries).toEqual(subpaths);
  });

  it('builds without a git remote, since it links to no source files', () => {
    expect((JSON.parse(read('../typedoc.json')) as { disableSources?: boolean }).disableSources).toBe(true);
  });

  it('names every subpath in the module table of docs/api.md once', () => {
    const rows = read('../docs/api.md')
      .split('\n')
      .filter((line) => line.startsWith('| `'))
      .flatMap((line) => [...line.split('|')[1]!.matchAll(/`([\w-]+)`/g)].map((m) => m[1]!));
    expect(rows.sort()).toEqual(subpaths.filter((name) => name !== 'index'));
  });
});
