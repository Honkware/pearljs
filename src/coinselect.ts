// Coin selection the way Oyster does it (wallet/wallet/createtx.go and
// wallet/wallet/txauthor/author.go), so a pearljs wallet picks the same
// inputs, change and fee as Pearl's own for the same unspent outputs. Pure
// functions over a list of unspent outputs; nothing here talks to a node.
//
// Fee rates are grain per 1000 vbytes, as in policy.ts and Oyster's RPC.

/**
 * Coin selection as Oyster does it. Pure functions over a list of unspent
 * outputs.
 *
 * @module
 */

import { Transaction } from 'bitcoinjs-lib';
import { formatPearl, MAX_GRAIN } from './amount.js';
import { COINBASE_MATURITY } from './consensus.js';
import { DEFAULT_RELAY_FEE_RATE, estimateVsize, isDust, minRelayFee } from './policy.js';
import type { SpendEstimate } from './policy.js';
import { classifyOutputScript } from './script.js';
import { varIntSize } from './internal/bytes.js';
import { PearlError } from './errors.js';
import type { FeeRate } from './amount.js';
import type { TxOutput } from './transaction.js';

/** An unspent output as coin selection takes it. */
export interface Utxo {
  /** Transaction id as explorers and RPC show it. */
  txid: string;
  /** Index of the output in its transaction. */
  vout: number;
  /** In grain. */
  value: bigint;
  /** The output script (scriptPubKey). */
  script: Uint8Array;
  /** As listunspent reports them; left out or 0 for an unconfirmed output. */
  confirmations?: number;
  /** Whether a coinbase transaction created the output. */
  coinbase?: boolean;
  /**
   * How the input will be spent, which sets its price. A P2TR output is taken
   * as a key-path spend when this is left out; a P2MR output needs it.
   */
  spend?: SpendEstimate;
}

/** Which unspent outputs may be spent. */
export interface SpendableOptions {
  /** Confirmations an output needs. Oyster's sends use 1. */
  minConfirmations?: number;
  /** Confirmations a coinbase output needs. COINBASE_MATURITY (100) unless given. */
  coinbaseMaturity?: number;
}

/** wallet.calcConf: confirmations of an output from its block height, 0 when unconfirmed or above the tip. */
export function confirmations(height: number | undefined, tipHeight: number): number {
  if (height === undefined || height < 0 || height > tipHeight) return 0;
  return tipHeight - height + 1;
}

/**
 * The outputs Oyster would consider for a send (findEligibleOutputs,
 * createtx.go:347-389): enough confirmations, and coinbase outputs only once
 * they have matured. Outputs of zero value are left out, as sweepaccount does.
 */
export function spendableUtxos<T extends Utxo>(utxos: readonly T[], options: SpendableOptions = {}): T[] {
  const minimum = options.minConfirmations ?? 1;
  const maturity = options.coinbaseMaturity ?? COINBASE_MATURITY;
  return utxos.filter((utxo) => {
    const confs = utxo.confirmations ?? 0;
    if (utxo.value === 0n || confs < minimum) return false;
    return utxo.coinbase !== true || confs >= maturity;
  });
}

/** Oyster's CoinSelectionStrategy.ArrangeCoins: the order coins are offered in, and which are offered at all. */
export type CoinArranger<T extends Utxo = Utxo> = (utxos: readonly T[], feeRate: FeeRate) => T[];

/**
 * `largest` and `random` are Oyster's two strategies; coins are added in the
 * arranged order until they cover the outputs and the fee. `all` spends every
 * coin given, as Oyster does with outputs the user picked.
 */
export type CoinSelectionStrategy<T extends Utxo = Utxo> = 'largest' | 'random' | 'all' | CoinArranger<T>;

/**
 * The order a strategy offers coins in. `largest` sorts by value, largest
 * first (Go's sort is not stable, so coins of equal value may come out in
 * another order than Oyster's). `random` drops coins that cost more to spend
 * than they are worth at the fee rate, then shuffles.
 */
export function arrangeCoins<T extends Utxo>(
  utxos: readonly T[],
  strategy: CoinSelectionStrategy<T>,
  feeRate: FeeRate,
  random: () => number = Math.random,
): T[] {
  if (typeof strategy === 'function') return strategy(utxos, feeRate);
  if (strategy === 'all') return [...utxos];
  if (strategy === 'largest') {
    return [...utxos].sort((a, b) => (a.value === b.value ? 0 : a.value > b.value ? -1 : 1));
  }
  const coins = utxos.filter((utxo) => yieldsPositively(utxo, feeRate));
  for (let i = coins.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [coins[i], coins[j]] = [coins[j]!, coins[i]!];
  }
  return coins;
}

// txsizes.GetMinInputVirtualSize: 41 bytes and a 67-unit witness.
const KEY_PATH_INPUT_VSIZE = 58;
// A transaction with one input and no outputs, without its witness.
const BARE_INPUT_TX_SIZE = 51;

/** inputYieldsPositively (createtx.go:424-431), with the real size for inputs that are not key-path spends. */
function yieldsPositively(utxo: Utxo, feeRate: FeeRate): boolean {
  let size = KEY_PATH_INPUT_VSIZE;
  if (utxo.spend !== undefined && utxo.spend.type !== 'keyPath') {
    const tx = new Transaction();
    tx.addInput(new Uint8Array(32), 0);
    size = estimateVsize(tx, [utxo.spend]) - BARE_INPUT_TX_SIZE + 41;
  }
  return (feeRate * BigInt(size)) / 1000n < utxo.value;
}

/** What selectCoins needs. */
export interface SelectCoinsOptions<T extends Utxo = Utxo> {
  utxos: readonly T[];
  outputs: readonly TxOutput[];
  /** Grain per 1000 vbytes. */
  feeRate: FeeRate;
  /** Where the remainder goes. The fee always pays for this output, as in Oyster. */
  changeScript: Uint8Array;
  strategy?: CoinSelectionStrategy<T>;
  /** Source of randomness for the `random` strategy, returning [0, 1). */
  random?: () => number;
}

/** The result of selectCoins. Amounts are in grain. */
export interface CoinSelection<T extends Utxo = Utxo> {
  /** The coins to spend, in input order. */
  inputs: T[];
  /** Sum of the chosen coins, in grain. */
  totalInput: bigint;
  /** In grain: the fee rate times vsize, rounded down, plus any remainder too small to be change. */
  fee: bigint;
  /** Value of the change output, or 0n when there is none. */
  change: bigint;
  /** The signed size the fee was worked out for, change output included. */
  vsize: number;
}

/** Thrown when the coins do not cover the outputs and the fee. Amounts are in grain. */
export class InsufficientFundsError extends PearlError {
  override name = 'InsufficientFundsError';
  /** Total value of the coins that could be spent. */
  readonly available: bigint;
  /** Outputs plus the fee for spending every one of those coins. */
  readonly required: bigint;
  /** The fee inside `required`. */
  readonly fee: bigint;
  /** How much more is needed. */
  readonly missing: bigint;

  /** `skipped` counts outputs that were held back as unconfirmed or immature. */
  constructor(available: bigint, required: bigint, fee: bigint, skipped = 0) {
    super(
      'INSUFFICIENT_FUNDS',
      `insufficient funds: ${prl(required - available)} short ` +
        `(${prl(available)} spendable, ${prl(required)} needed including a fee of ${prl(fee)})` +
        (skipped === 0 ? '' : `; ${skipped} unspent outputs were left out as unconfirmed, immature or empty`),
    );
    this.available = available;
    this.required = required;
    this.fee = fee;
    this.missing = required - available;
  }
}

/**
 * txauthor.NewUnsignedTransaction (author.go:106-178): takes coins in the
 * strategy's order until they cover the outputs and the fee, prices the fee
 * again for the inputs actually taken, and takes more if that fee no longer
 * fits. What is left becomes change unless it is zero or dust, in which case
 * it goes to the fee.
 *
 * Throws InsufficientFundsError when every coin together does not cover the
 * outputs and the fee.
 */
export function selectCoins<T extends Utxo>(options: SelectCoinsOptions<T>): CoinSelection<T> {
  const { outputs, feeRate, changeScript } = options;
  if (typeof feeRate !== 'bigint' || feeRate < 0n) throw new PearlError('FEE_RATE_INVALID', 'fee rate must be a bigint of grain per 1000 vbytes');
  const target = outputs.reduce((sum, output) => {
    if (typeof output.value !== 'bigint') throw new TypeError('output value must be a bigint of grains');
    if (output.value < 0n) throw new PearlError('AMOUNT_OUT_OF_RANGE', 'transaction output amount is negative');
    return sum + output.value;
  }, 0n);
  if (target > MAX_GRAIN) throw new PearlError('AMOUNT_OUT_OF_RANGE', 'sum of output values exceeds the maximum amount');

  const strategy = options.strategy ?? 'largest';
  const coins = arrangeCoins(options.utxos, strategy, feeRate, options.random);
  for (const coin of coins) checkCoin(coin);
  const price = (count: number): { vsize: number; fee: bigint } => {
    const vsize = signedVsize(coins.slice(0, count), outputs, changeScript);
    // txrules.FeeForSerializeSize (rules.go:57-69) is the arithmetic of
    // pearld's relay minimum: it rounds down, where feeForVsize rounds up.
    return { vsize, fee: minRelayFee(vsize, feeRate) };
  };

  let taken = strategy === 'all' ? coins.length : 0;
  let total = coins.slice(0, taken).reduce((sum, coin) => sum + coin.value, 0n);
  // The first target is priced with no inputs at all (author.go:113-116).
  let targetFee = price(0).fee;
  for (;;) {
    while (total < target + targetFee && taken < coins.length) {
      total += coins[taken]!.value;
      taken += 1;
    }
    if (total < target + targetFee) {
      const all = price(coins.length);
      throw new InsufficientFundsError(total, target + all.fee, all.fee);
    }
    const { vsize, fee } = price(taken);
    if (total - target < fee) {
      targetFee = fee;
      continue;
    }
    const remainder = total - target - fee;
    // Oyster tests change against the default relay fee whatever the fee
    // rate of the transaction (author.go:159-160).
    const keep = remainder !== 0n && !isDust({ script: changeScript, value: remainder }, DEFAULT_RELAY_FEE_RATE);
    return {
      inputs: coins.slice(0, taken),
      totalInput: total,
      fee: keep ? fee : total - target,
      change: keep ? remainder : 0n,
      vsize,
    };
  }
}

function prl(grain: bigint): string {
  return grain <= MAX_GRAIN ? `${formatPearl(grain)} PRL` : `${grain} grain`;
}

function checkCoin(coin: Utxo): void {
  if (typeof coin.value !== 'bigint' || coin.value < 0n || coin.value > MAX_GRAIN) {
    throw new PearlError('UTXO_INVALID', `unspent output ${coin.txid}:${coin.vout} has a value outside Pearl amount bounds`);
  }
  const kind = classifyOutputScript(coin.script);
  if (kind !== 'p2tr' && kind !== 'p2mr') {
    throw new PearlError('UTXO_INVALID', `unspent output ${coin.txid}:${coin.vout} is not a supported address type (p2tr or p2mr)`);
  }
  // Oyster prices a P2MR input as a key path (txsizes/size.go:97-131), which
  // is too little for any script path; the leaf has to be known instead.
  if (kind === 'p2mr' && (coin.spend === undefined || coin.spend.type === 'keyPath')) {
    throw new PearlError('UTXO_INVALID', `unspent output ${coin.txid}:${coin.vout} is P2MR and needs \`spend\` to say which leaf will be used`);
  }
}

/**
 * The size a fee is charged for. For key-path inputs this is
 * txsizes.EstimateVirtualSize (size.go:97-131), which is a little above the
 * real size: it allows 65 bytes per signature and counts one varint more in
 * the witness. Other inputs make the real size larger than that, and then
 * the real size from estimateVsize is used.
 */
function signedVsize(inputs: readonly Utxo[], outputs: readonly TxOutput[], changeScript: Uint8Array): number {
  const tx = new Transaction();
  inputs.forEach(() => tx.addInput(new Uint8Array(32), 0));
  for (const output of [...outputs, { script: changeScript, value: 0n }]) tx.addOutput(output.script, output.value);
  const base = tx.byteLength(false);
  if (inputs.length === 0) return base;
  const witnessWeight = 2 + varIntSize(inputs.length) + inputs.length * 67;
  const oyster = base + Math.ceil(witnessWeight / 4);
  if (inputs.every((input) => input.spend === undefined)) return oyster;
  return Math.max(oyster, estimateVsize(tx, inputs.map((input) => input.spend ?? { type: 'keyPath' })));
}

