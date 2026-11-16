// Fixed keys for tests. Every one of them is public: anything paid to them
// on a real network is gone.

import { sha256 } from '../crypto.js';
import { deriveSigningAccountFromSeed } from '../keys.js';
import type { PearlSigningAccount } from '../keys.js';
import { entropyToMnemonic, mnemonicToSeed } from '../mnemonic.js';
import { networks } from '../networks.js';
import type { PearlNetwork } from '../networks.js';
import { concat } from '../internal/bytes.js';
import { keyPathAddress } from '../wif.js';

const bytes = (label: string): Uint8Array => sha256(new TextEncoder().encode(label));

/** The mnemonic most wallets' own tests use; test accounts derive from it. */
export const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

/** The mnemonic every simulated chain's faucet uses. */
export const FAUCET_MNEMONIC = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';

/** A valid 12-word mnemonic for each n, the same on every run. */
export function testMnemonic(n: number): string {
  return entropyToMnemonic(bytes(`pearljs test mnemonic ${n}`).slice(0, 16));
}

/** BIP86 account `account` of TEST_MNEMONIC, or of another mnemonic, on regtest unless a network is given. */
export function testAccount(account = 0, network: PearlNetwork = networks.regtest, mnemonic = TEST_MNEMONIC): PearlSigningAccount {
  return deriveSigningAccountFromSeed(mnemonicToSeed(mnemonic), network, account);
}

/** A 32-byte private key for each n, the same on every run. */
export function testKey(n: number): Uint8Array {
  return bytes(`pearljs test key ${n}`);
}

/** The key-path address of testKey(n). */
export function testAddress(n: number, network: PearlNetwork = networks.regtest): string {
  return keyPathAddress(testKey(n), network);
}

/** The two seeds xmssKeygen takes, for each n, the same on every run. */
export function testXmssSeeds(n: number): { privateSeed: Uint8Array; publicSeed: Uint8Array } {
  return {
    privateSeed: concat([bytes(`pearljs test xmss private ${n} a`), bytes(`pearljs test xmss private ${n} b`)]),
    publicSeed: bytes(`pearljs test xmss public ${n}`),
  };
}
