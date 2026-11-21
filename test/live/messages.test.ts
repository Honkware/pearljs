// The three message formats against the real servers: Oyster's own format
// both ways, pearld's signmessagewithprivkey byte for byte, and Oyster's
// verifymessage refusing the formats that are not its own.

import { randomBytes } from 'node:crypto';
import { beforeAll, expect, it } from 'vitest';
import {
  deriveSigningAccountFromSeed,
  encodeWif,
  keyPathAddress,
  messageSignatureFormat,
  mnemonicToSeed,
  signMessage,
  verifyMessage,
} from '../../src/index.js';
import { OYSTER_MNEMONIC, OYSTER_PASSPHRASE } from './context.js';
import { describeLive, describeOyster, network, oyster, pearld } from './chain.js';

const MESSAGE = 'I set mdl1qexampleexampleexampleexampleexample';

describeLive('pearld signmessagewithprivkey', () => {
  it('gives the legacy signature pearljs makes, byte for byte, which verifies for the key-path address', async () => {
    for (let i = 0; i < 3; i += 1) {
      const key = Uint8Array.from(randomBytes(32));
      const message = i === 2 ? 'x'.repeat(300) : `${MESSAGE} ${i}`;
      const signature = await pearld.signMessageWithPrivKey(encodeWif(key, network), message);
      expect(signature).toBe(signMessage(key, message, { format: 'legacy' }));
      const address = keyPathAddress(key, network);
      expect(messageSignatureFormat(address, signature, message, network)).toBe('legacy');
      expect(verifyMessage(address, signature, `${message}!`, network, { format: 'any' })).toBe(false);
    }
  });
});

describeOyster('Oyster signmessage and verifymessage', () => {
  let address: string;
  let index: number;
  const account = deriveSigningAccountFromSeed(mnemonicToSeed(OYSTER_MNEMONIC), network);
  beforeAll(async () => {
    await oyster.walletPassphrase(OYSTER_PASSPHRASE, 600);
    address = await oyster.getNewAddress();
    index = Array.from({ length: 1000 }, (_, i) => i).find((i) => account.deriveAddress(i) === address)!;
    expect(index).toBeGreaterThanOrEqual(0);
  });

  it('signs in the format pearljs calls oyster', async () => {
    const signature = await oyster.signMessage(address, MESSAGE);
    expect(messageSignatureFormat(address, signature, MESSAGE, network)).toBe('oyster');
    expect(verifyMessage(address, signature, MESSAGE, network, { format: 'bip322' })).toBe(false);
  });

  it('accepts only the oyster format of the three pearljs signs', async () => {
    const oysterSignature = account.signMessage(MESSAGE, { index });
    expect(await oyster.verifyMessage(address, oysterSignature, MESSAGE)).toBe(true);
    for (const format of ['bip322', 'legacy'] as const) {
      const signature = account.signMessage(MESSAGE, { index, format });
      expect(verifyMessage(address, signature, MESSAGE, network, { format })).toBe(true);
      expect(await oyster.verifyMessage(address, signature, MESSAGE).catch(() => false)).toBe(false);
    }
  });
});
