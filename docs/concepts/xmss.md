# XMSS

XMSS is a hash-based signature scheme, and Pearl uses it for keys meant to stay safe against a quantum computer. The chain checks XMSS signatures with its own opcode, `OP_CHECKXMSSSIG`, inside a P2MR script leaf. With pearljs you can make XMSS keys, lock outputs to them and spend those outputs, and the signatures it makes are byte for byte the ones Pearl's own library makes.

An XMSS key is stateful, which sets it apart from every other key on the chain. Each signature uses up one of a fixed number of one-time indices, and the signer has to remember which ones are gone. The tasks have their own guides: [Spend from an XMSS key](../guides/xmss-spend.md), [Keep XMSS index state](../guides/xmss-store.md) and [Hold XMSS keys in a wallet](../guides/wallet-xmss-keys.md).

## Keys

pearljs ports the XMSS code that Pearl builds, with SHAKE256 as the hash, n = 32, Winternitz parameter w = 16 and a single tree of height 5. These are the sizes involved:

| | Bytes | Constant |
| --- | --- | --- |
| Private seed | 64 | `XMSS_PRIVATE_SEED_LENGTH` |
| Public seed | 32 | `XMSS_PUBLIC_SEED_LENGTH` |
| Public key (root, then public seed) | 64 | `XMSS_PUBLIC_KEY_LENGTH` |
| Secret key | 128 | `XMSS_SECRET_KEY_LENGTH` |
| Message (a sighash) | 32 | `XMSS_MESSAGE_LENGTH` |
| Signature | 2340 | `XMSS_SIGNATURE_LENGTH` |

A key is made from its two seeds, as Pearl's `xmss.Keygen` makes it. Neither Pearl nor pearljs derives an XMSS key from a recovery phrase, so the seeds themselves are the backup of the key. Signing is deterministic: the same key, index and message always give the same signature.

Making a key takes about 0.65 seconds on a current laptop, nearly all of it spent in the Keccak permutation. `createXmssSigner` builds the key's tree once and keeps it, so each signature after that takes about 20 ms, including the check that the new signature verifies.

## Leaves and size

An XMSS leaf is the script `<64-byte public key> OP_CHECKXMSSSIG`. It sits in a P2MR tree like any other leaf, either alone or next to leaves that offer other ways to spend the same output.

XMSS spends are large because of the 2340-byte signature. A spend with one input and one output is 701 vbytes through an XMSS leaf and 121 vbytes through a `<key> OP_CHECKSIG` leaf, so at the same fee rate the XMSS spend costs nearly six times as much. `estimateVsize` prices an XMSS leaf exactly ([Estimate size and fee](../guides/relay-policy-and-fee-bumping.md#estimate-size-and-fee)).

## Index state

Every XMSS signature is made at a one-time index, which is written big-endian into the first four bytes of the signature. The signer has to keep track of the indices it has used for the whole life of the key, across restarts, crashes and machines.

> [!WARNING]
> Never let an XMSS key sign at the same index twice. Two signatures over different messages at one index let anyone forge signatures under that key and take the funds it guards, and nothing on the chain prevents it. The usual way this happens is restoring a backup of the index state, or a virtual machine or container snapshot that contains it, because the restored state is older than the key's real use and hands out the same indices again.

`createXmssSigner` takes an `XmssIndexStore` to keep this state. A store has two methods. `reserve(publicKey)` returns an index it has never returned for that key, and records the index durably before it returns. `peek(publicKey)` returns the next unused index without changing anything. The signer reserves an index, then signs, then verifies the result, so a failure at any step wastes an index and never repeats one.

A key has exactly one store, shared by everything that signs with it. Within one process the signer also protects against the mistakes it can see:

- `sign` calls run one at a time, in the order they were made.
- An index that is not above the last one the signer used is refused, with a message such as `XMSS index store returned index 3 after index 3; refusing to reuse a one-time index`.
- A signer refuses to sign a second message at an index that another signer for the same key in the same process has already used.

These checks end at the process boundary. A second process, a second machine or a restored store can repeat indices, and only the store can prevent that.

`createMemoryXmssIndexStore` keeps its state in memory and starts again at index 0 in each new process, so it suits tests and keys that are thrown away with the process. [Keep XMSS index state](../guides/xmss-store.md) covers the file store for real keys and how to write a store of your own.

## Signature limit

A key makes 31 signatures (`XMSS_MAX_SIGNATURES`), at indices 0 to 30 (`XMSS_LAST_INDEX`). The tree has 32 leaves, but Pearl's library returns a signature that does not verify at index 31, so pearljs stops at 30. After the 31st signature the signer throws an `XmssError` with code `XMSS_INDEX_EXHAUSTED` and the message `this XMSS key has used all 31 of its signatures`. `signer.remaining()` returns how many signatures are left, as the store counts them.

```ts run
import { createMemoryXmssIndexStore, createXmssSigner, XMSS_MAX_SIGNATURES } from 'pearljs';

const signer = createXmssSigner(new Uint8Array(64).fill(1), new Uint8Array(32).fill(2), createMemoryXmssIndexStore());
const message = new Uint8Array(32);
console.log(await signer.remaining()); // 31
for (let i = 0; i < XMSS_MAX_SIGNATURES; i += 1) await signer.sign(message.fill(i));
console.log(await signer.remaining()); // 0
try {
  await signer.sign(message.fill(255));
} catch (err) {
  console.log((err as Error).message); // this XMSS key has used all 31 of its signatures
}
```

Each input spent through the leaf takes one signature, so a key can spend at most 31 outputs in its life. Every signature counts toward that, whether or not its transaction is broadcast, and that shapes how to use a key:

- Use an XMSS address for a few larger payments rather than as a reusable deposit address, because a 32nd output paid to it cannot be spent through that leaf.
- A spend that failed or was abandoned has still used its index, and so has a transaction that you signed and then replaced with another.
- Move the funds to a new key before the old one runs out, while it still has a signature left for the transaction that moves them.

## Backups

Back up the two seeds, which are the key itself. The index state is a record of use that changes with every signature, so any copy of it is out of date as soon as the key signs again. Restoring such a copy is the reuse described in the [warning above](#index-state), and so is copying the state file to a second machine, keeping it on storage that two machines can write, or restoring a snapshot that contains it.

To move a key to another machine, move the seeds and the state file together, once, and make sure the old machine never signs with the key again.

## In a wallet

A `PearlWallet` can hold XMSS keys itself ([Hold XMSS keys in a wallet](../guides/wallet-xmss-keys.md)). It keeps the seeds in its keystore and reserves each index in its own store before it signs, so a key in a wallet needs no separate index store, and everything above about one-time indices still applies.

Only the wallet's own `send` spends an XMSS key's coins, with the wallet unlocked and `from: { xmss: id }` naming the key. `prepareSend` and a send through a `signer` leave those coins out, because nothing outside the wallet can reserve the index. `submitSigned` refuses a signature of one of the wallet's keys at an index the wallet has already handed out, and when it accepts one, it moves the key past that index.

The wallet also guards against restored state:

- A key restored from a backup signs nothing until `burnXmssIndices` moves it past every index it may have used.
- A key freezes with `XMSS_KEY_BEHIND` when the chain shows it signing at or past its stored next index. The wallet checks this for a key added with seeds as soon as it is added, against what the wallet has recorded, and again when the next sync reads the key's whole history.

pearld's address index does not hold P2MR addresses, so `pearldBackend` finds an XMSS key's payments by matching block filters, and each block it looks at costs requests ([pearld backend](../reference/wallet-backends-reference.md#pearld-backend)).

## Births

A key's birth is the first block that could hold a payment to it, and a scan for the key's payments starts there. A key the wallet generates after it has synced cannot have been paid in any block the wallet had already seen, so the wallet records the block after its synced tip as the key's birth, together with that tip's hash. `xmssKeys()` shows the height as `birthHeight`.

Each sync passes the births to the backend through `setAddressBirths`. The backend scans the key's address from the birth for as long as the recorded tip block is still on the best chain. If a reorganization, the chain switching to a different branch of recent blocks, has taken that block out, the backend scans from its own start instead.

Some keys have no birth, and the backend scans these from its own start:

- A key added before the wallet's first sync.
- A key added with seeds, because the wallet cannot know its past, unless `addXmssKey({ privateSeed, publicSeed, nextIndex, birthHeight })` gives the lowest height that can hold a payment to it. A height above a real payment hides that payment.
- A key whose tip hash is not 64 lower-case hex digits, the form pearld gives. The wallet records a birth only when the backend's tip hash has that form. A stored birth whose parent hash has another form is kept, since the keystore authenticates it, but it is never used.

Because the keystore authenticates each birth, `restore` refuses a backup whose birth was changed, with `WALLET_BACKUP_INVALID`. A wallet opened from a store passes no births to the backend until it has been unlocked once in that process. After a restore it passes none until a sync has finished, so the first sync scans every XMSS key from the backend's start. A birth found to lie above a payment the wallet holds for its key is never passed on again.

## Sighash types and PSBT

`OP_CHECKXMSSSIG` accepts only SIGHASH_DEFAULT, so `signXmssP2mrInput` takes no `sighashType`. When every input of the spending transaction is a P2MR output, the signer looks up each input in `previousTransactions`, the transactions that created the outputs it spends, and checks that the output it points at has the script and value given, before anything is signed. `trustPrevouts` skips that check for a caller that has already verified the values.

Pearl defines no PSBT field for XMSS signatures, so XMSS spends are signed on the transaction itself. `payFromAccount` does not spend XMSS leaves, and `buildPayment` does ([Let the builder work out the fee](../guides/xmss-spend.md#let-the-builder-work-out-the-fee)).
