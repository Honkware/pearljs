# Keys, mnemonics and accounts

Most Pearl applications start from a recovery phrase, whether they make a new one or read one a user types in. A Pearl wallet is built from a BIP39 recovery phrase, with a BIP86 account derived from the phrase and addresses derived from the account. pearljs derives all three the way Oyster, Pearl's wallet, does, so a phrase restored in either one gives the same addresses.

## Create a recovery phrase

`generateMnemonic` makes a new phrase from the platform's random source, and `mnemonicToSeed` turns it into the 64-byte seed that keys are derived from:

```ts run
import { generateMnemonic, mnemonicToSeed, validateMnemonic } from 'pearljs';

const phrase = generateMnemonic(); // 12 words, as Pearl's wallet makes
console.log(validateMnemonic(phrase)); // true
console.log(generateMnemonic(24).split(' ').length); // 24

const seed = mnemonicToSeed(phrase); // 64 bytes, empty BIP39 passphrase
console.log(seed.length);
```

`generateMnemonic` takes 12, 15, 18, 21 or 24 words (`MNEMONIC_WORD_COUNTS`). `mnemonicToSeed` takes an optional BIP39 passphrase as its second argument, and since Pearl's wallet uses none, leave it out to get the same seed. It throws `invalid BIP39 mnemonic` for a word outside the English list or a phrase whose checksum is wrong. `entropyToMnemonic` and `mnemonicToEntropy` convert between a phrase and the 16 to 32 bytes of entropy it encodes.

## Read what a user typed

A phrase pasted by a user often has stray capitals and spacing. pearljs reads text the way Pearl's wallet does: it trims it, lowercases it and collapses runs of whitespace, so the same words give the same seed however they were pasted. `normalizeMnemonic` is that step on its own.

Some users have a raw seed in hex instead of a phrase. When the input may be either, `parseSeedInput` sorts it out and says what was wrong when it is neither:

```ts run
import { parseSeedInput } from 'pearljs';

const inputs = [
  '  Abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon ABOUT ',
  '0x000102030405060708090a0b0c0d0e0f',
  'abandon abandon abandon',
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon zebra',
];
for (const input of inputs) {
  const parsed = parseSeedInput(input);
  if (parsed.kind === 'invalid') console.log('invalid:', parsed.reason);
  else console.log(parsed.kind, parsed.seed.length, 'byte seed');
}
```

A raw seed is 16 to 64 bytes of hex (`MIN_HEX_SEED_BYTES`, `MAX_HEX_SEED_BYTES`), with or without `0x`, and is used as the seed as it is. `seedFromInput` does the same as `parseSeedInput` but returns the seed directly and throws for bad input.

## Derive an account

An account is the key at `m/86'/<coin type>'/<account>'`, and its addresses are derived below it: receive addresses at `0/<index>` and change addresses at `1/<index>`. The coin type is 808276 on mainnet and 1 on every other network, so the same phrase gives different keys on mainnet and on a testnet. Every address is P2TR and is spent through its key path.

There are two kinds of account object. `deriveAccountFromSeed` returns a watch-only account, whose key has had its private part removed, so it can derive public keys and addresses but can't sign. `deriveSigningAccountFromSeed` keeps the private keys and can sign. Use the signing account only in the code that signs:

```ts run
import { accountPath, deriveAccountFromSeed, deriveSigningAccountFromSeed, mnemonicToSeed, networks } from 'pearljs';

const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const seed = mnemonicToSeed(phrase);

const account = deriveAccountFromSeed(seed, networks.mainnet);
console.log(account.path); // m/86'/808276'/0'
console.log(account.deriveAddress(0)); // first receive address
console.log(account.deriveAddress(0, true)); // first change address
console.log(account.derivePublicKey(0).length); // 32: the x-only internal key

// A second account of the same phrase.
console.log(accountPath(networks.mainnet, 1)); // m/86'/808276'/1'
const second = deriveAccountFromSeed(seed, networks.mainnet, 1);
console.log(second.deriveAddress(0) !== account.deriveAddress(0)); // true

const signing = deriveSigningAccountFromSeed(seed, networks.mainnet);
console.log(signing.deriveAddress(0) === account.deriveAddress(0)); // true
signing.destroy();
```

Address indices run from 0 to 2147483647, and hardened indices are refused. `derivePublicKey` returns a child's untweaked key. A key-path address commits to that key through the BIP86 tweak, while a script leaf such as `checksigScript` names the untweaked key itself, and script-path signatures are made with it.

## Keep the phrase away from a server

A server that only shows addresses and watches for payments needs the account's extended public key and nothing more. Export the key on the machine that holds the phrase, and import it on the server:

```ts run
import { deriveAccountFromSeed, importWatchOnlyAccount, mnemonicToSeed, networks } from 'pearljs';

const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

// On the machine that holds the phrase:
const xpub = deriveAccountFromSeed(mnemonicToSeed(phrase), networks.mainnet).extendedPublicKey();
console.log(xpub); // zpub...

// On the server:
const watchOnly = importWatchOnlyAccount(xpub, networks.mainnet);
console.log(watchOnly.deriveAddress(0));
console.log(watchOnly.path); // null: an imported key does not say where it came from
```

`importWatchOnlyAccount` accepts only an extended public key at depth 3 with the version bytes of the network given, and throws for an extended private key or a key for another network. Pass the key's origin as a third argument, `{ masterFingerprint, path }`, taken from the exporting account's `masterFingerprint` and `path`. The watch-only account then writes PSBT inputs in which the signing account finds its own keys ([Sign a PSBT on an offline machine](psbt.md)).

Anyone with the extended public key can see every address and payment of the account, so treat it as private even though it can't spend.

A watch-only account is also the application's side of a hardware wallet. `account.signInputAsync(psbt, i, signer)` checks a key-path input in the same way as `signInput`, asks a signer that holds the keys elsewhere for the signature, and verifies what comes back. `account.prepareOutput` records on an output that it pays one of the account's children, and `account.findChild` reads such a record back after deriving the key again, which is how an offline signer tells its own change from someone else's address ([Sign with a hardware or external signer](psbt-hardware.md)).

## Use single keys

Oyster's `dumpprivkey` and `importprivkey` move single keys in wallet import format (WIF). `decodeWif` and `encodeWif` read and write that format with the same checks and error messages as Oyster, and `keyPathAddress` gives the P2TR address Oyster gives an imported key:

```ts run
import { decodeWif, encodeWif, keyPathAddress, networks } from 'pearljs';

const wif = encodeWif(new Uint8Array(32).fill(7), networks.mainnet);
const { privateKey, compressed } = decodeWif(wif, networks.mainnet);
console.log(compressed); // true, as dumpprivkey writes
console.log(keyPathAddress(privateKey, networks.mainnet));

try {
  decodeWif(wif, networks.testnet2);
} catch (err) {
  console.log((err as Error).message);
}
privateKey.fill(0);
```

`decodeWif` throws for a key made for another network. Testnet, testnet2 and regtest share a WIF byte, though, so a key for one of them decodes for the others, while mainnet and simnet each have their own.

A single key works with the rest of pearljs in three ways:

- To sign a key-path PSBT input with it, pass `keyPathSignerFromPrivateKey(privateKey)` to `signTaprootKeyPathInputAsync`.
- To move everything it holds, use `sweepWif` or `sweepKey` ([Build a transaction by hand](payments-by-hand.md)).
- To sign a message with it, use `signMessage` ([Messages](messages.md)).

## Wipe keys

A signing account overwrites each child key once its signature is made. `account.destroy()` overwrites the master and account keys, after which every signing method throws `this signing account has been destroyed` while the address methods keep working. `decodeWif` hands the key bytes to the caller, so wiping them is the caller's job, as with `privateKey.fill(0)` above.

Wiping shortens the time a key sits in memory, but it can't remove every copy. [Security model](../concepts/security.md) lists what JavaScript can't wipe.

## Compatibility with Oyster

Oyster is Pearl's wallet daemon, and Pearl's desktop wallet runs it. For the same recovery phrase, pearljs and Oyster agree on the following:

- They derive the same BIP86 path, coin types and extended key version bytes, and so every receive and change address.
- They read pasted phrases and hex seeds the same way.
- They use the same wallet import format for single keys, and give an imported key the same address.
- They choose the same coins, fees and change for a payment ([Send a payment](send-a-payment.md)).
- They make the same message signatures ([Messages](messages.md)).

Restoring a wallet means finding which of its addresses were used. Oyster looks 250 addresses past the last used one on each chain, which is its recovery window, and `discoverAccount` uses the same 250 by default (`OYSTER_RECOVERY_WINDOW`), so it finds what Oyster finds ([Discovery](wallet-backends.md#discovery)). When a restore in Oyster shows less than expected, [Recover a seed that shows zero](recovery.md) checks the other ways a phrase may have been used.

XMSS keys don't come from a recovery phrase, in Pearl or in pearljs. They come from their own random seeds, which need their own backup ([XMSS](../concepts/xmss.md)).

## Tests

The agreement with Oyster is checked against vectors from Pearl's Go code (`vectors/pearl-go.json`, read by `test/go-vectors.test.ts`) and against a live Oyster in the live suite (`test/live/oyster.test.ts`, `test/live/mnemonic.test.ts`). [Compatibility verification](../project/verification.md) lists every check.
