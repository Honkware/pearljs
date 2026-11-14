// pearljs against a running Oyster wallet on regtest: addresses from the same
// mnemonic, message signatures in both directions, and WIF import.

import { randomBytes } from 'node:crypto';
import { beforeAll, expect, it } from 'vitest';
import {
  deriveAccountFromSeed,
  deriveSigningAccountFromSeed,
  encodeWif,
  keyPathAddress,
  mnemonicToSeed,
  signMessage,
  verifyMessage,
} from '../src/index.js';
import { OYSTER_MNEMONIC, OYSTER_PASSPHRASE } from './context.js';
import { describeOyster, network, oyster } from './chain.js';

const MESSAGE = 'pearljs live test: nonce 5c2e';

function privateKey(): Uint8Array {
  // Any scalar below the curve order works; 32 random bytes almost surely are.
  return Uint8Array.from(randomBytes(32));
}

describeOyster('Oyster', () => {
  let firstAddress: string;
  beforeAll(async () => {
    await oyster('walletpassphrase', OYSTER_PASSPHRASE, 600);
    firstAddress = await oyster<string>('getnewaddress');
  });

  it('gives the first BIP86 address pearljs derives from the same mnemonic', () => {
    expect(firstAddress).toBe(deriveAccountFromSeed(mnemonicToSeed(OYSTER_MNEMONIC), network).deriveAddress(0));
  });

  it('verifies a message pearljs signed', async () => {
    const key = privateKey();
    const signature = signMessage(key, MESSAGE);
    expect(await oyster<boolean>('verifymessage', keyPathAddress(key, network), signature, MESSAGE)).toBe(true);
    expect(await oyster<boolean>('verifymessage', keyPathAddress(key, network), signature, `${MESSAGE}!`)).toBe(false);
  });

  it('signs a message pearljs verifies', async () => {
    const signature = await oyster<string>('signmessage', firstAddress, MESSAGE);
    expect(verifyMessage(firstAddress, signature, MESSAGE, network)).toBe(true);
    expect(verifyMessage(firstAddress, signature, `${MESSAGE}!`, network)).toBe(false);
  });

  it('verifies a message a pearljs account signed for an Oyster address', async () => {
    const account = deriveSigningAccountFromSeed(mnemonicToSeed(OYSTER_MNEMONIC), network);
    const signature = account.signMessage(MESSAGE, { index: 0 });
    expect(await oyster<boolean>('verifymessage', firstAddress, signature, MESSAGE)).toBe(true);
  });

  it('imports a pearljs WIF at the address keyPathAddress predicts', async () => {
    const key = privateKey();
    await oyster('importprivkey', encodeWif(key, network), 'imported', false);
    const imported = await oyster<string[]>('getaddressesbyaccount', 'imported');
    expect(imported).toContain(keyPathAddress(key, network));
    expect(await oyster<string>('dumpprivkey', keyPathAddress(key, network))).toBe(encodeWif(key, network));
  });
});
