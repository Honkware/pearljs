# Security model

pearljs is a library, so most of its security comes from what it checks before it signs and from how it reads data it didn't produce. The rest is left to your application, including how it handles the secrets it holds.

Outside the wallet module, pearljs stores nothing: your application holds the keys and decides what to sign. `PearlWallet` is the exception, because it keeps its state and keys in a store the application gives it ([The wallet](#the-wallet)).

To report a vulnerability, follow [SECURITY.md](../../SECURITY.md) rather than opening a public issue.

## Signing

Before a key is used, pearljs checks the transaction it is about to sign: which sighash type the signature uses, whether the coin being spent belongs to the signing key, and whether the fee is within bounds. After signing, it verifies the signature before returning it. Each of these is described below.

### Sighash types

A sighash type says which parts of a transaction a signature commits to. A PSBT input can carry one, and whoever handled the PSBT last can set it. With SIGHASH_NONE, for example, a signature commits to no outputs, and whoever holds it can redirect the money. The PSBT signers therefore sign with SIGHASH_DEFAULT, and they refuse an input that asks for any other type unless the caller lists that type in `allowedSighashTypes`. Signing with a weaker type is something your code opts in to, call by call ([PSBT checks](../reference/psbt-checks.md#sighash-types-a-signer-accepts)).

Message signatures are handled the same way. `verifyMessage` accepts a message signature under SIGHASH_DEFAULT or SIGHASH_ALL, and accepts other types only when `anySighashType` is set, because an Oyster-format signature under SIGHASH_NONE holds for any message ([Sign and verify messages](../guides/messages.md)).

`parsePsbt` refuses the encodings that Pearl's own parser refuses, such as trailing bytes, non-canonical lengths and a sighash field of the wrong size, so a PSBT can't mean one thing to pearljs and another to Pearl.

### Spent outputs

Before signing an input, pearljs checks that the coin being spent belongs to the key or script doing the signing. Each signer checks what it has been told about the coin:

| Signer | Check |
| --- | --- |
| `signInput` | the input's UTXO script belongs to the child key it is told to sign with |
| `payFromAccount` | every unspent output pays the child named for it, and a P2MR output commits to the tree given for it |
| the script-path signers | the leaf opens the spent output and pushes the signer's key |

When every input of the spending transaction is a P2MR output, the signers look up each input in the previous transactions and check that the output it points at has the script and value you gave, before anything is signed. `trustPrevouts` skips that check for a caller that has already verified the values ([Build and spend a P2MR output](../guides/p2mr.md)).

### Fees

A transaction's fee is whatever its inputs hold beyond its outputs. A forgotten change output therefore turns the whole remainder into fee, and nothing later in the pipeline would stop it ([Fee ceiling](../reference/payments-fees-and-coins.md#fee-ceiling)). pearljs guards against this in five places:

| Where | Guard |
| --- | --- |
| The payment builder | computes the fee from the rate and adds change itself |
| `finalizePsbt` | refuses to extract a transaction paying more than 5000 grain per vbyte |
| `checkPsbtPayment`, on the machine that signs | refuses a PSBT whose fee is above the `maxFee` it is given ([Sign a PSBT on an offline machine](../guides/psbt.md)) |
| `signP2mrInput`, `signXmssP2mrInput` and their async variants | refuse to sign when outputs exceed inputs or the fee is above the fee ceiling, `maxFeeRate` |
| `PearlWallet.send`, `bumpFee` and `sweep` | hold every transaction to the same ceiling before a key is used or anything is recorded |

Two kinds of signing fall outside these guards. `signTapscriptUnchecked` is the bare signing primitive and has no fee check. A transaction signed with a non-default sighash type under ANYONECANPAY can be completed by others, so its final fee isn't known when it is signed.

### Signature verification

Every tapscript and XMSS signature is verified against its public key before it is returned, and `finalizePsbt` verifies the script-path signatures of the inputs it finalizes. A fault during signing therefore produces an error rather than a bad signature on the wire.

### Auxiliary randomness

Every Schnorr signature made by a signing account, `sweepKey` or `signMessage` mixes in 32 fresh random bytes as BIP340's auxiliary randomness. Signing the same thing twice therefore gives two different signatures, both equally valid. The random bytes come from `crypto.getRandomValues`, as do generated mnemonics, so the platform's random source has to be sound.

With 32 zero bytes of auxiliary randomness instead, a signature is fully deterministic. A test that compares signature bytes can get that behaviour by passing `auxRand: new Uint8Array(32)`, but production code should leave the randomness on. Signers you bring yourself (`TapscriptSigner`) choose their own.

### Output types

Pearl has three kinds of output: P2TR, P2MR and OP_RETURN. pearljs's address and payment functions produce only those, and they reject base58 and witness v0 addresses. A transaction paying any other script still serializes, but consensus refuses it.

## Outside input

pearljs reads data from nodes, servers, files and other people, and sends some data back to servers.

### Hostile and malformed input

The parsers for transactions, PSBTs, WIF strings, scripts, blocks and addresses fail on malformed input with a typed error and a stable code ([Errors](../reference/errors.md)). They return copies rather than views into the caller's buffer, so changing the input later can't change the result.

A few readers go further. `scriptFromAsm` refuses text that could mean two different scripts. `refreshInvoice` refuses a chain answer without usable heights or amounts instead of turning it into an invoice state. RPC amounts are read from the reply text and never pass through a floating-point number.

### Account keys sent to a backend

An extended public key gives whoever holds it every address of the account, past and future, so pearljs sends one to a server only when asked to. Two places ask: `blockbookBackend` with `useXpub` ([Run a wallet over a Blockbook](../guides/blockbook.md)), and `diagnoseSeed` and `diagnoseAccount` with `shareAccountKeys`. In every other case a backend is asked about addresses one at a time, and recovery sends it nothing but addresses ([Recover a seed that shows zero](../guides/recovery.md)).

### Credentials on the wire

The RPC and websocket clients send a password over plain `http://` or `ws://` only to a loopback host, unless `allowInsecureAuth` is set. When a URL is malformed, they report it without echoing it. Certificate checking stays on, so a self-signed `rpc.cert` has to be trusted explicitly ([Connect to pearld and Oyster](../guides/rpc.md)).

## XMSS keys

An XMSS key is a post-quantum key that can sign with each of its indices once. Reusing an index forfeits the key, so pearljs keeps track of indices at three levels:

| Level | Protection |
| --- | --- |
| An `XmssSigner` | serializes its `sign` calls and refuses an index that isn't above its last one, and refuses a second message at an index that another signer in the same process used for the same key |
| The file store | records an index durably before it is used, by creating a marker file that can be created only once, and locks its file |
| A wallet | reserves each index with its store's `compareAndSet`, so two writers on one store are never both given the same index ([Hold XMSS keys in a wallet](../guides/wallet-xmss-keys.md)) |

A wallet also refuses to sign with an XMSS key restored from a backup until the key's index is moved forward, and it freezes a key whose signatures on chain show an index its store hasn't reached. [XMSS](xmss.md) says what remains the application's responsibility.

### XMSS state across processes and backups

A store keeps apart two writers that share it. A second copy of the store is out of its sight, though, and a copy repeats indices ([XMSS](xmss.md)).

## The wallet

`PearlWallet` keeps addresses, labels, history, locks and XMSS indices in its store in the clear. It keeps the recovery phrase, seed, imported keys and XMSS seeds encrypted under a passphrase with scrypt and AES-256-GCM. [Wallets](wallet.md#security-properties) has the full account, and the main properties, as implemented, are these.

Fees are held to a ceiling: every `send`, `bumpFee` and `sweep` is checked against `maxFeeRate` before a key is used or anything is recorded.

The keystore tags the wallet's accounts, imported addresses and XMSS public keys with their births. `unlock` and `restore` check the tag and fail with `KEYSTORE_TAMPERED` when it doesn't match, and from the first unlock on, the wallet refuses every operation if the store later shows other accounts or keys. Someone who can write the store but lacks the passphrase therefore can't redirect receive or change addresses once the wallet has been unlocked. Before that first unlock after `open`, the wallet has nothing to check against, so unlock it once after opening.

`create` and `restore` return the wallet unlocked for five minutes unless `unlockTimeout` says otherwise, and `lock()` or the timeout drops the key.

The file and IndexedDB stores lock out a second writer. If one gets in anyway, `compareAndSet` still gives each XMSS index and each file revision to one writer only.

Every XMSS key comes out of `restore` frozen, and it refuses to sign until `burnXmssIndices` moves it past every index it may have used. A key whose signatures on chain are ahead of its store freezes itself (`XMSS_KEY_BEHIND`).

The coins of a send the wallet signed are never freed on a backend's word, so an application that pays again when a send fails doesn't pay twice for a send that actually went out ([Send from a wallet](../guides/wallet-send.md)).

Some things lie outside these properties. The wallet can't tell a copy of its store from the original, so a copy hands out the same XMSS indices, and a signature made from it that never reached the chain is never caught ([XMSS](xmss.md)). Whoever can write the store can also change history, labels and counters, or put back an older copy, until `rescan()` or the chain shows otherwise.

### Sessions

A session lets a process that has lost its memory unlock the wallet again without the passphrase. An extension's service worker that Chrome stopped is the usual case. After an unlock with `allowSessionExport`, `exportSession()` wraps the keystore's data key under a new random 256-bit session key with AES-256-GCM, and `unlockWithSession(session)` unwraps it and unlocks. [Build a browser extension](../guides/browsers-and-bundlers-extensions.md) shows the calls in use.

A session is built to reveal as little as possible and to stop working when the keystore changes. It holds the data key and not the passphrase, and nothing in it derives the passphrase: the data key is random, and only the keystore wraps it under the passphrase.

The session is also bound to the keystore as it stands. Its associated data is a SHA-256 over the scrypt parameters, the salt and the wrapped data key, and a passphrase change makes a new data key as well. A session can therefore fail in two ways, and in both the keystore stays locked:

| Error | Cause |
| --- | --- |
| `KEYSTORE_SESSION_STALE` | the passphrase has changed since the session was made, or the session belongs to another keystore |
| `KEYSTORE_SESSION_INVALID` | a different session key, or an altered wrap |

Unlocking from a session runs the same tag checks as a passphrase unlock. `unlockWithSession` checks the tag over the set of secrets (`KEYSTORE_TAMPERED`), and `PearlWallet.unlockWithSession` also checks the tag over the wallet's accounts, imported addresses and XMSS keys.

`changePassphrase` still needs the old passphrase, and so does reading the recovery phrase. On a wallet unlocked from a session, `wallet.mnemonic()` fails with `KEYSTORE_PASSPHRASE_REQUIRED` until it is given the passphrase, which it checks with scrypt (`wallet.mnemonic(passphrase)`). That check guards the wallet's own interface, for an application that wants the phrase shown only to someone who knows the passphrase. It isn't a cryptographic limit, since the session's data key opens every secret in the keystore.

The data key stays inside WebCrypto, because `exportSession` and `unlockWithSession` use `wrapKey` and `unwrapKey`. To wrap it, the keystore holds the data key a second time as an extractable `CryptoKey`, from an unlock with `allowSessionExport` until `lock()`, and without that option it holds only the non-extractable key. The raw bytes that pearljs does handle, a session key given as bytes and the data key during a passphrase unlock, are copied and overwritten once imported.

`lock()` doesn't end a session. A session ends when the passphrase changes or when the application deletes what it stored. Until then it is the key to every secret in the keystore, and anyone with the session and a copy of the keystore can read the recovery phrase and sign, offline, without the passphrase.

What protects a session is therefore where it is kept, and the three usual places differ:

| Kept in | Who can read it | Survives | On disk |
| --- | --- | --- | --- |
| `chrome.storage.session`, the key as bytes | the extension's own pages and worker; content scripts only if `setAccessLevel` allows them; not web pages, not other extensions | worker restarts; not a browser exit, an extension reload or an update | no, memory only, though the operating system may page memory out |
| IndexedDB, the key as a non-extractable `CryptoKey` | any script running in the extension's origin can use it to unwrap; none can read its bytes through WebCrypto; not other extensions or web pages | worker restarts and browser exits, until deleted or site data is cleared | yes: the browser writes the key's bytes into its IndexedDB files in the profile, where disk forensics or malware with the user's file access can read them |
| memory of one worker or page only | that context | nothing | no |

Each kind of attacker reaches a stored session differently.

An attacker who runs script in the extension, through a compromised dependency or an XSS in an extension page, can use any session the extension can reach, in either storage, and could already call the unlocked wallet. A non-extractable key stops it from copying the key out of the browser, but it can still unwrap the data key and use it there and then.

Another extension or a web page can read neither storage. A page reaches the wallet only through the messages the extension chooses to answer.

Someone with the disk, such as a thief with an unencrypted laptop, a backup of the profile, or malware reading files, gets an IndexedDB session but not a `chrome.storage.session` one. Prefer `chrome.storage.session` for anything that should end with the browser, and delete the stored session on lock. Use IndexedDB only for a session meant to outlive the browser, and treat its lifetime as the time the user stays signed in.

A session copied to another machine works there too, because it is a secret and not a binding to one device.

## Limits

Some risks are outside what a library can control, and the application has to handle them.

### Keys in memory

pearljs overwrites the key bytes it holds once they are no longer needed. A signing account overwrites each child key once its signature is made, `account.destroy()` overwrites the master and account keys, and `signer.destroy()` overwrites an XMSS signer's secret key. That covers the byte arrays pearljs holds, including the keys of its BIP32 derivation. Some copies of secret material are out of its reach:

- the seed, which is the application's to wipe;
- a mnemonic, which is a JavaScript string and can't be overwritten at all;
- intermediate values, such as HMAC outputs and the WebAssembly signer's memory, which wait for the garbage collector, and the collector frees memory without clearing it;
- copies made by the JavaScript engine when it moves objects, or by the operating system when it pages memory out.

Wiping therefore narrows the window in which a key sits in memory without closing it. Code that needs more than that should keep keys out of the JavaScript process altogether, in a hardware wallet or a separate signing service, through the async signer interfaces.

pearljs makes no claim of constant-time execution.

### The machine and the dependencies

A compromised process can read the keys it holds. pearljs pins exact versions of its six runtime dependencies (bitcoinjs-lib, bip32, tiny-secp256k1, @scure/bip39, @noble/hashes, bech32), so review updates to them as you would updates to pearljs.

Two builds ship inside the package. One is the worker build of tiny-secp256k1, made from the pinned version. The other is the proof verifier, whose four files are refused unless their SHA-256 digests match the ones pinned in the package, wherever they are served from ([Load the verifier ahead of time](../guides/verify-proof.md#load-the-verifier-ahead-of-time)).

### A node or backend that lies

The payment builder trusts the list of unspent outputs it is given. A wrong value in a P2TR output makes the signature invalid rather than the payment wrong, because a Taproot signature commits to every input's value. A backend can still hide outputs, invent payments or withhold blocks, and an invoice monitor reports whatever its view of the chain shows.

Filter headers and block headers fetched from one node prove that the node is consistent, not that it is honest. `filterBackend`'s `crossCheck` endpoints hold a node to another node's chain ([Filters and the filter scan](compact-filters-scan.md)), and `blockbookBackend`'s `crossCheck` servers hold a Blockbook to others ([Blockbook trust](blockbook-trust.md)). For anything that decides whether you were paid, use a node you run.

### Unverified data

Several functions read data without verifying all of it, and the table shows what each leaves out:

| Function | Leaves unverified |
| --- | --- |
| Parsing a block, and the block checks | its certificate's ZK proof, which `verifyProof` and `verifyBlockProof` verify where your code calls them; the wallet backends don't call them ([Verify a block's proof](../guides/verify-proof.md)) |
| `checkStandard` | signatures, since it checks relay policy |
| `inspectTransaction`, and `finalizePayment` given a `signed` transaction | signatures |
| `verifyTransaction` | anything that depends on the chain; it runs the scripts and signatures of every input as Pearl's engine does ([Script interpreter](../guides/interpreter.md)), but doesn't replace a node |

### Decisions

pearljs signs what it is asked to sign. It can't know whether the recipient is the one the user meant, whether a PSBT from a co-signer pays what was agreed, or whether a fee is sensible at the moment, so show the outputs and the fee to whoever approves the payment.

## Handling secrets

Keep real recovery phrases, WIF keys and RPC passwords out of source code, URLs, logs and browser storage, and read them from the environment or a secret store instead. Hold the signing account in the smallest scope that needs it, and call `destroy()` when signing is done. A server that only watches for payments needs the account's extended public key and not the recovery phrase, so give it only that.
