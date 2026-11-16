// Replace-by-fee against pearld's mempool: a transaction that signals with a
// sequence of MAX_RBF_SEQUENCE or lower is replaced by a pearljs-built
// transaction paying exactly replacementFee, and for the ones pearld refuses
// checkReplacement throws the reason testmempoolaccept gives.

import { beforeAll, expect, it } from 'vitest';
import {
  checkReplacement,
  checkStandard,
  createPsbt,
  createTransaction,
  deriveSigningAccountFromSeed,
  embed,
  feeForVsize,
  finalizePsbt,
  MAX_RBF_SEQUENCE,
  minRelayFee,
  mnemonicToSeed,
  PearlRpcError,
  PolicyError,
  replacementFee,
  RPC_ERROR_CODES,
  serializeTransaction,
  signalsReplacement,
  toOutputScript,
  transactionId,
} from '../src/index.js';
import type { MempoolTx, PearlErrorCode, Transaction } from '../src/index.js';
import { broadcast, changeScript, confirm, describeLive, FEE_RATE, fund, network, pearld, prevoutsOf, testMempoolAccept } from './chain.js';

const account = deriveSigningAccountFromSeed(mnemonicToSeed('zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong'), network);
const VALUE = 100_000_000n;
const BASE = 120;
const note = embed({ data: new Uint8Array(80).fill(0x52) }).output;

describeLive('replace-by-fee', () => {
  let funding: Transaction;
  beforeAll(async () => {
    funding = await fund([0, 1].map((i) => ({ script: toOutputScript(account.deriveAddress(BASE + i), network), value: VALUE })));
  });

  /** Spends funding output vout, leaving exactly fee. */
  function pay(vout: number, fee: bigint, options: { sequence?: number; withNote?: boolean } = {}): Transaction {
    const tx = createTransaction(2);
    tx.addInput(funding.getHash(), vout, options.sequence);
    tx.addOutput(changeScript, VALUE - fee);
    if (options.withNote === true) tx.addOutput(note, 0n);
    const psbt = createPsbt(tx);
    account.prepareInput(psbt, 0, { index: BASE + vout, value: VALUE });
    account.signInput(psbt, 0, { index: BASE + vout });
    const signed = finalizePsbt(psbt);
    checkStandard(signed, { prevouts: prevoutsOf(signed, [funding]) });
    return signed;
  }
  const rate = (tx: Transaction, fee: bigint): bigint => (fee * 1000n) / BigInt(tx.virtualSize());

  /** checkReplacement's refusal against a mempool holding only original, which pearld must give too. */
  async function expectSameRefusal(tx: Transaction, fee: bigint, original: MempoolTx, code: PearlErrorCode): Promise<string> {
    let predicted = '';
    try {
      checkReplacement(tx, fee, new Map([[transactionId(original.tx), original]]));
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyError);
      expect((error as PolicyError).code).toBe(code);
      predicted = (error as Error).message;
    }
    expect(predicted).not.toBe('');
    expect(await testMempoolAccept(tx)).toMatchObject({ allowed: false, 'reject-reason': predicted });
    return predicted;
  }

  it('replaces a signaling transaction only when the replacement pays a higher rate and for its own relay', async () => {
    const size = { original: pay(0, 1000n, { withNote: true }).virtualSize(), replacement: pay(0, 1000n).virtualSize() };
    const fee = feeForVsize(size.original, FEE_RATE);
    const original = pay(0, fee, { sequence: MAX_RBF_SEQUENCE, withNote: true });
    await broadcast(original);

    const inPool = { tx: original, fee };
    expect(signalsReplacement(original)).toBe(true);

    // The same rate is not enough.
    const sameRateFee = (rate(original, fee) * BigInt(size.replacement)) / 1000n;
    const sameRate = pay(0, sameRateFee);
    expect(await expectSameRefusal(sameRate, sameRateFee, inPool, 'RBF_FEE_RATE_TOO_LOW')).toBe(
      `${transactionId(sameRate)}: replacement transaction has an insufficient fee rate: needs more than ${rate(original, fee)}, has ${rate(sameRate, sameRateFee)}`,
    );

    // A higher rate from being smaller is not enough either: the fee must
    // cover the original's fee and the replacement's own minimum relay fee.
    const needed = replacementFee([{ fee, vsize: size.original }], size.replacement);
    expect(needed).toBe(fee + minRelayFee(size.replacement));
    const underpaid = pay(0, needed - 1n);
    expect(rate(underpaid, needed - 1n)).toBeGreaterThan(rate(original, fee));
    expect(await expectSameRefusal(underpaid, needed - 1n, inPool, 'RBF_FEE_TOO_LOW')).toBe(
      `${transactionId(underpaid)}: replacement transaction has an insufficient absolute fee: needs ${needed}, has ${needed - 1n}`,
    );

    // Exactly enough. The replacement itself does not signal.
    const replacement = pay(0, needed);
    expect(checkReplacement(replacement, needed, new Map([[transactionId(original), inPool]]))).toEqual([
      transactionId(original),
    ]);
    expect(await testMempoolAccept(replacement)).toMatchObject({ allowed: true, fees: { base: needed } });
    await broadcast(replacement);
    expect(await pearld.getRawMempool()).toEqual([transactionId(replacement)]);
    await expect(pearld.getRawTransaction(transactionId(original))).rejects.toMatchObject({
      kind: 'rpc',
      rpcCode: RPC_ERROR_CODES.INVALID_ADDRESS_OR_KEY,
    });

    // So it cannot be replaced in turn, whatever the fee.
    expect(signalsReplacement(replacement)).toBe(false);
    const second = pay(0, 10n * needed);
    const spent = await expectSameRefusal(second, 10n * needed, { tx: replacement, fee: needed }, 'RBF_NOT_REPLACEABLE');
    expect(spent).toBe(`output already spent in mempool: output=${funding.getId()}:0, tx=${transactionId(replacement)}`);
    const refused = await pearld.sendRawTransaction(serializeTransaction(second)).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(PearlRpcError);
    expect(refused).toMatchObject({ code: 'RPC_ERROR', kind: 'rpc', rpcCode: RPC_ERROR_CODES.TX_REJECTED });
    expect((refused as PearlRpcError).message).toContain(spent);

    await confirm(replacement);
  });

  it('refuses to replace a transaction whose inputs all have a sequence above MAX_RBF_SEQUENCE', async () => {
    const fee = feeForVsize(pay(1, 1000n).virtualSize(), FEE_RATE);
    const original = pay(1, fee, { sequence: MAX_RBF_SEQUENCE + 1 });
    await broadcast(original);
    expect(signalsReplacement(original)).toBe(false);
    const replacement = pay(1, 10n * fee, { sequence: MAX_RBF_SEQUENCE });
    expect(await expectSameRefusal(replacement, 10n * fee, { tx: original, fee }, 'RBF_NOT_REPLACEABLE')).toBe(
      `output already spent in mempool: output=${funding.getId()}:1, tx=${transactionId(original)}`,
    );
    await confirm(original);
  });
});
