# Recover a seed that shows zero

If a restored recovery phrase shows a zero or short balance in Oyster or the desktop wallet, run `diagnoseSeed`. It checks every derivation Pearl's wallets have used, scanning further than a restore does, and reports what each one holds and why the restore missed it.

```ts run
import { deriveAccountFromSeed, diagnoseSeed, mnemonicToSeed, parsePearl } from 'pearljs';
import { SimulatedChain } from 'pearljs/testing';

const chain = new SimulatedChain(); // in practice pearldBackend, filterBackend or oysterBackend
const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const account = deriveAccountFromSeed(mnemonicToSeed(phrase), chain.network);
chain.pay(account.deriveAddress(0), parsePearl('1'));
chain.pay(account.deriveAddress(300), parsePearl('25')); // after 299 clicks on Receive
chain.mine();

const report = await diagnoseSeed(phrase, chain, { gap: 400, accounts: 1, otherCoinType: false });
console.log(report.recommended?.variant.id, report.recommended?.balance.confirmed); // oyster m/86'/1'/0' 2600000000n
console.log(report.reasons.map((reason) => reason.code)); // [ 'BEYOND_RECOVERY_WINDOW' ]
console.log(report.reasons[0]?.addresses?.length); // 1
```

Here the phrase was paid at its first address and at its 301st. A restore in Oyster finds the first payment and misses the second, and the report says so with the reason `BEYOND_RECOVERY_WINDOW`. [examples/recover-seed.ts](../../examples/recover-seed.ts) runs the whole flow, from the diagnosis through to a watch-only wallet that follows the coins.

`diagnoseSeed` takes the phrase, a hex seed (with or without `0x`) or the seed as bytes, and a [wallet backend](wallet-backends.md) to read the chain through. It needs nothing else and stores nothing, and it is exported from `pearljs/recover` as well as from `pearljs`. Point the backend at the network the phrase was used on, and let it catch up with the chain before running the scan.

## Derivations

A derivation is one way of turning the phrase into addresses. Every derivation below comes from Pearl's source, and the report names each one by its variant id:

| Variant | What uses it | Scanned by a restore |
| --- | --- | --- |
| `oyster m/86'/coin'/0'` | Oyster and the desktop wallet | yes, within the recovery window |
| `oyster m/86'/coin'/N'`, N from 1 | accounts made with Oyster's `createnewaccount` | no: a restore scans account 0 only |
| `as-typed m/86'/coin'/0'` | Oyster's command line, `--create` and `--createfromfile`, given a phrase with unusual spacing | only by Oyster's command line, given the same spacing |
| `hex m/86'/coin'/0'` | a hex seed of 16 to 64 bytes, which Oyster and the desktop wallet take in place of a phrase and use as the BIP32 seed | yes |
| the other coin type | a wallet made on the other kind of network: coin type 1 on mainnet, 808276 elsewhere | no |
| `passphrase[i] m/86'/coin'/0'` | a BIP39 passphrase, which neither Oyster nor the desktop wallet sets | no |
| `oyster pq m/86'/coin'/0'` | addresses that Oyster's `getnewaddress` and `getrawchangeaddress` gave with `pq=true`, before Pearl removed that argument | no |

The `oyster` derivation is what Oyster and the desktop wallet make from a phrase: a BIP39 English phrase, a seed made from it with no passphrase, and BIP86 receive (`/0/i`) and change (`/1/i`) chains, with coin type 808276 on mainnet and 1 on testnet, testnet2, regtest and simnet. A restore scans it block by block, and finds a payment only when its address is at most 250 past the last address found in earlier blocks, or among the first 250 before any has been found ([Coins beyond the recovery window](#coins-beyond-the-recovery-window)).

The `as-typed` derivation comes from Oyster's command line, which hashes the phrase as typed. It trims the phrase, and lowercases it at the `--create` prompt, then uses its UTF-8 bytes as they are, with no Unicode normalization. It splits words on every Unicode space, so a double space, a tab, a line break, a no-break space (U+00A0), an em space (U+2003) or an ideographic space (U+3000) between words passes its check and gives a different seed. A phrase split only by U+0085, which the desktop wallet doesn't read at all, gets this variant alone. The desktop wallet, by contrast, collapses whitespace and lowercases a phrase before Oyster sees it, in the same way as `normalizeMnemonic` and `mnemonicToSeed`, so a phrase first entered at Oyster's command line with odd spacing restores to a different wallet in the desktop wallet. `diagnoseSeed` tries a phrase as the desktop wallet reads it and, when that differs, as typed.

A `passphrase` variant is tried only for the `passphrases` given. It is named by the passphrase's index `i` in that list, which is also `variant.passphraseIndex`, and never by the passphrase itself. The password the desktop wallet asks for encrypts the wallet file and isn't a BIP39 passphrase.

An `oyster pq` address is the BIP86 key tweaked with a one-leaf tree, `<xmss_pubkey> OP_CHECKXMSSSIG`, whose XMSS key comes from `m/222'/coin'/0'/b/i`. These are checked for the first `pqAddresses` indices of each chain, and `oysterPqAddress(seed, network, index, change)` gives one such address.

## Options

The options set how far and how wide the scan goes:

| Option | Default | Description |
| --- | --- | --- |
| `gap` | 1000 (`DEFAULT_RECOVERY_GAP`) | Consecutive unused addresses that end a chain's scan, four times Oyster's window |
| `accounts` | 3 | Accounts scanned, from 0 |
| `otherCoinType` | true | Whether the other coin type is scanned |
| `passphrases` | none | BIP39 passphrases to try |
| `pqAddresses` | 0 | How many `oyster pq` addresses to derive on each chain; each costs an XMSS key generation, a couple of seconds |
| `p2mrAddresses` | none | P2MR addresses to check besides the derived ones, such as an XMSS key's |
| `scanLimit` | 10,000 | Addresses scanned on one chain of a variant before the scan gives the backend up and rejects with `BACKEND_RESPONSE`, as a wallet sync does, which stops a backend that calls every address used |
| `batchSize` | 50 | Addresses asked about in each round |
| `signal` | none | Stops the scan between rounds |
| `onVariant` | none | Called as each variant starts, for progress |
| `shareAccountKeys` | false | Whether account keys go to the backend, here and in `diagnoseAccount` ([Privacy](#privacy)) |

## Read the report

`report.variants` has one entry for each variant scanned, in the order tried. Each holds the variant's used receive and change addresses with what each one holds, the next index of each chain, the unspent outputs, the balance, and `requiredGap`, the smallest gap limit that reaches every used address. `report.recommended` is the variant that holds the most, or `null` when no address of any variant has ever been paid. `report.reasons` explains the shortfall:

| Code | Meaning | What to do |
| --- | --- | --- |
| `BEYOND_RECOVERY_WINDOW` | Payments a restore misses, because their addresses lie beyond Oyster's recovery window. `addresses` names them and `outputs` lists the unspent outputs | See [Coins beyond the recovery window](#coins-beyond-the-recovery-window) |
| `OTHER_DERIVATION` | Coins sit on a variant that a restore doesn't scan; the message names it | Follow or spend them from that variant ([Follow the coins](#follow-the-coins)) |
| `IMMATURE_COINBASE` | Coinbase outputs with fewer than 100 confirmations, which wallets don't count as spendable yet | Wait for them to mature |
| `UNCONFIRMED` | Payments still in the mempool | Wait for a block |
| `P2MR_NOT_SEEN` | The backend couldn't answer for a P2MR address given in `p2mrAddresses` | Run the scan again through a backend that can read P2MR addresses ([Choosing a backend](../start/choosing-a-backend.md)) |
| `SPENT` | Addresses were paid and everything they held has since been spent, and the `p2mrAddresses` hold nothing either | Nothing is left to recover on those addresses |
| `NO_ACTIVITY` | No address of any variant was paid within `gap`, and no address in `p2mrAddresses` holds anything | Check the phrase, the network, and that the backend has caught up with the chain |

Amounts in the messages are in PRL, and every amount field is in grain.

## Coins beyond the recovery window

Oyster's restore walks the chain block by block. In each block it watches only the addresses up to 250 past the last one it has found so far, or the first 250 before it has found any, and it never goes back to an earlier block. A payment to an address further out is missed, even when a later payment brings that address inside the window: if index 0 is paid, then index 300, then index 200, the coins at index 300 are left out. Each press of Receive hands out a new address, so a wallet whose owner pressed it often can get there.

Oyster's window is fixed, so the fix is to restore the seed into a `PearlWallet` whose `gapLimit` is at least the variant's `requiredGap`. A `PearlWallet` scans by index rather than by block, so it finds the coins, and it can then send them to an address of the restored Oyster wallet.

## Scan an account key

`diagnoseAccount` runs the same scan on one account given as its extended public key, so the phrase never has to be typed into the machine that runs the scan. Pass the key's origin as `origin`, and the report carries it:

```ts run
import { deriveAccountFromSeed, diagnoseAccount, mnemonicToSeed, parsePearl } from 'pearljs';
import { SimulatedChain } from 'pearljs/testing';

const chain = new SimulatedChain();
const account = deriveAccountFromSeed(mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'), chain.network);
chain.pay(account.deriveAddress(3, true), parsePearl('2'));
chain.mine();

const origin = { masterFingerprint: account.masterFingerprint!, path: account.path! };
const report = await diagnoseAccount(account.extendedPublicKey(), chain, { gap: 50, origin });
console.log(report.balance.confirmed, report.variants[0]?.change.used[0]?.index); // 200000000n 3
```

## Follow the coins

Once the report names the account, a watch-only wallet can follow its coins. Give the wallet the account key, its origin, and a gap limit of at least `requiredGap`. Without it the wallet uses Oyster's 250 and misses the same addresses Oyster misses:

```ts run
import { PearlWallet, createMemoryStore, deriveAccountFromSeed, diagnoseSeed, formatPearl, mnemonicToSeed, parsePearl } from 'pearljs';
import { SimulatedChain } from 'pearljs/testing';

const chain = new SimulatedChain();
const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
chain.pay(deriveAccountFromSeed(mnemonicToSeed(phrase), chain.network).deriveAddress(300), parsePearl('25'));
chain.mine();
const report = await diagnoseSeed(phrase, chain, { gap: 400, accounts: 1, otherCoinType: false });

const best = report.recommended!;
const wallet = await PearlWallet.create({
  store: createMemoryStore(),
  backend: chain,
  watchOnly: best.accountKey!,
  watchOnlyOrigin: best.origin!,
  gapLimit: best.requiredGap,
});
await wallet.sync();
console.log(best.requiredGap, formatPearl(wallet.balance().confirmed)); // 301 25
```

To spend the coins, create a `PearlWallet` from the phrase with the same `gapLimit` ([Restore](wallet-restart-and-backup.md#restore)), or sign the watch-only wallet's prepared sends elsewhere ([Sign a wallet send elsewhere](wallet-sign-elsewhere.md)). Coins on an `as-typed` or `passphrase` variant need the seed that variant was made from, so pass that seed as `seed` to `PearlWallet.create`. For a variant with another account number, `deriveSigningAccountFromSeed(seed, network, account)` gives the signing account.

## Privacy

The phrase and the keys stay in the process running the scan, and only addresses are sent to the backend.

`shareAccountKeys: true` changes that. Each scanned account's extended public key then goes to a backend that can ask about whole accounts at once, such as Blockbook with `useXpub`. That shows the backend every address of every account scanned, past and future, including those of passphrase variants and of unused accounts.
