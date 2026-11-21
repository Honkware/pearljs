// The script interpreter beside pearld's engine, over everything the run
// built. chain.ts judges each transaction the tests put to the node and
// writes down both verdicts; this file, which runs after the others, checks
// that they never differed, that the refusals pearld's script engine made
// were each met with the engine's own error, and steps debugInput through a
// mined spend of every kind of leaf the suite uses.

import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { debugInput, decompileScript, inspectTransaction, OP_CODES, parseTransaction } from '../../src/index.js';
import type { ScriptResult, ScriptStep, Transaction, TxOutput } from '../../src/index.js';
import { describeLive, judgedFile, network, pearld, spentOutputs, type Judged } from './chain.js';

const judged = (): Judged[] =>
  existsSync(judgedFile)
    ? readFileSync(judgedFile, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as Judged)
    : [];

// The whole suite ran before this file, not a few files picked by name.
const wholeRun = (): boolean => new Set(judged().map((entry) => entry.file)).size >= 20;

/** What each refusal of pearld's script engine in this suite is called by the interpreter. */
const REFUSALS: Record<string, RegExp> = {
  ErrNullFail: /^signature not empty on failed checksig$/,
  ErrTaprootSigInvalid: /^$/,
  ErrUnsatisfiedLockTime: /^(locktime requirement not satisfied -- locktime is greater than the transaction locktime: \d+ > \d+|mismatched locktime types -- tx locktime \d+, stack locktime \d+|transaction input is finalized|invalid transaction version: 1)$/,
};

type Kind = 'key path' | 'checksig' | 'multi_a' | 'XMSS' | 'timelock' | 'annex' | 'code separator';

function kindsOf(tx: Transaction, prevouts: TxOutput[]): Map<Kind, number> {
  const kinds = new Map<Kind, number>();
  inspectTransaction(tx, prevouts, network).inputs.forEach((input, i) => {
    const { spend } = input;
    const add = (kind: Kind): void => void (kinds.has(kind) || kinds.set(kind, i));
    if (spend.type === 'keyPath') return add('key path');
    if (spend.type !== 'scriptPath') return;
    if (input.annex !== undefined) add('annex');
    const opcodes = new Set(decompileScript(spend.script).filter((item) => typeof item === 'number'));
    if (opcodes.has(OP_CODES.OP_CHECKLOCKTIMEVERIFY) || opcodes.has(OP_CODES.OP_CHECKSEQUENCEVERIFY)) add('timelock');
    else if (opcodes.has(OP_CODES.OP_CODESEPARATOR)) add('code separator');
    else if (spend.leaf === 'checksig') add('checksig');
    else if (spend.leaf === 'multiA') add('multi_a');
    else if (spend.leaf === 'xmss') add('XMSS');
  });
  return kinds;
}

function trace(run: Generator<ScriptStep, ScriptResult, void>): { steps: ScriptStep[]; result: ScriptResult } {
  const steps: ScriptStep[] = [];
  let next = run.next();
  while (next.done !== true) {
    steps.push(next.value);
    next = run.next();
  }
  return { steps, result: next.value };
}

describeLive('script interpreter beside pearld', () => {
  it('never differed from pearld on a transaction the suite sent or tested', () => {
    const entries = judged();
    expect(entries.filter((entry) => entry.outcome === 'disagree')).toEqual([]);
    if (!wholeRun()) return;
    const count = (outcome: Judged['outcome']): number => entries.filter((entry) => entry.outcome === outcome).length;
    expect(count('accepted')).toBeGreaterThan(300);
    expect(count('script')).toBeGreaterThanOrEqual(20);
  });

  it('gave the script engine\'s own error for every spend pearld refused at script level', () => {
    const refusals = judged().filter((entry) => entry.outcome === 'script');
    for (const refusal of refusals) {
      expect(REFUSALS[refusal.code!], `${refusal.code}: ${refusal.detail}`).toBeDefined();
      expect(refusal.detail, refusal.code).toMatch(REFUSALS[refusal.code!]!);
    }
    if (wholeRun()) expect([...new Set(refusals.map((entry) => entry.code))].sort()).toEqual(Object.keys(REFUSALS).sort());
  });

  it('steps through a mined spend of each kind of leaf with debugInput, as the engine ran it', async () => {
    const found = new Map<Kind, { tx: Transaction; prevouts: TxOutput[]; index: number }>();
    for (const entry of judged()) {
      if (entry.outcome !== 'accepted' || entry.hex === undefined || found.size === 7) continue;
      const tx = parseTransaction(entry.hex);
      const info = await pearld.getRawTransaction(tx.getId()).catch(() => null);
      // Replaced or reorganized away: not a mined spend.
      if (info === null || info.blockhash === undefined || info.blockhash === '') continue;
      const prevouts = await spentOutputs(tx);
      for (const [kind, index] of kindsOf(tx, prevouts)) if (!found.has(kind)) found.set(kind, { tx, prevouts, index });
    }
    if (wholeRun()) expect([...found.keys()].sort()).toEqual(['XMSS', 'annex', 'checksig', 'code separator', 'key path', 'multi_a', 'timelock']);

    for (const [kind, { tx, prevouts, index }] of found) {
      const { steps, result } = trace(debugInput(tx, index, prevouts));
      expect(result, kind).toEqual({ ok: true });
      // The output script is a version and a program; the step that ends it has already checked the witness.
      const output = steps.filter((step) => step.scriptIndex === 1);
      expect(output.map((step) => step.name), kind).toEqual([prevouts[index]!.script[0] === OP_CODES.OP_1 ? 'OP_1' : 'OP_2', 'OP_DATA_32']);
      const leaf = steps.filter((step) => step.scriptIndex === 2);
      const names = leaf.map((step) => step.name);
      const last = steps.at(-1)!;
      expect(last.stack, kind).toEqual([Uint8Array.of(1)]);
      if (kind === 'key path') {
        expect(leaf, kind).toEqual([]);
        continue;
      }
      const witness = tx.ins[index]!.witness;
      const annexed = witness.length > 1 && witness.at(-1)![0] === 0x50;
      const script = witness.at(annexed ? -3 : -2)!;
      // One step for each opcode of the leaf, all executed, in order.
      expect(leaf.map((step) => step.offset), kind).toEqual(leaf.map((step) => step.offset).sort((a, b) => a - b));
      expect(leaf, kind).toHaveLength(decompileScript(script).length);
      expect(leaf.every((step) => step.executed), kind).toBe(true);
      // The leaf starts on the witness items in front of it.
      expect(output[1]!.stack, kind).toEqual(witness.slice(0, annexed ? -3 : -2));
      const budget = (name: string): number[] => leaf.flatMap((step, i) => (step.name === name ? [(leaf[i - 1] ?? output[1]!).sigOpsBudget! - step.sigOpsBudget!] : []));
      if (kind === 'checksig') expect(names, kind).toEqual(['OP_DATA_32', 'OP_CHECKSIG']);
      if (kind === 'checksig' || kind === 'annex') expect(budget('OP_CHECKSIG'), kind).toEqual([50]);
      if (kind === 'multi_a') {
        expect(names.at(-1), kind).toBe('OP_NUMEQUAL');
        // Fifty for each signature that is there, nothing for an empty one.
        const signatures = output[1]!.stack.filter((item) => item.length > 0).length;
        expect([...budget('OP_CHECKSIG'), ...budget('OP_CHECKSIGADD')].reduce((sum, cost) => sum + cost, 0), kind).toBe(50 * signatures);
      }
      if (kind === 'XMSS') {
        expect(names, kind).toEqual(['OP_DATA_64', 'OP_CHECKXMSSSIG']);
        expect(budget('OP_CHECKXMSSSIG'), kind).toEqual([1000]);
      }
      if (kind === 'timelock') expect(names.some((name) => name === 'OP_CHECKLOCKTIMEVERIFY' || name === 'OP_CHECKSEQUENCEVERIFY'), kind).toBe(true);
      if (kind === 'code separator') {
        expect(names.filter((name) => name === 'OP_CODESEPARATOR').length, kind).toBeGreaterThan(0);
        expect(names.at(-1), kind).toBe('OP_CHECKSIG');
      }
    }
  });
});
