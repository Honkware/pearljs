/**
 * Sign a message with an account key and with a single WIF key, and verify
 * both the way Oyster's verifymessage does.
 *
 * Runs offline.
 */
import {
  decodeWif,
  deriveSigningAccountFromSeed,
  encodeWif,
  keyPathAddress,
  MAX_MESSAGE_LENGTH,
  mnemonicToSeed,
  networks,
  signMessage,
  verifyMessage,
} from 'pearljs';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const network = networks.mainnet;
const message = 'sign in: nonce 7f3a91';

// With an account: the signature is for the address of the child named.
const account = deriveSigningAccountFromSeed(mnemonicToSeed(MNEMONIC), network);
const address = account.deriveAddress(0);
const signature = account.signMessage(message, { index: 0 });
console.log('address  ', address);
console.log('signature', signature);
console.log('verifies ', verifyMessage(address, signature, message, network));
console.log('other message', verifyMessage(address, signature, 'sign in: nonce 000000', network));
console.log('other address', verifyMessage(account.deriveAddress(1), signature, message, network));
account.destroy();

// With a single key in wallet import format, as Oyster's dumpprivkey writes it.
const wif = encodeWif(new Uint8Array(32).fill(7), network);
const { privateKey } = decodeWif(wif, network);
const keyAddress = keyPathAddress(privateKey, network);
console.log('key address', keyAddress);
console.log('verifies   ', verifyMessage(keyAddress, signMessage(privateKey, message), message, network));

// Oyster signs at most 80 bytes of UTF-8.
try {
  signMessage(privateKey, 'x'.repeat(MAX_MESSAGE_LENGTH + 1));
} catch (err) {
  console.log('too long:', (err as Error).message);
}
privateKey.fill(0);
