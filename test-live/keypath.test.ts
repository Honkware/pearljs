// BIP86 key-path spends from a pearljs account, broadcast to and mined by a
// regtest pearld.

import { expect, it } from 'vitest';
import {
  checkStandard,
  createPsbt,
  createTransaction,
  deriveSigningAccountFromSeed,
  estimateVsize,
  finalizePsbt,
  mnemonicToSeed,
  toOutputScript,
} from '../src/index.js';
import {
  addChange,
  broadcastAndConfirm,
  describeLive,
  fund,
  network,
  pearld,
  prevoutsOf,
  testMempoolAccept,
} from './chain.js';

const account = deriveSigningAccountFromSeed(mnemonicToSeed('zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong'), network);

describeLive('BIP86 key path', () => {
  it('spends two outputs of a pearljs account in one transaction pearld mines', async () => {
    const scripts = [3, 4].map((index) => toOutputScript(account.deriveAddress(index), network));
    const funding = await fund(scripts.map((script) => ({ script, value: 50_000_000n })));

    const tx = createTransaction(2);
    tx.addInput(funding.getHash(), 0);
    tx.addInput(funding.getHash(), 1);
    tx.addOutput(toOutputScript(account.deriveAddress(7, true), network), 30_000_000n);
    const spends = [{ type: 'keyPath' as const }, { type: 'keyPath' as const }];
    const estimate = addChange(tx, 100_000_000n, spends);

    const psbt = createPsbt(tx);
    // Taproot signatures commit to every input's UTXO, so prepare all before signing.
    [3, 4].forEach((index, input) => account.prepareInput(psbt, input, { index, value: 50_000_000n }));
    [3, 4].forEach((index, input) => account.signInput(psbt, input, { index }));
    const signed = finalizePsbt(psbt);
    checkStandard(signed, { prevouts: prevoutsOf(signed, [funding]) });

    const accepted = await testMempoolAccept(signed);
    expect(accepted).toMatchObject({ allowed: true, vsize: estimate });
    const info = await broadcastAndConfirm(signed);
    expect(info.vsize).toBe(estimateVsize(signed, spends));
    expect(info.vsize).toBe(signed.virtualSize());

    const output = await pearld<{ value: number; scriptPubKey: { address: string } }>('gettxout', info.txid, 0, true);
    expect(output.scriptPubKey.address).toBe(account.deriveAddress(7, true));
    expect(output.value).toBe(0.3);
  });
});
