// The payment builder: unsigned transactions byte for byte against the ones
// Oyster's txauthor wrote for the coinSelection vectors, then BIP86 accounts
// taken from unspent outputs to signed transactions whose signatures are
// verified here and whose shape is checked with checkStandard.

import * as ecc from 'tiny-secp256k1';
import { describe, expect, it } from 'vitest';
import {
  addInputByTxid,
  assembleScriptTree,
  buildPayment,
  customNetwork,
  checksigScript,
  checkStandard,
  createTransaction,
  deriveSigningAccountFromSeed,
  finalizePayment,
  fromOutputScript,
  InsufficientFundsError,
  isDust,
  minRelayFee,
  networks,
  p2mr,
  parsePearl,
  payFromAccount,
  Psbt,
  serializeTransaction,
  tapscriptSighash,
  toOutputScript,
} from '../src/index.js';
import type { AccountUtxo, Recipient, SignedPayment, Transaction, Utxo } from '../src/index.js';
import vectors from '../vectors/pearl-go.json' with { type: 'json' };
import { bytesToHex, hexToBytes } from './vector-helpers.js';
import { coinsOf, INPUT_KINDS, outpoint, seededRandom, selectionCase } from './wallet-helpers.js';

const network = networks.regtest;
const account = deriveSigningAccountFromSeed(hexToBytes(vectors.bip86.seed), network);
const changeAddress = account.deriveAddress(0, true);
const recipient = account.deriveAddress(40);

function coin(index: number, value: bigint, extra: Partial<AccountUtxo> = {}): AccountUtxo {
  return {
    txid: (index + 1).toString(16).padStart(64, 'ab'),
    vout: index,
    value,
    script: toOutputScript(account.deriveAddress(index, extra.change ?? false), network),
    confirmations: 3,
    index,
    ...extra,
  };
}

/** Checks every key-path signature of a signed payment against the BIP 341 message. */
function expectKeyPathSignatures(payment: SignedPayment<Utxo>): void {
  const scripts = payment.prevouts.map((prevout) => prevout.script);
  const values = payment.prevouts.map((prevout) => prevout.value);
  payment.transaction.ins.forEach((input, i) => {
    if (input.witness.length !== 1) return;
    const hash = payment.transaction.hashForWitnessV1(i, scripts, values, 0);
    expect(input.witness[0]!.length).toBe(64);
    expect(ecc.verifySchnorr(hash, scripts[i]!.subarray(2), input.witness[0]!)).toBe(true);
  });
}

describe('unsigned payments against Oyster', () => {
  const comparable = vectors.coinSelection.cases.filter(
    (vector) => vector.error === '' && vector.strategy !== 'random' && vector.changeScriptSize === 34 && !vector.name.startsWith('P2MR'),
  );

  for (const vector of comparable) {
    it(`builds Oyster's transaction for ${vector.name}`, () => {
      const changeScript = hexToBytes(vector.changeScript);
      const sweep = vector.outputs.length === 0;
      const recipients: Recipient[] = sweep
        ? [{ script: changeScript, amount: 'max' }]
        : vector.outputs.map((output) => ({ script: hexToBytes(output.script), amount: BigInt(output.value) }));
      const build = () =>
        buildPayment({
          network: networks.mainnet,
          utxos: coinsOf(vector),
          recipients,
          feeRate: BigInt(vector.feeRate),
          changeAddress: fromOutputScript(changeScript, networks.mainnet),
          strategy: vector.strategy as 'largest' | 'all',
        });
      if (BigInt(vector.feeRate) < 1000n) {
        // Oyster builds it, and pearld would not relay it.
        expect(build).toThrow('the fee of 3 grain is under the 154 grain pearld requires to relay 154 vbytes; raise the fee rate');
        return;
      }
      const payment = build();
      expect(serializeTransaction(payment.transaction)).toBe(vector.unsignedTxHex);
      expect(payment.fee).toBe(BigInt(vector.fee));
      expect(payment.inputs.map(outpoint)).toEqual(vector.inputs);
      expect(payment.changeIndex).toBe(sweep ? -1 : vector.changeIndex);
      expect(payment.change).toBe(sweep ? 0n : BigInt(vector.change));
      expect(payment.prevouts.map((prevout) => prevout.value)).toEqual(payment.inputs.map((input) => input.value));
      expect(bytesToHex(payment.psbt.data.getTransaction())).toBe(vector.unsignedTxHex);
    });
  }

  it('covers the vectors that build', () => {
    expect(comparable.length).toBeGreaterThanOrEqual(13);
  });
});

describe('addInputByTxid', () => {
  const txid = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

  it('adds the outpoint a block explorer shows to a transaction', () => {
    const tx = createTransaction();
    addInputByTxid(tx, txid, 7);
    expect(bytesToHex(tx.ins[0]!.hash)).toBe(bytesToHex(hexToBytes(txid).reverse()));
    expect(tx.ins[0]!.index).toBe(7);
    expect(tx.ins[0]!.sequence).toBe(0xffffffff);
  });

  it('adds the same input to a PSBT', () => {
    const tx = createTransaction();
    addInputByTxid(tx, txid, 7, 0xfffffffd);
    const psbt = new Psbt();
    addInputByTxid(psbt, txid.toUpperCase(), 7, 0xfffffffd);
    expect(bytesToHex(psbt.txInputs[0]!.hash)).toBe(bytesToHex(tx.ins[0]!.hash));
    expect(psbt.txInputs[0]!.sequence).toBe(0xfffffffd);
  });

  it('refuses anything that is not a transaction id and output index', () => {
    expect(() => addInputByTxid(createTransaction(), txid.slice(2), 0)).toThrow(/64 hexadecimal/);
    expect(() => addInputByTxid(createTransaction(), txid, -1)).toThrow(RangeError);
    expect(() => addInputByTxid(createTransaction(), txid, 1.5)).toThrow(RangeError);
  });
});

describe('payFromAccount', () => {
  const utxos = [coin(0, 40_000n), coin(1, 250_000n), coin(2, 90_000n, { change: true }), coin(3, 700n)];

  it('takes an account from unspent outputs to a signed transaction pearld relays', () => {
    const payment = payFromAccount(account, {
      network,
      utxos,
      recipients: [{ address: recipient, amount: 300_000n }],
      feeRate: 2000n,
      changeAddress,
    });
    expect(payment.inputs.map((input) => input.index)).toEqual([1, 2]);
    expect(payment.transaction.outs.map((output) => fromOutputScript(output.script, network))).toEqual([recipient, changeAddress]);
    // Two key-path inputs and two outputs are 211.5 vbytes; Oyster charges for 213.
    expect(payment.vsize).toBe(212);
    expect(payment.fee).toBe(426n);
    expect(payment.transaction.outs[0]!.value).toBe(300_000n);
    expect(payment.transaction.outs[1]!.value).toBe(340_000n - 300_000n - 426n);
    expect(payment.change).toBe(39_574n);
    expect(payment.changeIndex).toBe(1);
    expect(payment.hex).toBe(payment.transaction.toHex());
    expect(payment.txid).toBe(payment.transaction.getId());
    expect(payment.transaction.version).toBe(1);
    expect(payment.transaction.ins.every((input) => input.sequence === 0xffffffff)).toBe(true);
    expectKeyPathSignatures(payment);
    checkStandard(payment.transaction, { prevouts: payment.prevouts, height: 500, medianTimePast: 1_700_000_000 });
  });

  it('signals replace-by-fee on every input when asked', () => {
    const payment = payFromAccount(account, {
      network, utxos, recipients: [{ address: recipient, amount: 300_000n }], feeRate: 1000n, changeAddress, rbf: true,
    });
    expect(payment.transaction.ins.map((input) => input.sequence)).toEqual([0xfffffffd, 0xfffffffd]);
    expectKeyPathSignatures(payment);
  });

  it('sends everything the fee leaves to a max recipient', () => {
    const payment = payFromAccount(account, {
      network, utxos, recipients: [{ address: recipient, amount: 'max' }], feeRate: 1000n,
    });
    expect(payment.inputs.length).toBe(4);
    expect(payment.transaction.outs.length).toBe(1);
    // Four inputs and one output, as txsizes.EstimateVirtualSize counts them.
    expect(payment.fee).toBe(285n);
    expect(payment.transaction.outs[0]!.value).toBe(380_700n - 285n);
    expect(payment.changeIndex).toBe(-1);
    expectKeyPathSignatures(payment);
  });

  it('keeps a max recipient in its place among fixed ones', () => {
    const payment = payFromAccount(account, {
      network,
      utxos,
      recipients: [
        { address: account.deriveAddress(41), amount: 1000n },
        { address: recipient, amount: 'max' },
        { address: account.deriveAddress(42), amount: 2000n },
      ],
      feeRate: 1000n,
    });
    expect(payment.transaction.outs.map((output) => output.value)).toEqual([1000n, 380_700n - 3000n - payment.fee, 2000n]);
    // 303 bytes without witnesses; Oyster counts 271 witness units, signing makes 266.
    expect(payment.fee).toBe(371n);
    expect(payment.vsize).toBe(370);
  });

  it('says how much is missing when the account cannot pay', () => {
    const run = () =>
      payFromAccount(account, { network, utxos, recipients: [{ address: recipient, amount: parsePearl('1') }], feeRate: 1000n, changeAddress });
    expect(run).toThrow(InsufficientFundsError);
    expect(run).toThrow(
      'insufficient funds: 0.99619628 PRL short (0.003807 PRL spendable, 1.00000328 PRL needed including a fee of 0.00000328 PRL)',
    );
  });

  it('counts outputs held back as unconfirmed or immature in the error', () => {
    const held = [coin(0, 500_000n, { confirmations: 0 }), coin(1, 500_000n, { coinbase: true, confirmations: 99 }), coin(2, 1000n)];
    const options = { network, utxos: held, recipients: [{ address: recipient, amount: 400_000n }], feeRate: 1000n, changeAddress };
    expect(() => payFromAccount(account, options)).toThrow(/2 unspent outputs were left out as unconfirmed, immature or empty$/);
    expect(payFromAccount(account, { ...options, minConfirmations: 0 }).inputs.map((input) => input.index)).toEqual([0]);
    expect(payFromAccount(account, { ...options, coinbaseMaturity: 99 }).inputs.map((input) => input.index)).toEqual([1]);
    // A network whose coinbases mature sooner needs no option.
    const quick = customNetwork(network, { coinbaseMaturity: 99 });
    expect(payFromAccount(account, { ...options, network: quick }).inputs.map((input) => input.index)).toEqual([1]);
    expect(buildPayment({ ...options, network: quick }).inputs.map((input) => input.index)).toEqual([1]);
  });

  it('gives pearld\'s reason for a recipient amount that is dust', () => {
    expect(() =>
      payFromAccount(account, { network, utxos, recipients: [{ address: recipient, amount: 332n }], feeRate: 1000n, changeAddress }),
    ).toThrow('transaction output 0: payment is dust: 332');
  });

  it('refuses a max payment that leaves only dust', () => {
    expect(() =>
      payFromAccount(account, { network, utxos: [coin(3, 700n)], recipients: [{ address: recipient, amount: 'max' }], feeRate: 5000n }),
    ).toThrow(/nothing above the dust limit is left to send/);
  });

  it('refuses a fee rate pearld would not relay', () => {
    const options = { network, utxos, recipients: [{ address: recipient, amount: 1000n }], changeAddress };
    // At 999 the fee for Oyster's 155 vbytes still covers the 154 the transaction has.
    expect(payFromAccount(account, { ...options, feeRate: 999n }).fee).toBe(154n);
    expect(() => payFromAccount(account, { ...options, feeRate: 990n })).toThrow(/the fee of 153 grain is under the 154 grain pearld requires/);
    expect(payFromAccount(account, { ...options, feeRate: 990n, relayFeeRate: 500n }).fee).toBe(153n);
    expect(() => payFromAccount(account, { ...options, feeRate: 1000n, relayFeeRate: 3000n })).toThrow(/is under the 462 grain/);
  });

  it('refuses an output that does not belong to the child named for it', () => {
    const wrong = { ...coin(0, 40_000n), index: 9 };
    expect(() =>
      payFromAccount(account, { network, utxos: [wrong], recipients: [{ address: recipient, amount: 'max' }], feeRate: 1000n }),
    ).toThrow(/does not pay the account's child 0\/9/);
  });

  it('refuses duplicate outputs, a missing change address and two max recipients', () => {
    const base = { network, feeRate: 1000n, recipients: [{ address: recipient, amount: 1000n }] as Recipient[] };
    expect(() => payFromAccount(account, { ...base, utxos: [utxos[0]!, { ...utxos[0]! }], changeAddress })).toThrow(/duplicates/);
    expect(() => payFromAccount(account, { ...base, utxos })).toThrow(/change address is needed/);
    expect(() =>
      payFromAccount(account, { ...base, utxos, recipients: [{ address: recipient, amount: 'max' }, { address: changeAddress, amount: 'max' }] }),
    ).toThrow(/only one recipient/);
    expect(() => payFromAccount(account, { ...base, utxos, recipients: [], changeAddress })).toThrow(/at least one recipient/);
  });

  it('refuses a recipient on another network', () => {
    const mainnetAddress = deriveSigningAccountFromSeed(hexToBytes(vectors.bip86.seed), networks.mainnet).deriveAddress(0);
    expect(() =>
      payFromAccount(account, { network, utxos, recipients: [{ address: mainnetAddress, amount: 1000n }], feeRate: 1000n, changeAddress }),
    ).toThrow(/is not for regtest/);
  });
});

describe('payFromAccount with P2MR outputs', () => {
  const tree = assembleScriptTree([5, 6].map((index) => checksigScript(account.derivePublicKey(index))));
  const script = p2mr({ merkleRoot: tree.root }).output;

  function fund(value: bigint): { funding: Transaction; utxo: AccountUtxo } {
    const funding = createTransaction();
    addInputByTxid(funding, 'cd'.repeat(32), Number(value % 7n));
    funding.addOutput(script, value);
    return {
      funding,
      utxo: { txid: funding.getId(), vout: 0, value, script, confirmations: 2, index: 6, p2mr: { tree, leafIndex: 1 } },
    };
  }

  function expectLeafSignature(payment: SignedPayment<AccountUtxo>, inputIndex: number): void {
    const witness = payment.transaction.ins[inputIndex]!.witness;
    expect(witness.length).toBe(3);
    expect(bytesToHex(witness[1]!)).toBe(bytesToHex(tree.leaves[1]!.script));
    const hash = tapscriptSighash(payment.transaction, inputIndex, { prevouts: payment.prevouts, leafHash: tree.leaves[1]!.leafHash });
    expect(ecc.verifySchnorr(hash, account.derivePublicKey(6), witness[0]!)).toBe(true);
  }

  const a = fund(500_000n);
  const b = fund(300_000n);
  const options = { network, recipients: [{ address: recipient, amount: 600_000n }] as Recipient[], feeRate: 1000n, changeAddress };

  it('signs an all-P2MR payment once it has the previous transactions', () => {
    const payment = payFromAccount(account, { ...options, utxos: [a.utxo, b.utxo], previousTransactions: [a.funding, b.funding] });
    expectLeafSignature(payment, 0);
    expectLeafSignature(payment, 1);
    // Each input carries a signature, the 34-byte leaf and a 33-byte control block.
    expect(payment.vsize).toBe(10 + 2 * 41 + 2 * 43 + Math.ceil((2 + 2 * (1 + 65 + 35 + 34)) / 4));
    expect(payment.fee).toBe(BigInt(payment.vsize));
  });

  it('passes the signer\'s refusal through when they are missing', () => {
    expect(() => payFromAccount(account, { ...options, utxos: [a.utxo, b.utxo] })).toThrow(/previous transaction/);
    expect(() => payFromAccount(account, { ...options, utxos: [a.utxo, b.utxo], previousTransactions: [a.funding] })).toThrow(/previous transaction/);
  });

  it('passes trustPrevouts through to the signer', () => {
    const payment = payFromAccount(account, { ...options, utxos: [a.utxo, b.utxo], trustPrevouts: true });
    expectLeafSignature(payment, 0);
    expectLeafSignature(payment, 1);
  });

  it('signs P2MR and key-path inputs in one payment', () => {
    const payment = payFromAccount(account, { ...options, utxos: [a.utxo, coin(0, 400_000n)], previousTransactions: [a.funding] });
    expect(payment.inputs.map((input) => input.p2mr !== undefined)).toEqual([true, false]);
    expectLeafSignature(payment, 0);
    expectKeyPathSignatures(payment);
  });

  it('refuses a P2MR output without its tree, or with the wrong one', () => {
    const bare = { ...a.utxo };
    delete bare.p2mr;
    expect(() => payFromAccount(account, { ...options, utxos: [bare, b.utxo] })).toThrow(/needs `p2mr`/);
    const other = assembleScriptTree([checksigScript(account.derivePublicKey(6))]);
    expect(() =>
      payFromAccount(account, { ...options, utxos: [{ ...a.utxo, p2mr: { tree: other, leafIndex: 0 } }, b.utxo] }),
    ).toThrow(/does not commit to the script tree/);
  });
});

describe('buildPayment and finalizePayment', () => {
  const utxos = [coin(0, 40_000n), coin(1, 250_000n)];
  const options = { network, utxos, recipients: [{ address: recipient, amount: 100_000n }] as Recipient[], feeRate: 1000n, changeAddress };

  it('returns a PSBT an account can sign input by input', () => {
    const payment = buildPayment(options);
    expect(payment.transaction.ins.every((input) => input.witness.length === 0)).toBe(true);
    payment.inputs.forEach((input, i) => {
      account.prepareInput(payment.psbt, i, { index: input.index, value: input.value });
      account.signInput(payment.psbt, i, { index: input.index });
    });
    const signed = finalizePayment(payment);
    expect(signed.txid).toBe(payment.transaction.getId());
    expect(signed.vsize).toBe(payment.vsize);
    expectKeyPathSignatures(signed);
  });

  it('refuses a signed transaction that is not the payment', () => {
    const payment = buildPayment(options);
    const other = payFromAccount(account, { ...options, rbf: true });
    expect(() => finalizePayment(payment, { signed: other.transaction })).toThrow(/not the one this payment built/);
  });

  it('refuses a transaction whose witnesses are missing', () => {
    const payment = buildPayment(options);
    expect(() => finalizePayment(payment, { signed: payment.transaction })).toThrow('transaction has no witness data');
  });

  it('sets version and locktime when given', () => {
    const payment = buildPayment({ ...options, version: 2, locktime: 120, rbf: true });
    expect(payment.transaction.version).toBe(2);
    expect(payment.transaction.locktime).toBe(120);
  });
});

describe('payment properties', () => {
  it('builds only payments that cover their outputs, pay the relay fee and pass checkStandard', () => {
    const random = seededRandom(0xbead);
    const int = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
    const pick = <T,>(items: readonly T[]): T => items[int(0, items.length - 1)]!;
    let built = 0;
    for (let round = 0; round < 300; round += 1) {
      const utxos = Array.from({ length: int(1, 10) }, (_, i): Utxo => {
        const kind = pick(random() < 0.6 ? [INPUT_KINDS[0]] : INPUT_KINDS);
        return {
          txid: (round * 100 + i + 1).toString(16).padStart(64, '0'),
          vout: i,
          value: BigInt(int(300, pick([3_000, 60_000, 4_000_000]))),
          script: kind.script,
          confirmations: int(0, 3),
          ...(kind.spend === undefined ? {} : { spend: kind.spend }),
        };
      });
      const max = random() < 0.2;
      const recipients: Recipient[] = max
        ? [{ address: recipient, amount: 'max' }]
        : Array.from({ length: int(1, 3) }, (_, i) => ({
            address: account.deriveAddress(50 + i),
            amount: BigInt(int(333, pick([2_000, 50_000, 3_000_000]))),
          }));
      const feeRate = BigInt(pick([1000, 1001, 1500, 4321, 30_000]));
      let payment;
      try {
        payment = buildPayment({
          network, utxos, recipients, feeRate, changeAddress, random,
          strategy: pick(['largest', 'random', 'all'] as const),
          rbf: random() < 0.5,
        });
      } catch (err) {
        if (err instanceof InsufficientFundsError || /nothing above the dust limit/.test(String(err))) continue;
        throw err;
      }
      built += 1;

      // Fill in witnesses of the sizes signing produces and ask checkStandard.
      const signed = payment.transaction.clone();
      payment.inputs.forEach((input, i) => {
        expect(input.confirmations).toBeGreaterThanOrEqual(1);
        const kind = INPUT_KINDS.find((item) => item.script === input.script)!;
        signed.setWitness(i, kind.witness.map((size) => new Uint8Array(size).fill(1)));
      });
      checkStandard(signed, { prevouts: payment.prevouts });
      expect(signed.virtualSize()).toBe(payment.vsize);

      const paid = signed.outs.reduce((sum, output) => sum + output.value, 0n);
      const spent = payment.inputs.reduce((sum, input) => sum + input.value, 0n);
      expect(spent).toBe(paid + payment.fee);
      expect(payment.fee).toBeGreaterThanOrEqual(minRelayFee(signed.virtualSize()));
      expect(payment.fee).toBeGreaterThanOrEqual(minRelayFee(signed.virtualSize(), feeRate));
      for (const output of signed.outs) expect(isDust(output)).toBe(false);
      if (payment.changeIndex >= 0) {
        expect(signed.outs[payment.changeIndex]!.value).toBe(payment.change);
        expect(fromOutputScript(signed.outs[payment.changeIndex]!.script, network)).toBe(changeAddress);
      } else {
        expect(payment.change).toBe(0n);
        expect(signed.outs.length).toBe(recipients.length);
      }
      if (max) expect(payment.inputs.length).toBe(utxos.filter((utxo) => utxo.confirmations! >= 1).length);
    }
    expect(built).toBeGreaterThan(120);
  });
});

it('prices the selection case Oyster would underpay', () => {
  const vector = selectionCase('P2MR coins priced as key paths');
  const { spend } = INPUT_KINDS[1];
  const payment = buildPayment({
    network: networks.mainnet,
    utxos: coinsOf(vector).map((utxo) => ({ ...utxo, spend })),
    recipients: vector.outputs.map((output) => ({ script: hexToBytes(output.script), amount: BigInt(output.value) })),
    feeRate: 1000n,
    changeAddress: fromOutputScript(hexToBytes(vector.changeScript), networks.mainnet),
  });
  expect(payment.fee).toBeGreaterThan(BigInt(vector.fee));
  expect(payment.fee).toBe(minRelayFee(payment.vsize));
});
