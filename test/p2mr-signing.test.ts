// Safeguards around P2MR signing: an all-P2MR spend is checked against the
// previous transactions of its inputs before anything signs it.

import * as ecc from 'tiny-secp256k1';
import { describe, expect, it } from 'vitest';
import {
  assembleScriptTree,
  checksigScript,
  createTransaction,
  deriveSigningAccountFromSeed,
  networks,
  p2mr,
  p2tr,
  tapscriptSighash,
  Transaction,
} from '../src/index.js';
import type { Prevout } from '../src/index.js';
import vectors from '../vectors/pearl-go.json' with { type: 'json' };
import { hexToBytes } from './vector-helpers.js';

const account = deriveSigningAccountFromSeed(hexToBytes(vectors.bip86.seed), networks.regtest);
const tree = assembleScriptTree([0, 1].map((i) => checksigScript(account.derivePublicKey(i))));
const p2mrScript = p2mr({ merkleRoot: tree.root }).output;

interface Spend {
  tx: Transaction;
  prevouts: Prevout[];
  previousTransactions: Transaction[];
}

/** A previous transaction paying `values` to the tree, and a tx spending all of it. */
function spendOf(values: bigint[], extra?: Prevout): Spend {
  const previous = createTransaction(2);
  for (const value of values) previous.addOutput(p2mrScript, value);
  if (extra !== undefined) previous.addOutput(extra.script, extra.value);
  const tx = createTransaction(2);
  previous.outs.forEach((_, index) => tx.addInput(previous.getHash(), index, 0xfffffffe));
  tx.addOutput(p2mrScript, 1_000n);
  const prevouts = previous.outs.map((out) => ({ script: out.script, value: out.value }));
  return { tx, prevouts, previousTransactions: [previous] };
}

function sign(spend: Spend, overrides: object = {}): void {
  account.signP2mrInput(spend.tx, 0, {
    index: 1,
    prevouts: spend.prevouts,
    tree,
    leafIndex: 1,
    ...overrides,
  });
}

describe('P2MR signing safeguards', () => {
  it('refuses an all-P2MR spend it cannot check against previous transactions', () => {
    const spend = spendOf([100_000_000n]);
    expect(() => sign(spend)).toThrow('previous transactions');
    expect(spend.tx.ins[0]!.witness).toHaveLength(0);
  });

  it('signs once the previous transactions confirm the input values', () => {
    const spend = spendOf([100_000_000n, 50_000n]);
    sign(spend, { previousTransactions: spend.previousTransactions });
    const signature = spend.tx.ins[0]!.witness[0]!;
    const hash = tapscriptSighash(spend.tx, 0, spend.prevouts, tree.leaves[1]!.leafHash);
    expect(ecc.verifySchnorr(hash, account.derivePublicKey(1), signature)).toBe(true);
  });

  it('refuses a value the previous transaction does not back', () => {
    const spend = spendOf([100_000_000n]);
    const told = [{ script: p2mrScript, value: 100_000n }];
    expect(() =>
      sign({ ...spend, prevouts: told }, { prevouts: told, previousTransactions: spend.previousTransactions }),
    ).toThrow('does not match');
    expect(spend.tx.ins[0]!.witness).toHaveLength(0);
  });

  it('refuses when a previous transaction is missing', () => {
    const spend = spendOf([100_000_000n]);
    expect(() => sign(spend, { previousTransactions: [] })).toThrow('missing the previous transaction');
  });

  it('signs without previous transactions when told to trust the prevouts', () => {
    const spend = spendOf([100_000_000n]);
    sign(spend, { trustPrevouts: true });
    expect(spend.tx.ins[0]!.witness).toHaveLength(3);
  });

  it('needs no previous transactions under ANYONECANPAY', () => {
    const spend = spendOf([100_000_000n, 7_000n]);
    sign(spend, { sighashType: Transaction.SIGHASH_ALL | Transaction.SIGHASH_ANYONECANPAY });
    expect(spend.tx.ins[0]!.witness).toHaveLength(3);
  });

  it('needs no previous transactions when a P2TR input is present', () => {
    const p2trPrevout = { script: p2tr({ internalPubkey: account.derivePublicKey(0, true) }).output, value: 9_000n };
    const spend = spendOf([100_000_000n], p2trPrevout);
    sign(spend);
    expect(spend.tx.ins[0]!.witness).toHaveLength(3);
  });
});
