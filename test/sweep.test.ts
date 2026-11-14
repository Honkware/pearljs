// Sweeping a WIF key: the fee against txauthor run the way sweepaccount runs
// it (no outputs, every coin, the destination as the change source), and the
// signatures against the key-path address Go derived for each key.

import * as ecc from 'tiny-secp256k1';
import { describe, expect, it } from 'vitest';
import { checkStandard, fromOutputScript, networks, sweepKey, sweepWif, toOutputScript } from '../src/index.js';
import type { Utxo } from '../src/index.js';
import vectors from '../vectors/pearl-go.json' with { type: 'json' };
import { hexToBytes, networkNamed } from './vector-helpers.js';
import { selectionCase } from './wallet-helpers.js';

const oyster = selectionCase('sweep to one output');
const destination = fromOutputScript(hexToBytes(oyster.changeScript), networks.mainnet);

/** The coins of Oyster's sweep vector, paid to an address instead. */
function coinsAt(address: string, network = networks.mainnet): Utxo[] {
  return oyster.coins.map((coin) => ({
    txid: coin.txid,
    vout: coin.vout,
    value: BigInt(coin.value),
    script: toOutputScript(address, network),
    confirmations: 1,
  }));
}

describe('sweepWif', () => {
  const keys = vectors.wif.filter((item) => item.compressed);

  it('has keys of both parities to sign with', () => {
    const parities = new Set(keys.map((key) => ecc.pointFromScalar(hexToBytes(key.privateKey), true)![0]));
    expect(parities).toEqual(new Set([2, 3]));
  });

  for (const key of keys) {
    it(`sweeps the ${key.network} key ${key.privateKey.slice(0, 8)} with signatures for its address`, () => {
      const network = networkNamed(key.network);
      const to = fromOutputScript(hexToBytes(oyster.changeScript), network);
      const swept = sweepWif(key.wif, { network, utxos: coinsAt(key.address, network), destination: to, feeRate: 1000n });
      expect(swept.transaction.ins.length).toBe(3);
      expect(swept.transaction.outs.length).toBe(1);
      const scripts = swept.prevouts.map((prevout) => prevout.script);
      const values = swept.prevouts.map((prevout) => prevout.value);
      swept.transaction.ins.forEach((input, i) => {
        const hash = swept.transaction.hashForWitnessV1(i, scripts, values, 0);
        expect(ecc.verifySchnorr(hash, scripts[i]!.subarray(2), input.witness[0]!)).toBe(true);
      });
      checkStandard(swept.transaction, { prevouts: swept.prevouts });
    });
  }

  it('pays the fee txauthor works out for a sweep, and sends the rest', () => {
    const key = keys.find((item) => item.network === 'mainnet')!;
    const swept = sweepWif(key.wif, { network: networks.mainnet, utxos: coinsAt(key.address), destination, feeRate: 1000n });
    expect(swept.fee).toBe(BigInt(oyster.fee));
    expect(swept.transaction.outs[0]!.value).toBe(BigInt(oyster.change));
    expect(fromOutputScript(swept.transaction.outs[0]!.script, networks.mainnet)).toBe(destination);
    expect(swept.inputs.map((input) => `${input.txid}:${input.vout}`)).toEqual(oyster.inputs);
    expect(swept.changeIndex).toBe(-1);
  });

  it('gives the same transaction from the raw key', () => {
    const key = keys.find((item) => item.network === 'mainnet')!;
    const options = { network: networks.mainnet, utxos: coinsAt(key.address), destination, feeRate: 2500n, rbf: true };
    const swept = sweepKey(hexToBytes(key.privateKey), options);
    expect(swept.txid).toBe(sweepWif(key.wif, options).txid);
    expect(swept.transaction.ins.every((input) => input.sequence === 0xfffffffd)).toBe(true);
  });

  it('leaves out unconfirmed and empty outputs', () => {
    const key = keys.find((item) => item.network === 'mainnet')!;
    const utxos = coinsAt(key.address);
    utxos[0] = { ...utxos[0]!, confirmations: 0 };
    utxos[1] = { ...utxos[1]!, value: 0n };
    const swept = sweepWif(key.wif, { network: networks.mainnet, utxos, destination, feeRate: 1000n });
    expect(swept.inputs).toEqual([utxos[2]]);
    expect(sweepWif(key.wif, { network: networks.mainnet, utxos, destination, feeRate: 1000n, minConfirmations: 0 }).inputs.length).toBe(2);
  });

  it('refuses an output that pays another address', () => {
    const key = keys.find((item) => item.network === 'mainnet')!;
    expect(() =>
      sweepWif(key.wif, { network: networks.mainnet, utxos: coinsAt(destination), destination, feeRate: 1000n }),
    ).toThrow(`does not pay ${key.address}`);
  });

  it('refuses a key for another network and a sweep with nothing in it', () => {
    const key = keys.find((item) => item.network === 'mainnet')!;
    expect(() => sweepWif(key.wif, { network: networks.regtest, utxos: [], destination, feeRate: 1000n })).toThrow(/not intended for regtest/);
    expect(() => sweepWif(key.wif, { network: networks.mainnet, utxos: [], destination, feeRate: 1000n })).toThrow(/insufficient funds/);
  });
});
