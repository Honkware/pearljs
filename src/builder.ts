// Payments from a list of unspent outputs: coin selection as Oyster does it
// (coinselect.ts), change, the transaction and its PSBT, and for a BIP86
// account the signatures too. Everything returned has been through
// checkStandard, so a payment built here is one pearld's mempool takes.

/**
 * Payments from a list of unspent outputs: coin selection, change, the
 * unsigned transaction and its PSBT, and signing for a BIP86 account.
 *
 * @module
 */

import { Transaction } from 'bitcoinjs-lib';
import type { Psbt } from 'bitcoinjs-lib';
import { formatPearl } from './amount.js';
import { toOutputScript } from './address.js';
import { InsufficientFundsError, selectCoins, spendableUtxos } from './coinselect.js';
import type { CoinSelectionStrategy, SpendableOptions, Utxo } from './coinselect.js';
import type { PearlAccount, PearlSigningAccount } from './keys.js';
import type { PearlNetwork } from './networks.js';
import { checkStandard, estimateVsize, MAX_STANDARD_TX_VSIZE, minRelayFee } from './policy.js';
import { classifyOutputScript } from './script.js';
import { prepareP2mrScriptPathInput } from './scriptpath.js';
import type { ScriptTree } from './scripttree.js';
import { createPsbt, createTransaction, finalizePsbt } from './transaction.js';
import type { TxOutput } from './transaction.js';
import { p2mr } from './payments.js';
import { equalBytes } from './internal/bytes.js';
import { PearlError, PolicyError, SigningError } from './errors.js';
import type { FeeRate } from './amount.js';

const FINAL_SEQUENCE = 0xffffffff;
// mempool.MaxRBFSequence: an input at or under this signals replacement.
const RBF_SEQUENCE = 0xfffffffd;

/**
 * Adds an input by the transaction id that explorers and RPC show. The
 * classes' own addInput takes those bytes reversed.
 *
 * sequence is 0xffffffff unless given. Throws for a txid that is not 64 hex
 * characters or an output index outside 32 bits.
 */
export function addInputByTxid(target: Transaction | Psbt, txid: string, vout: number, sequence = FINAL_SEQUENCE): void {
  if (!/^[0-9a-fA-F]{64}$/.test(txid)) throw new Error('transaction id must be 64 hexadecimal characters');
  if (!Number.isInteger(vout) || vout < 0 || vout > 0xffffffff) throw new RangeError('output index must be a 32-bit unsigned integer');
  const hash = Uint8Array.from(txid.match(/../g)!, (byte) => parseInt(byte, 16)).reverse();
  if (target instanceof Transaction) target.addInput(hash, vout, sequence);
  else target.addInput({ hash, index: vout, sequence });
}

/** Where a payment goes. `amount: 'max'` sends everything the fee leaves, for at most one recipient. */
export type Recipient = ({ address: string } | { script: Uint8Array }) & { amount: bigint | 'max' };

/** What buildPayment needs: the unspent outputs to choose from, the recipients and the fee rate. */
export interface PaymentOptions<T extends Utxo = Utxo> extends SpendableOptions {
  network: PearlNetwork;
  /** Every unspent output the wallet may use; the ones to spend are chosen from these. */
  utxos: readonly T[];
  recipients: readonly Recipient[];
  /** Grain per 1000 vbytes. */
  feeRate: FeeRate;
  /** Needed unless a recipient takes `max` or changeFrom is given. */
  changeAddress?: string;
  /**
   * Take the change address from an account, at {index} on its change chain,
   * and record that derivation on the PSBT's change output (see
   * prepareOutput) so a signer elsewhere can prove the change is its own.
   * Give this or changeAddress, not both.
   */
  changeFrom?: { account: PearlAccount | PearlSigningAccount; index: number };
  /** Signal replace-by-fee. Oyster never does, so this is off unless asked for. */
  rbf?: boolean;
  /** `largest` unless given. A `max` payment always spends every output. */
  strategy?: CoinSelectionStrategy<T>;
  /**
   * Source of randomness for the `random` strategy, returning a number in [0,
   * 1). Math.random unless given.
   */
  random?: () => number;
  /** pearld's --minrelaytxfee if it is not the default, in grain per 1000 vbytes. */
  relayFeeRate?: FeeRate;
  /** 1 unless given, as Oyster uses. */
  version?: number;
  /** The transaction's locktime. 0 unless given. */
  locktime?: number;
}

/** An unsigned payment, as buildPayment returns it. Amounts are in grain. */
export interface Payment<T extends Utxo = Utxo> {
  /** The unsigned transaction. */
  transaction: Transaction;
  /**
   * The same transaction as a PSBT. Its inputs are bare: prepareInput and
   * the script-path prepare functions add each witness UTXO, which can be
   * set only once.
   */
  psbt: Psbt;
  /** The outputs being spent, in input order. */
  inputs: T[];
  prevouts: TxOutput[];
  /** Inputs minus outputs, in grain. */
  fee: bigint;
  /** The size the transaction will have once signed. */
  vsize: number;
  /** Value of the change output, or 0n when there is none. */
  change: bigint;
  /** Position of the change output, or -1. Change goes last; Oyster shuffles it. */
  changeIndex: number;
}

function recipientScript(recipient: Recipient, network: PearlNetwork): Uint8Array {
  return 'address' in recipient ? toOutputScript(recipient.address, network) : recipient.script;
}

/**
 * Chooses inputs for the recipients, adds change, and returns the unsigned
 * transaction with its PSBT. Throws InsufficientFundsError when the outputs
 * cannot be paid for, and pearld's own message when the result would not be
 * relayed (a dust output, a fee under the relay minimum, too large).
 */
export function buildPayment<T extends Utxo>(options: PaymentOptions<T>): Payment<T> {
  const { network, recipients, feeRate } = options;
  if (recipients.length === 0) throw new PearlError('PAYMENT_INVALID', 'a payment needs at least one recipient');
  const maxIndex = recipients.findIndex((recipient) => recipient.amount === 'max');
  if (recipients.some((recipient, i) => recipient.amount === 'max' && i !== maxIndex)) {
    throw new PearlError('PAYMENT_INVALID', 'only one recipient can take the maximum');
  }
  const outpoints = new Set(options.utxos.map((utxo) => `${utxo.txid.toLowerCase()}:${utxo.vout}`));
  if (outpoints.size !== options.utxos.length) throw new PearlError('PAYMENT_INVALID', 'the unspent outputs contain duplicates');

  const fixed: TxOutput[] = recipients
    .filter((recipient) => recipient.amount !== 'max')
    .map((recipient) => ({ script: recipientScript(recipient, network), value: recipient.amount as bigint }));
  let remainderScript: Uint8Array;
  if (maxIndex >= 0) remainderScript = recipientScript(recipients[maxIndex]!, network);
  else if (options.changeFrom !== undefined) {
    if (options.changeAddress !== undefined) throw new PearlError('PAYMENT_INVALID', 'give changeAddress or changeFrom, not both');
    remainderScript = toOutputScript(options.changeFrom.account.deriveAddress(options.changeFrom.index, true), network);
  } else if (options.changeAddress !== undefined) remainderScript = toOutputScript(options.changeAddress, network);
  else throw new PearlError('PAYMENT_INVALID', 'a change address is needed unless a recipient takes the maximum');

  const spendable = spendableUtxos(options.utxos, options);
  let selection;
  try {
    selection = selectCoins({
      utxos: spendable,
      outputs: fixed,
      feeRate,
      changeScript: remainderScript,
      strategy: maxIndex >= 0 ? 'all' : (options.strategy ?? 'largest'),
      ...(options.random === undefined ? {} : { random: options.random }),
    });
  } catch (err) {
    const skipped = options.utxos.length - spendable.length;
    if (!(err instanceof InsufficientFundsError) || skipped === 0) throw err;
    throw new InsufficientFundsError(err.available, err.required, err.fee, skipped);
  }
  if (maxIndex >= 0 && selection.change === 0n) {
    throw new PearlError('PAYMENT_INVALID',
      `nothing above the dust limit is left to send: ${formatPearl(selection.totalInput)} PRL in, ` +
        `${formatPearl(selection.totalInput - selection.fee)} PRL to the other recipients`,
    );
  }

  const outputs = [...fixed];
  let changeIndex = -1;
  if (maxIndex >= 0) {
    outputs.splice(maxIndex, 0, { script: remainderScript, value: selection.change });
  } else if (selection.change > 0n) {
    changeIndex = outputs.push({ script: remainderScript, value: selection.change }) - 1;
  }

  const tx = createTransaction(options.version ?? 1);
  tx.locktime = options.locktime ?? 0;
  const sequence = options.rbf === true ? RBF_SEQUENCE : FINAL_SEQUENCE;
  for (const input of selection.inputs) addInputByTxid(tx, input.txid, input.vout, sequence);
  for (const output of outputs) tx.addOutput(output.script, output.value);
  const prevouts = selection.inputs.map((input) => ({ script: input.script, value: input.value }));
  const psbt = createPsbt(tx);
  if (changeIndex >= 0 && options.changeFrom !== undefined) {
    options.changeFrom.account.prepareOutput(psbt, changeIndex, { index: options.changeFrom.index, change: true });
  }

  const fee = selection.totalInput - outputs.reduce((sum, output) => sum + output.value, 0n);
  const vsize = estimateVsize(tx, selection.inputs.map((input) => input.spend ?? { type: 'keyPath' }));
  checkUnsigned(tx, fee, vsize, options.relayFeeRate);
  return {
    transaction: tx,
    psbt,
    inputs: selection.inputs,
    prevouts,
    fee,
    vsize,
    change: changeIndex < 0 ? 0n : selection.change,
    changeIndex,
  };
}

/**
 * checkStandard wants witnesses, so the unsigned transaction is checked with
 * placeholders and its size and fee against the size it will have signed.
 */
function checkUnsigned(tx: Transaction, fee: bigint, vsize: number, relayFeeRate: bigint | undefined): void {
  const probe = tx.clone();
  probe.ins.forEach((_, i) => probe.setWitness(i, [new Uint8Array(1)]));
  checkStandard(probe, relayFeeRate === undefined ? {} : { relayFeeRate: relayFeeRate });
  if (vsize > MAX_STANDARD_TX_VSIZE) {
    throw new PolicyError('POLICY_TX_TOO_LARGE', `vsize of transaction is larger than max allowed: ${vsize} > ${MAX_STANDARD_TX_VSIZE}`);
  }
  const required = minRelayFee(vsize, relayFeeRate);
  if (fee < required) {
    throw new PolicyError('POLICY_FEE_TOO_LOW',
      `the fee of ${fee} grain is under the ${required} grain pearld requires to relay ${vsize} vbytes; raise the fee rate`,
    );
  }
}

/**
 * A signed payment ready to broadcast, as finalizePayment and payFromAccount
 * return it. Amounts are in grain.
 */
export interface SignedPayment<T extends Utxo = Utxo> {
  /** The signed transaction, checked against pearld's relay policy. */
  transaction: Transaction;
  /** What sendrawtransaction takes. */
  hex: string;
  /** Transaction id as explorers and RPC show it. */
  txid: string;
  /** The outputs spent, in input order. */
  inputs: T[];
  /** Script and value of each spent output, in input order. */
  prevouts: TxOutput[];
  /** Inputs minus outputs, in grain. */
  fee: bigint;
  /** Size of the signed transaction in vbytes. */
  vsize: number;
  /** Value of the change output in grain, or 0n when there is none. */
  change: bigint;
  /** Position of the change output, or -1. */
  changeIndex: number;
}

/**
 * Turns a payment whose PSBT has been signed into the transaction to
 * broadcast: finalizes every input, extracts, and runs checkStandard with
 * the input values. Pass `signed` for a transaction signed outside the PSBT.
 *
 * Throws when the signed transaction is not the one the payment built, when an
 * input cannot be finalized, and with pearld's message when the result would not
 * be relayed. relayFeeRate is in grain per 1000 vbytes. Signatures of a
 * transaction passed as `signed` are not verified.
 */
export function finalizePayment<T extends Utxo>(
  payment: Payment<T>,
  options: { signed?: Transaction; relayFeeRate?: FeeRate } = {},
): SignedPayment<T> {
  const transaction = options.signed ?? finalizePsbt(payment.psbt);
  if (transaction.getId() !== payment.transaction.getId()) {
    throw new SigningError('TRANSACTION_MISMATCH', 'the signed transaction is not the one this payment built');
  }
  checkStandard(transaction, {
    prevouts: payment.prevouts,
    ...(options.relayFeeRate === undefined ? {} : { relayFeeRate: options.relayFeeRate }),
  });
  return {
    transaction,
    hex: transaction.toHex(),
    txid: transaction.getId(),
    inputs: payment.inputs,
    prevouts: payment.prevouts,
    fee: payment.fee,
    vsize: transaction.virtualSize(),
    change: payment.change,
    changeIndex: payment.changeIndex,
  };
}

/** An unspent output of a BIP86 account, with the child that holds it. */
export interface AccountUtxo extends Utxo {
  /** Address index of the child key. */
  index: number;
  /** Whether the child is on the change chain (m/86'/coin'/account'/1/index). */
  change?: boolean;
  /**
   * For a P2MR output: its script tree and the leaf to spend, which must be
   * `<child key> OP_CHECKSIG` or another leaf that pushes the child key.
   */
  p2mr?: { tree: ScriptTree; leafIndex: number };
}

/** Options for payFromAccount. Every input is signed with SIGHASH_DEFAULT. */
export interface AccountPaymentOptions extends PaymentOptions<AccountUtxo> {
  /**
   * Transactions that created the P2MR outputs being spent, attached to
   * their inputs so the signer can check input values.
   */
  previousTransactions?: readonly Transaction[];
  /** Sign P2MR inputs without checking input values against previousTransactions. */
  trustPrevouts?: boolean;
}

/**
 * Builds, signs and finalizes a payment from a BIP86 account in one call.
 * Each unspent output names the child that holds it; P2TR outputs are signed
 * by key path and P2MR outputs through the leaf given for them.
 *
 * Throws what buildPayment throws, and also when an unspent output does not pay
 * the child named for it, a P2MR output comes without its tree or does not
 * commit to it, or a signer refuses (see signInput and signP2mrScriptPathInput).
 * Nothing is broadcast.
 */
export function payFromAccount(account: PearlSigningAccount, options: AccountPaymentOptions): SignedPayment<AccountUtxo> {
  const utxos = options.utxos.map((utxo) => {
    if (classifyOutputScript(utxo.script) === 'p2mr') {
      if (utxo.p2mr === undefined) {
        throw new PearlError('UTXO_INVALID', `unspent output ${utxo.txid}:${utxo.vout} is P2MR and needs \`p2mr\` to name its tree and leaf`);
      }
      if (!equalBytes(utxo.script, p2mr({ merkleRoot: utxo.p2mr.tree.root }).output)) {
        throw new PearlError('UTXO_INVALID', `unspent output ${utxo.txid}:${utxo.vout} does not commit to the script tree given for it`);
      }
      return utxo.spend === undefined
        ? { ...utxo, spend: { type: 'scriptPath' as const, tree: utxo.p2mr.tree, leafIndex: utxo.p2mr.leafIndex, p2mr: true } }
        : utxo;
    }
    const address = account.deriveAddress(utxo.index, utxo.change ?? false);
    if (!equalBytes(utxo.script, toOutputScript(address, options.network))) {
      throw new PearlError('UTXO_INVALID',
        `unspent output ${utxo.txid}:${utxo.vout} does not pay the account's child ${utxo.change === true ? 1 : 0}/${utxo.index}`,
      );
    }
    return utxo;
  });
  const payment = buildPayment({ ...options, utxos });
  const { psbt } = payment;
  const previous = new Map((options.previousTransactions ?? []).map((tx) => [tx.getId(), tx]));
  payment.inputs.forEach((utxo, i) => {
    if (utxo.p2mr === undefined) {
      account.prepareInput(psbt, i, { index: utxo.index, change: utxo.change ?? false, value: utxo.value });
      return;
    }
    const previousTransaction = previous.get(utxo.txid.toLowerCase());
    prepareP2mrScriptPathInput(psbt, i, {
      ...utxo.p2mr,
      value: utxo.value,
      ...(previousTransaction === undefined ? {} : { previousTransaction }),
    });
  });
  payment.inputs.forEach((utxo, i) => {
    const child = { index: utxo.index, change: utxo.change ?? false };
    if (utxo.p2mr === undefined) {
      account.signInput(psbt, i, child);
      return;
    }
    const leaf = utxo.p2mr.tree.leaves[utxo.p2mr.leafIndex]!;
    account.signScriptPathInput(psbt, i, {
      ...child,
      leafHash: leaf.leafHash,
      ...(options.trustPrevouts === undefined ? {} : { trustPrevouts: options.trustPrevouts }),
    });
  });
  return finalizePayment(payment, {
    ...(options.relayFeeRate === undefined ? {} : { relayFeeRate: options.relayFeeRate }),
  });
}

