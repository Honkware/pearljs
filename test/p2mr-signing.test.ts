// Safeguards around P2MR signing: an all-P2MR spend is checked against the
// previous transactions of its inputs before anything signs it.

import { BIP32Factory } from 'bip32';
import * as ecc from 'tiny-secp256k1';
import { describe, expect, it } from 'vitest';
import {
  assembleScriptTree,
  checksigScript,
  createTransaction,
  createXmssSigner,
  DEFAULT_MAX_FEE_RATE,
  deriveSigningAccountFromSeed,
  MAX_GRAIN,
  networks,
  p2mr,
  p2tr,
  signP2mrInputAsync,
  signXmssP2mrInput,
  tapscriptSighash,
  Transaction,
  xmssLeafScript,
} from '../src/index.js';
import type { TxOutput } from '../src/index.js';
import vectors from '../vectors/pearl-go.json' with { type: 'json' };
import { hexToBytes } from './vector-helpers.js';

const account = deriveSigningAccountFromSeed(hexToBytes(vectors.bip86.seed), networks.regtest);
const tree = assembleScriptTree([0, 1].map((i) => checksigScript(account.derivePublicKey(i))));
const p2mrScript = p2mr({ merkleRoot: tree.root }).output;

interface Spend {
  tx: Transaction;
  prevouts: TxOutput[];
  previousTransactions: Transaction[];
}

const FEE = 1_000n;

/** A previous transaction paying `values` to the tree, and a tx spending all of it less `fee`. */
function spendOf(values: bigint[], extra?: TxOutput, fee = FEE): Spend {
  const previous = createTransaction(2);
  for (const value of values) previous.addOutput(p2mrScript, value);
  if (extra !== undefined) previous.addOutput(extra.script, extra.value);
  const tx = createTransaction(2);
  previous.outs.forEach((_, index) => tx.addInput(previous.getHash(), index, 0xfffffffe));
  tx.addOutput(p2mrScript, previous.outs.reduce((sum, out) => sum + out.value, 0n) - fee);
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
    const hash = tapscriptSighash(spend.tx, 0, { prevouts: spend.prevouts, leafHash: tree.leaves[1]!.leafHash });
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

describe('fee guard of the raw-transaction signers', () => {
  const PRL = 100_000_000n;
  // One input, one output, 64-byte signature, 34-byte leaf, 33-byte control block.
  const VSIZE = 129n;
  const DEFAULT_LIMIT = (VSIZE * DEFAULT_MAX_FEE_RATE + 999n) / 1000n;

  it('refuses a spend that forgot its change output', () => {
    const spend = spendOf([1_000n * PRL], undefined, 999n * PRL);
    const options = { previousTransactions: spend.previousTransactions };
    expect(() => sign(spend, options)).toThrow(
      `pays a fee of ${999n * PRL} grain, above the ${DEFAULT_LIMIT} grain that maxFeeRate`,
    );
    expect(spend.tx.ins[0]!.witness).toHaveLength(0);
    expect(() => sign(spend, { ...options, maxFeeRate: 998n * PRL * 1000n / VSIZE })).toThrow('raise maxFeeRate');

    sign(spend, { ...options, maxFeeRate: 1_000n * PRL * 1000n / VSIZE });
    expect(spend.tx.ins[0]!.witness).toHaveLength(3);
  });

  it('signs a fee at the limit and refuses one grain more', () => {
    const atLimit = spendOf([PRL], undefined, DEFAULT_LIMIT);
    sign(atLimit, { trustPrevouts: true });
    expect(atLimit.tx.virtualSize()).toBe(Number(VSIZE));
    const over = spendOf([PRL], undefined, DEFAULT_LIMIT + 1n);
    expect(() => sign(over, { trustPrevouts: true })).toThrow('raise maxFeeRate');
    expect(() => sign(atLimit, { trustPrevouts: true, maxFeeRate: 0n })).toThrow('raise maxFeeRate');
    expect(() => sign(atLimit, { trustPrevouts: true, maxFeeRate: 5000 })).toThrow(TypeError);
    expect(() => sign(atLimit, { trustPrevouts: true, maxFeeRate: -1n })).toThrow(TypeError);
  });

  it('refuses outputs that exceed the inputs', () => {
    const spend = spendOf([PRL], undefined, -1n);
    expect(() => sign(spend, { trustPrevouts: true })).toThrow(
      `transaction outputs (${PRL + 1n} grain) exceed its inputs (${PRL} grain)`,
    );
    expect(() => sign(spend, { trustPrevouts: true, maxFeeRate: MAX_GRAIN })).toThrow('exceed its inputs');
    // Under ANYONECANPAY someone else may still add the inputs that pay for them.
    sign(spend, { sighashType: Transaction.SIGHASH_ALL | Transaction.SIGHASH_ANYONECANPAY });
    expect(spend.tx.ins[0]!.witness).toHaveLength(3);
  });

  it('refuses an output value outside the amount bounds', () => {
    const spend = spendOf([PRL]);
    spend.tx.outs[0]!.value = MAX_GRAIN + 1n;
    expect(() => sign(spend, { trustPrevouts: true })).toThrow('output 0 value is outside Pearl amount bounds');
  });

  it('checks the fee before an async signer is asked', async () => {
    const spend = spendOf([1_000n * PRL], undefined, 999n * PRL);
    const child = BIP32Factory(ecc)
      .fromSeed(hexToBytes(vectors.bip86.seed), {
        wif: networks.regtest.wif,
        bip32: { public: networks.regtest.hdPublicKeyId, private: networks.regtest.hdPrivateKeyId },
      })
      .derivePath(`${account.path}/0/1`);
    let calls = 0;
    const device = {
      publicKey: child.publicKey,
      signSchnorr: async (hash: Uint8Array) => {
        calls += 1;
        return child.signSchnorr(hash);
      },
    };
    const options = { prevouts: spend.prevouts, tree, leafIndex: 1, trustPrevouts: true };
    await expect(signP2mrInputAsync(spend.tx, 0, device, options)).rejects.toThrow('raise maxFeeRate');
    expect(calls).toBe(0);
    await signP2mrInputAsync(spend.tx, 0, device, { ...options, maxFeeRate: MAX_GRAIN });
    expect(calls).toBe(1);
  });

  it('checks the fee before an XMSS signer spends an index', async () => {
    let reserved = 0;
    const signer = createXmssSigner(new Uint8Array(64).fill(0x21), new Uint8Array(32).fill(0x22), {
      reserve: () => reserved++,
    });
    const xmssTree = assembleScriptTree([xmssLeafScript(signer.publicKey)]);
    const script = p2mr({ merkleRoot: xmssTree.root }).output;
    const previous = createTransaction(2);
    previous.addOutput(script, 1_000n * PRL);
    const tx = createTransaction(2);
    tx.addInput(previous.getHash(), 0, 0xfffffffe);
    tx.addOutput(script, PRL);
    const options = {
      prevouts: [{ script, value: 1_000n * PRL }],
      tree: xmssTree,
      leafIndex: 0,
      previousTransactions: [previous],
    };
    await expect(signXmssP2mrInput(tx, 0, signer, options)).rejects.toThrow('raise maxFeeRate');
    expect(reserved).toBe(0);

    // The limit is for the size with the 2340-byte signature in place.
    tx.outs[0]!.value = 1_000n * PRL - 3_000_000n;
    await signXmssP2mrInput(tx, 0, signer, options);
    expect(reserved).toBe(1);
    expect(BigInt(tx.virtualSize()) * DEFAULT_MAX_FEE_RATE / 1000n).toBeGreaterThan(3_000_000n);
  });
});
