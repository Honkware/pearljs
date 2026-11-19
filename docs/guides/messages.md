# Sign and verify messages

Signing a message with an address's key proves that you control the address without moving any coins. Pools ask for this when a miner registers a payout address, and services ask for it at sign-in.

pearljs signs and verifies messages for P2TR addresses in the three formats Pearl software uses:

| Format | Made by | Verified by | Message length |
| --- | --- | --- | --- |
| `'oyster'` (default) | Oyster's `signmessage`, so the desktop wallet's daemon and `prlctl --wallet signmessage` | Oyster's `verifymessage`, and the pools that check payout registrations with it | 80 bytes of UTF-8 |
| `'bip322'` | BIP-322 tools | BIP-322 tools | any |
| `'legacy'` | pearld's `signmessagewithprivkey` | no Pearl RPC; pearljs | any |

Oyster is Pearl's own wallet, so a request to "sign with your Pearl wallet" means the `'oyster'` format, which is the default.

## Sign and verify

`account.signMessage` signs for the address of the child named by `index` (and `change`, for the change chain), and returns the signature as base64. `verifyMessage` takes the address, the signature, the message and the network, and returns true or false:

```ts run
import { deriveSigningAccountFromSeed, mnemonicToSeed, networks, verifyMessage } from 'pearljs';

const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const account = deriveSigningAccountFromSeed(mnemonicToSeed(phrase), networks.mainnet);

const message = 'sign in: nonce 7f3a91';
const address = account.deriveAddress(0);
const signature = account.signMessage(message, { index: 0 }); // base64

console.log(verifyMessage(address, signature, message, networks.mainnet)); // true
console.log(verifyMessage(address, signature, 'sign in: nonce 000000', networks.mainnet)); // false
console.log(verifyMessage(account.deriveAddress(1), signature, message, networks.mainnet)); // false
```

Each signature mixes in fresh randomness ([Security model](../concepts/security.md)), so signing the same message twice gives two different signatures that are both valid. To compare signatures, verify them rather than comparing their text.

## Register a payout address with a pool

A pool that pays merge-mining rewards asks for a message that names the payout destination, signed by your Pearl address. Sign it from the recovery phrase on a machine you trust, with no wallet running:

```ts run
import { deriveSigningAccountFromSeed, mnemonicToSeed, networks } from 'pearljs';

const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const account = deriveSigningAccountFromSeed(mnemonicToSeed(phrase), networks.mainnet);

// The address the pool knows you by, and the text it asks you to sign, exactly.
const address = account.deriveAddress(0);
const message = 'I set mdl1qexampleexampleexampleexampleexample';
console.log(address.startsWith('prl1p')); // true
console.log(account.signMessage(message, { index: 0 }).length); // 88
```

Paste the address, the message and the signature into the pool's form. If the address is not the first one the wallet handed out, find its index with `discoverAccount` ([Wallet backends and discovery](wallet-backends.md)) or by deriving addresses until one matches.

## Look up more

[Message signature reference](../reference/messages-formats.md) has signing with a single private key, the other two formats and how each is built, when `verifyMessage` returns false, and the node clients' own signing methods.
