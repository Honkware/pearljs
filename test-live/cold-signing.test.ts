// Watch-only cold signing on a regtest pearld. The online side holds an
// account's extended public key and its origin, finds the account's coins
// through pearldBackend and prepares a PSBT; only base64 text crosses to the
// signing side, which finds each key from the input's derivation record,
// signs and hands a transaction back; the online side checks it is the one
// it built, broadcasts it, and pearld mines it.

import { expect, it } from 'vitest';
import {
  buildPayment,
  deriveSigningAccountFromSeed,
  discoverAccount,
  finalizePayment,
  finalizePsbt,
  importWatchOnlyAccount,
  mnemonicToSeed,
  parsePsbt,
  parseTransaction,
  pearldBackend,
  psbtOutputs,
  serializeTransaction,
  SigningError,
  toOutputScript,
} from '../src/index.js';
import type { PearlAccount } from '../src/index.js';
import { describeLive, FEE_RATE, fund, mine, network, pearld } from './chain.js';

const PHRASE = 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above';
const STRANGER = 'ozone drill grab fiber curtain grace pudding thank cruise elder eight picnic';
const backend = pearldBackend(pearld, { network });

/** What the machine holding the phrase does with a request: sign every input, never told which child. */
function signOffline(request: string, expectOutputs: { address: string; value: bigint }[]): string {
  const account = deriveSigningAccountFromSeed(mnemonicToSeed(PHRASE), network, 3);
  const psbt = parsePsbt(request);
  expect(psbtOutputs(psbt, network).map(({ address, value }) => ({ address, value }))).toEqual(expectOutputs);
  for (let i = 0; i < psbt.inputCount; i += 1) account.signInput(psbt, i);
  account.destroy();
  return serializeTransaction(finalizePsbt(psbt));
}

async function payOnline(watchOnly: PearlAccount, recipient: string, amount: bigint): Promise<string> {
  const found = await discoverAccount(watchOnly, backend, { gap: 20 });
  const payment = buildPayment({
    network,
    utxos: found.utxos,
    recipients: [{ address: recipient, amount }],
    feeRate: FEE_RATE,
    changeAddress: watchOnly.deriveAddress(found.change.nextIndex, true),
  });
  payment.inputs.forEach((utxo, i) => watchOnly.prepareInput(payment.psbt, i, utxo));
  const request = payment.psbt.toBase64();
  expect(request).toMatch(/^[A-Za-z0-9+/]+=*$/);

  // A signing account for other keys finds none of its own in the records.
  const stranger = deriveSigningAccountFromSeed(mnemonicToSeed(STRANGER), network, 3);
  const refused = (): void => stranger.signInput(parsePsbt(request), 0);
  expect(refused).toThrow(SigningError);
  expect(refused).toThrow(expect.objectContaining({ code: 'DERIVATION_NOT_FOUND' }) as Error);

  const signedHex = signOffline(request, [
    { address: recipient, value: amount },
    { address: watchOnly.deriveAddress(found.change.nextIndex, true), value: payment.change },
  ]);
  const signed = finalizePayment(payment, { signed: parseTransaction(signedHex) });
  expect(payment.inputs.length).toBeGreaterThan(1);
  expect(await pearld.testMempoolAccept([signed.hex])).toMatchObject([{ allowed: true, vsize: payment.vsize, fees: { base: payment.fee } }]);
  expect(await backend.broadcast(signed.hex)).toBe(signed.txid);
  const [block] = await mine(1);
  expect(await pearld.getRawTransaction(signed.txid)).toMatchObject({ blockhash: block, confirmations: 1, vsize: payment.vsize });
  return signed.txid;
}

describeLive('watch-only cold signing', () => {
  it('prepares from live coins on an xpub with its origin, signs elsewhere without indices, and is mined', async () => {
    const holder = deriveSigningAccountFromSeed(mnemonicToSeed(PHRASE), network, 3);
    const exported = holder.watchOnlyAccount();
    const xpub = exported.extendedPublicKey();
    const origin = { masterFingerprint: exported.masterFingerprint!, path: holder.path };
    expect(origin.path).toBe(`m/86'/${network.coinType}'/3'`);
    holder.destroy();

    const watchOnly = importWatchOnlyAccount(xpub, network, origin);
    // Coins on both chains, so the records name receive and change children.
    await fund([
      { script: toOutputScript(watchOnly.deriveAddress(0), network), value: 30_000_000n },
      { script: toOutputScript(watchOnly.deriveAddress(4), network), value: 25_000_000n },
      { script: toOutputScript(watchOnly.deriveAddress(0, true), network), value: 20_000_000n },
    ]);
    const stranger = deriveSigningAccountFromSeed(mnemonicToSeed(STRANGER), network);
    await payOnline(watchOnly, stranger.deriveAddress(0), 60_000_000n);

    // The same key imported without its origin records children under the
    // account key's fingerprint, and the signing account reads those too.
    const bare = importWatchOnlyAccount(xpub, network);
    expect(bare.masterFingerprint).toBeNull();
    await fund([
      { script: toOutputScript(bare.deriveAddress(5), network), value: 30_000_000n },
      { script: toOutputScript(bare.deriveAddress(2, true), network), value: 30_000_000n },
    ]);
    await payOnline(bare, stranger.deriveAddress(1), 65_000_000n);
    expect((await backend.getBalance([stranger.deriveAddress(0), stranger.deriveAddress(1)])).confirmed).toBe(125_000_000n);
  });
});
