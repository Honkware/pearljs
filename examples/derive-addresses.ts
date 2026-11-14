/**
 * Derive receive and change addresses from a mnemonic, hand the account to a
 * watch-only process as an extended public key, and read an address back.
 *
 * Runs offline. The phrase is the public BIP39 test vector; never put a real
 * one in source.
 */
import {
  addressInfo,
  decodeAddress,
  deriveAccountFromSeed,
  importWatchOnlyAccount,
  mnemonicToSeed,
  networks,
} from 'pearljs';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const network = networks.mainnet;

const account = deriveAccountFromSeed(mnemonicToSeed(MNEMONIC), network);
console.log('account path', account.path);
for (let index = 0; index < 3; index += 1) {
  console.log(`receive ${index}`, account.deriveAddress(index));
}
console.log('change 0 ', account.deriveAddress(0, true));

// The extended public key is all a watch-only server needs.
const xpub = account.extendedPublicKey();
const watchOnly = importWatchOnlyAccount(xpub, network);
console.log('xpub', xpub);
console.log('same addresses', watchOnly.deriveAddress(0) === account.deriveAddress(0));

const address = account.deriveAddress(0);
const { version, program } = decodeAddress(address, network);
console.log('witness version', version, 'program bytes', program.length);
console.log('type and networks', addressInfo(address));

// The same seed gives other addresses on another network: the coin type is in the path.
const testAccount = deriveAccountFromSeed(mnemonicToSeed(MNEMONIC), networks.testnet2);
console.log('testnet2', testAccount.path, testAccount.deriveAddress(0));
