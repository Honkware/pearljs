# Message signature reference

## Single keys

To sign with a single private key instead of an account, call `signMessage(privateKey, message)`, which signs for that key's address, `keyPathAddress(privateKey, network)`:

```ts run
import { decodeWif, encodeWif, keyPathAddress, networks, signMessage, verifyMessage } from 'pearljs';

const wif = encodeWif(new Uint8Array(32).fill(7), networks.mainnet); // in practice, from dumpprivkey
const { privateKey } = decodeWif(wif, networks.mainnet);
const signature = signMessage(privateKey, 'sign in: nonce 7f3a91');
console.log(verifyMessage(keyPathAddress(privateKey, networks.mainnet), signature, 'sign in: nonce 7f3a91', networks.mainnet)); // true
```

## Choosing a format

Pass `format` to sign in another format, and pass it again to verify a signature in that format. `messageSignatureFormat` tells you which format a signature is valid in, and `format: 'any'` accepts all three:

```ts run
import { deriveSigningAccountFromSeed, messageSignatureFormat, mnemonicToSeed, networks, verifyMessage } from 'pearljs';

const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const account = deriveSigningAccountFromSeed(mnemonicToSeed(phrase), networks.mainnet);
const address = account.deriveAddress(0);

const bip322 = account.signMessage('Hello World', { index: 0, format: 'bip322' });
console.log(verifyMessage(address, bip322, 'Hello World', networks.mainnet, { format: 'bip322' })); // true
console.log(verifyMessage(address, bip322, 'Hello World', networks.mainnet)); // false

const legacy = account.signMessage('Hello World', { index: 0, format: 'legacy' });
console.log(messageSignatureFormat(address, legacy, 'Hello World', networks.mainnet)); // legacy
console.log(verifyMessage(address, legacy, 'Hello World', networks.mainnet, { format: 'any' })); // true
```

`messageSignatureFormat` returns `undefined` for a signature that is valid in none of them. Each format signs a different hash, so a signature is never valid in two.

## Oyster's format

Oyster calls its format BIP-322 and uses BIP-322's two virtual transactions, `to_spend` and `to_sign`, but builds them its own way:

- The message goes into an OP_RETURN output of `to_sign` instead of a tagged hash in `to_spend`.
- Both transactions are version 2.
- The sequences are 0xffffffff.

The signature is a base64 witness stack, as in BIP-322, so the two formats look alike even though neither verifies as the other.

An OP_RETURN carries at most 80 bytes, so a longer message throws `MESSAGE_INVALID`, for example `message is 81 bytes, more than the 80 Oyster can sign`. To sign something longer for Oyster, sign its hash as hex.

The OP_RETURN pushes the empty message and a lone NUL character (`'\u0000'`) alike, as OP_0, so in this format one signature covers both, for Oyster's verifier and for pearljs. BIP-322's own format hashes the message bytes and keeps the two apart.

## BIP-322

`'bip322'` is BIP-322's simple variant as the BIP specifies it. `to_spend` and `to_sign` are at version 0 with sequence 0. `to_spend` holds `OP_0 PUSH32[message_hash]`, where the hash is the BIP340 tagged hash `BIP0322-signed-message` of the message, and `to_sign` holds a bare OP_RETURN. Signatures are written without the `smp` prefix that the current BIP text adds, which is how deployed tools write them, and `verifyMessage` reads them with or without it. `bip322MessageHash` and `bip322Transactions` return the hash and both transactions.

## Legacy

`'legacy'` is what pearld's `signmessagewithprivkey` returns: a 65-byte ECDSA compact signature over the double SHA-256 of `Pearl Signed Message:\n` and the message, each prefixed with its length. Its first byte is 27 plus the recovery id, plus 4 for a compressed key. The signature names a key rather than an address, so `verifyMessage` recovers the key and compares its BIP86 key-path address with the one given. These signatures are deterministic: the same key and message always give the same bytes, the bytes pearld gives. `legacyMessageHash` returns the hash.

## Verification results

`verifyMessage` returns true for a valid key-path signature of that message, for that address on that network, in the format asked for. The format is `'oyster'` unless `format` says otherwise. It returns false in every other case, including these:

| False for | Detail |
| --- | --- |
| The address | It does not decode, belongs to another network, is P2MR, or has a program that is not a point on the curve |
| The encoding | Not base64, not a witness stack, or lengths written in more bytes than they need (Oyster's `wire.ReadVarInt` refuses those too) |
| The message | An Oyster-format message over 80 bytes, or a message with a lone surrogate |
| A legacy signature | Its first byte is outside 27 to 34 |
| A script-path signature | Oyster's script engine could accept one, but pearljs does not evaluate it |
| The sighash type | Anything but SIGHASH_DEFAULT or SIGHASH_ALL, which `signMessage` never makes |

Oyster's `verifymessage` accepts every sighash type, which means an Oyster-format signature with SIGHASH_NONE verifies there for any message. Pass `anySighashType: true` to get Oyster's answer.

In an Oyster-format signature, line breaks (CR and LF) are skipped wherever they appear, as Oyster's base64 decoder skips them, and any other whitespace makes the answer false.

The only error `verifyMessage` throws is a `TypeError`, for an argument that is not a string, a network that is not a `PearlNetwork`, or an unknown format, so its result can go straight into an `if`.

Only P2TR addresses can sign messages, because a P2MR address has no key of its own.

## Oyster and pearld

The node clients can also sign. `OysterClient.signMessage(address, message)` and `OysterClient.verifyMessage(address, signature, message)` call Oyster's own methods, for addresses its wallet holds and in Oyster's format only. `PearldClient.signMessageWithPrivKey(wif, message)` returns a legacy signature, and sends the private key to the node to make it. pearld has no `verifymessage`.
