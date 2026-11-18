// The fee ceiling on wallet spends: send, bumpFee and sweep, from account,
// imported and XMSS coins, refuse a fee above maxFeeRate before anything is
// signed or recorded, whether the rate came from the caller or the backend,
// and a rate the backend estimates is checked like any other answer of its.

import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_MAX_FEE_RATE, encodeWif, keyPathAddress, networks, parsePearl } from '../src/index.js';
import type { PearlWallet } from '../src/index.js';
import type * as Ecc from 'tiny-secp256k1';
import type * as Builder from '../src/builder.js';
import { FakeChain, STRANGER, newWallet } from './wallet-chain.js';

const network = networks.regtest;
const prl = (text: string): bigint => parsePearl(text);
// Schnorr signatures made, so a test can tell a refusal before signing from one after, and a
// switch that makes every payment built pay this much more fee than its rate asks.
const signatures = vi.hoisted(() => ({ count: 0 }));
const overpay = vi.hoisted(() => ({ by: 0n }));
vi.mock('../src/builder.js', async (importOriginal) => {
  const builder = await importOriginal<typeof Builder>();
  return {
    ...builder,
    buildPayment: (...args: Parameters<typeof builder.buildPayment>) => {
      const payment = builder.buildPayment(...args);
      if (overpay.by > 0n) payment.transaction.outs[0]!.value -= overpay.by;
      return payment;
    },
  };
});
vi.mock('tiny-secp256k1', async (importOriginal) => {
  const ecc = await importOriginal<typeof Ecc>();
  return {
    ...ecc,
    signSchnorr: (...args: Parameters<typeof ecc.signSchnorr>) => {
      signatures.count += 1;
      return ecc.signSchnorr(...args);
    },
  };
});

const feeTooHigh = expect.objectContaining({ name: 'SigningError', code: 'FEE_TOO_HIGH' });
const pay = (amount: string) => [{ address: STRANGER, amount: prl(amount) }];

async function funded(amount = '1000'): Promise<{ chain: FakeChain; wallet: PearlWallet }> {
  const chain = new FakeChain();
  const wallet = await newWallet(chain);
  chain.pay(await wallet.receiveAddress(), prl(amount));
  chain.mine();
  await wallet.sync();
  return { chain, wallet };
}

describe('wallet: fee ceiling', () => {
  it('refuses a send at a rate the backend estimates above the ceiling, and records nothing', async () => {
    const { chain, wallet } = await funded();
    chain.feeRate = prl('5000');
    await expect(wallet.send({ recipients: pay('1') })).rejects.toEqual(feeTooHigh);
    expect(chain.mempool.size).toBe(0);
    expect(wallet.history()).toHaveLength(1);
    expect(wallet.balance().confirmed).toBe(prl('1000'));
    chain.feeRate = DEFAULT_MAX_FEE_RATE + 1n;
    await expect(wallet.send({ recipients: pay('1') })).rejects.toEqual(feeTooHigh);
    chain.feeRate = DEFAULT_MAX_FEE_RATE;
    const sent = await wallet.send({ recipients: pay('1') });
    expect(sent.fee).toBeLessThanOrEqual((DEFAULT_MAX_FEE_RATE * BigInt(sent.vsize + 1)) / 1000n);
  });

  it('refuses a rate the caller gives above the ceiling until the ceiling is raised', async () => {
    const { chain, wallet } = await funded();
    const feeRate = DEFAULT_MAX_FEE_RATE * 2n;
    await expect(wallet.send({ recipients: pay('1'), feeRate })).rejects.toEqual(feeTooHigh);
    await expect(wallet.send({ recipients: pay('1'), feeRate: 3000n, maxFeeRate: 2999n })).rejects.toEqual(feeTooHigh);
    const sent = await wallet.send({ recipients: pay('1'), feeRate, maxFeeRate: feeRate });
    expect(chain.mempool.has(sent.txid)).toBe(true);
    expect(sent.fee).toBeGreaterThan((DEFAULT_MAX_FEE_RATE * BigInt(sent.vsize)) / 1000n);
  });

  it('holds the transaction itself to the ceiling, not the rate it was built with', async () => {
    // What is left after the fee is dust and joins it, so the fee paid is well above the rate asked for.
    const { chain, wallet } = await funded('1');
    const recipients = [{ address: STRANGER, amount: prl('1') - 400n }];
    await expect(wallet.send({ recipients, feeRate: 2000n, maxFeeRate: 2000n })).rejects.toEqual(feeTooHigh);
    expect(chain.mempool.size).toBe(0);
    const sent = await wallet.send({ recipients, feeRate: 2000n });
    expect(sent.fee).toBe(400n);
  });

  it('refuses a fee rate from the backend that is not a positive bigint', async () => {
    const { chain, wallet } = await funded();
    for (const answer of [0n, -1n, 2000, '2000', null]) {
      chain.estimateFeeRate = async () => answer as never;
      await expect(wallet.send({ recipients: pay('1') })).rejects.toMatchObject({ code: 'BACKEND_RESPONSE' });
    }
    await expect(wallet.send({ recipients: pay('1'), feeRate: -1n })).rejects.toMatchObject({ code: 'FEE_RATE_INVALID' });
    await expect(wallet.send({ recipients: pay('1'), feeRate: 2000n, maxFeeRate: 5 as never })).rejects.toMatchObject({ code: 'FEE_RATE_INVALID' });
    expect(chain.mempool.size).toBe(0);
  });

  it('holds a replacement to the ceiling, including the fee the replacement rules add', async () => {
    const { chain, wallet } = await funded();
    const first = await wallet.send({ recipients: pay('1'), feeRate: 5000n, rbf: true });
    await expect(wallet.bumpFee(first.txid, { feeRate: DEFAULT_MAX_FEE_RATE + 1n })).rejects.toEqual(feeTooHigh);
    // The same rate again needs a higher fee to replace, which this ceiling does not allow.
    await expect(wallet.bumpFee(first.txid, { feeRate: 5000n, maxFeeRate: 5000n })).rejects.toEqual(feeTooHigh);
    expect(chain.mempool.has(first.txid)).toBe(true);
    expect(wallet.transaction(first.txid)!.status).toBe('pending');
    const bumped = await wallet.bumpFee(first.txid, { feeRate: 5000n });
    expect(bumped.fee).toBeGreaterThan(first.fee);
  });

  it('holds a sweep to the ceiling and hands out no address for one it refuses', async () => {
    const chain = new FakeChain();
    const wallet = await newWallet(chain);
    const key = new Uint8Array(32).fill(6);
    chain.pay(keyPathAddress(key, network), prl('3'));
    chain.mine();
    const wif = encodeWif(key, network);
    chain.feeRate = prl('1');
    signatures.count = 0;
    await expect(wallet.sweep({ wif })).rejects.toEqual(feeTooHigh);
    await expect(wallet.sweep({ wif, feeRate: 20_000n, maxFeeRate: 10_000n })).rejects.toEqual(feeTooHigh);
    expect(signatures.count).toBe(0);
    expect(wallet.addresses()).toHaveLength(0);
    expect(chain.mempool.size).toBe(0);
    const swept = await wallet.sweep({ wif, feeRate: prl('1'), maxFeeRate: prl('1') });
    expect(swept.fee).toBeGreaterThan(prl('0.1'));
  });

  it('refuses a sweep whose fee comes out above the ceiling before the key signs anything', async () => {
    const chain = new FakeChain();
    const wallet = await newWallet(chain);
    const key = new Uint8Array(32).fill(7);
    chain.pay(keyPathAddress(key, network), prl('3'));
    chain.mine();
    signatures.count = 0;
    overpay.by = prl('1');
    try {
      await expect(wallet.sweep({ wif: encodeWif(key, network), feeRate: 2000n })).rejects.toEqual(feeTooHigh);
    } finally {
      overpay.by = 0n;
    }
    expect(signatures.count).toBe(0);
    expect(chain.mempool.size).toBe(0);
  });

  it('holds imported and XMSS coins to the ceiling, and spends no XMSS index on a refused payment', async () => {
    const chain = new FakeChain();
    const wallet = await newWallet(chain);
    const imported = await wallet.importKey(encodeWif(new Uint8Array(32).fill(5), network));
    const xmss = await wallet.addXmssKey();
    chain.pay(imported, prl('1'));
    chain.pay(xmss.address, prl('1'));
    chain.mine();
    await wallet.sync();
    const recipients = [{ address: STRANGER, amount: 'max' as const }];
    // Each amount leaves dust after the fee at 2000, which joins the fee and takes it past that rate.
    for (const [from, dusty] of [[{ imported }, 400n], [{ xmss: xmss.id }, 1700n]] as const) {
      chain.feeRate = prl('500');
      await expect(wallet.send({ recipients, from })).rejects.toEqual(feeTooHigh);
      await expect(wallet.send({ recipients: [{ address: STRANGER, amount: prl('1') - dusty }], feeRate: 2000n, maxFeeRate: 2000n, from })).rejects.toEqual(feeTooHigh);
    }
    expect(wallet.xmssKeys()[0]!.nextIndex).toBe(0);
    expect(chain.mempool.size).toBe(0);
    // An XMSS spend above the default ceiling goes through once the ceiling is raised.
    const sent = await wallet.send({ recipients, from: { xmss: xmss.id }, feeRate: prl('0.1'), maxFeeRate: prl('0.1') });
    expect(chain.mempool.has(sent.txid)).toBe(true);
  });
});
