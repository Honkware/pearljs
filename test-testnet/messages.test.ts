// Message signing with the test wallet's own address on testnet2: pearljs's
// default format verifies with an Oyster running on testnet2 against the
// node, and pearld's signmessagewithprivkey, given a testnet2 WIF, makes the
// legacy signature pearljs makes, byte for byte.

import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { encodeWif, keyPathAddress, messageSignatureFormat, signMessage, verifyMessage } from '../src/index.js';
import { account, describeTestnet, home, network, node, oyster } from './env.js';

const MESSAGE = `pearljs on ${network.name}: ${new Date().toISOString().slice(0, 10)}`;

describeTestnet('message signing on testnet2', () => {
  it('signs with the wallet address in the format pearljs verifies as its own and no other', () => {
    const signature = account(0).signMessage(MESSAGE, { index: 0 });
    expect(messageSignatureFormat(home(), signature, MESSAGE, network)).toBe('oyster');
    expect(verifyMessage(home(), signature, MESSAGE, network)).toBe(true);
    expect(verifyMessage(account(0).deriveAddress(1), signature, MESSAGE, network)).toBe(false);
  });

  it('gives the same legacy signature as pearld signmessagewithprivkey for a WIF of the network', async () => {
    const key = Uint8Array.from(randomBytes(32));
    const wif = encodeWif(key, network);
    // Compressed keys: K or L on mainnet, c on the test networks.
    expect(wif).toMatch(network.name === 'mainnet' ? /^[KL]/ : /^c/);
    const signature = await node.signMessageWithPrivKey(wif, MESSAGE);
    expect(signature).toBe(signMessage(key, MESSAGE, { format: 'legacy' }));
    expect(verifyMessage(keyPathAddress(key, network), signature, MESSAGE, network, { format: 'legacy' })).toBe(true);
  });

  it.skipIf(oyster === null)('is verified by Oyster on testnet2, which refuses the other two formats', async () => {
    const address = home();
    expect(await oyster!.verifyMessage(address, account(0).signMessage(MESSAGE, { index: 0 }), MESSAGE)).toBe(true);
    for (const format of ['bip322', 'legacy'] as const) {
      const signature = account(0).signMessage(MESSAGE, { index: 0, format });
      expect(await oyster!.verifyMessage(address, signature, MESSAGE).catch(() => false)).toBe(false);
    }
  });
});
