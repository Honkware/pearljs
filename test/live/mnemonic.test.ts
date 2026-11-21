// Seeds from mnemonic.ts restored in Oyster: wallets created from a pearljs
// mnemonic of 12 and of 24 words, and from a raw hex seed, hand out the
// receive and change addresses pearljs derives.

import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { deriveAccountFromSeed, generateMnemonic, mnemonicToSeed, parseSeedInput, validateMnemonic } from '../../src/index.js';
import { describeOyster, live, network } from './chain.js';
import { startOyster } from './processes.js';

const PASSPHRASE = 'pearljs-mnemonic';

/** Creates an Oyster wallet from the seed text and returns its first receive and change addresses. */
async function restore(name: string, seedText: string): Promise<{ receive: string[]; change: string }> {
  const wallet = await startOyster({
    exe: process.env.OYSTER!,
    dir: join(live!.dir, `oyster-${name}`),
    pearld: live!.pearld,
    mnemonic: seedText,
    passphrase: PASSPHRASE,
  });
  try {
    await wallet.client.walletPassphrase(PASSPHRASE, 60);
    const receive = [];
    for (let i = 0; i < 3; i++) receive.push(await wallet.client.getNewAddress());
    return { receive, change: await wallet.client.call<string>('getrawchangeaddress') };
  } finally {
    await wallet.stop();
  }
}

function derived(seed: Uint8Array): { receive: string[]; change: string } {
  const account = deriveAccountFromSeed(seed, network);
  return { receive: [0, 1, 2].map((i) => account.deriveAddress(i)), change: account.deriveAddress(0, true) };
}

describeOyster('seeds restored in Oyster', () => {
  it('restores a generated 12-word mnemonic to the addresses pearljs derives', async () => {
    const mnemonic = generateMnemonic();
    expect(mnemonic.split(' ')).toHaveLength(12);
    expect(validateMnemonic(mnemonic)).toBe(true);
    expect(await restore('words12', mnemonic)).toEqual(derived(mnemonicToSeed(mnemonic)));
  });

  it('restores a generated 24-word mnemonic, pasted in capitals with stray spaces', async () => {
    const mnemonic = generateMnemonic(24);
    const parsed = parseSeedInput(`  ${mnemonic.toUpperCase().replace(/ /g, '  ')} `);
    expect(parsed).toMatchObject({ kind: 'mnemonic', wordCount: 24 });
    expect(await restore('words24', mnemonic)).toEqual(derived(mnemonicToSeed(mnemonic)));
  });

  it('restores a 32-byte hex seed as parseSeedInput reads it', async () => {
    const hex = randomBytes(32).toString('hex');
    const parsed = parseSeedInput(hex);
    expect(parsed.kind).toBe('hex');
    expect(await restore('hexseed', hex)).toEqual(derived(parsed.kind === 'hex' ? parsed.seed : new Uint8Array()));
  });
});
