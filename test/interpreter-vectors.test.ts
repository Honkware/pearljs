// The interpreter against Pearl's script engine. vectors/interpreter/generate.go
// ran txscript.NewEngine(...).Execute() over every case and recorded the
// verdict, the ErrorCode name, the message and a digest of the stacks after
// every step. Each case must come out the same here, in all four.
//
// Set PEARLJS_INTERPRETER_VECTORS to check another file, as
// vectors/interpreter/sweep.sh does with a larger random run.

import { describe, expect, it } from 'vitest';
import { SCRIPT_ERROR_CODES, verifyInput } from '../src/index.js';
import { caseInputs, loadEngineVectors, runWithTrace } from './interpreter-helpers.js';
import type { EngineCase } from './interpreter-helpers.js';

const vectors = loadEngineVectors(
  process.env.PEARLJS_INTERPRETER_VECTORS ?? new URL('../vectors/interpreter/vectors.json.gz', import.meta.url),
);

const groups = new Map<string, EngineCase[]>();
for (const item of vectors.cases) {
  const group = item.name.slice(0, item.name.indexOf('/'));
  groups.set(group, [...(groups.get(group) ?? []), item]);
}

/** What the engine recorded and what the interpreter did, when they differ. */
function difference(item: EngineCase): string | null {
  const { tx, index, prevouts } = caseInputs(item);
  const plain = verifyInput(tx, index, prevouts);
  const { result, trace } = runWithTrace(tx, index, prevouts);
  const want = `${item.code ?? 'accepted'} "${item.message ?? ''}" ${item.trace}`;
  const got = `${result.ok ? 'accepted' : result.code} "${result.ok ? '' : result.message}" ${trace}`;
  if (got !== want) return `${item.name}: engine ${want}, interpreter ${got}`;
  if (JSON.stringify(plain) !== JSON.stringify(result)) return `${item.name}: verifyInput and debugInput disagree`;
  return null;
}

describe('the interpreter against Pearl\'s script engine', () => {
  it('has the cases of every kind', () => {
    expect(vectors.cases.length).toBeGreaterThanOrEqual(vectors.randomScripts);
    if (process.env.PEARLJS_INTERPRETER_VECTORS !== undefined) return;
    expect([...groups.keys()].sort()).toEqual([
      'cat',
      'conditional',
      'control-block',
      'engine',
      'hash',
      'limit',
      'mutated',
      'number',
      'opcode',
      'pubkey',
      'push',
      'random',
      'signature',
      'stack',
      'timelock',
      'valid',
      'xmss',
    ]);
    expect(vectors.cases.length).toBeGreaterThan(10000);
    expect(vectors.cases.filter((item) => item.code === undefined).length).toBeGreaterThan(2000);
  });

  it('names every error code as the engine does', () => {
    expect(SCRIPT_ERROR_CODES.slice(0, vectors.errorCodes.length)).toEqual(vectors.errorCodes);
    // The rest are the signature library's error kinds, which the engine returns as they are.
    expect(SCRIPT_ERROR_CODES.slice(vectors.errorCodes.length)).toEqual([
      'ErrPubKeyXTooBig',
      'ErrPubKeyNotOnCurve',
      'ErrSigRTooBig',
      'ErrSigSTooBig',
    ]);
    const known = new Set<string>(SCRIPT_ERROR_CODES);
    expect(vectors.cases.filter((item) => item.code !== undefined && !known.has(item.code))).toEqual([]);
  });

  for (const [group, cases] of groups) {
    it(`agrees on the verdict, code, message and every step of the ${cases.length} ${group} cases`, () => {
      const differences = cases.map(difference).filter((text) => text !== null);
      expect(differences.slice(0, 20)).toEqual([]);
    }, 300_000);
  }
});
