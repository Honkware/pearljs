# Collect signatures from co-signers

When an output needs several people to spend it, the transaction passes between them as a PSBT, and each one adds a signature before somebody finalizes it. A multisig leaf needs only their signatures, and some leaves need a secret as well.

## Sign in parallel and merge

Co-signers on a multisig leaf all add their signatures to the same input. They can sign one after another, passing the PSBT along, or each sign a copy at the same time and merge the copies with `psbt.combine`:

```ts run
import {
  addInputByTxid,
  assembleScriptTree,
  createPsbt,
  createTransaction,
  deriveSigningAccountFromSeed,
  finalizePsbt,
  mnemonicToSeed,
  multiAScript,
  networks,
  p2mr,
  parsePearl,
  parsePsbt,
  prepareP2mrScriptPathInput,
  toOutputScript,
} from 'pearljs';

const network = networks.regtest;
const seed = mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const [alice, bob, carol] = [0, 1, 2].map((n) => deriveSigningAccountFromSeed(seed, network, n));
if (!alice || !bob || !carol) throw new Error('unreachable');

const tree = assembleScriptTree([multiAScript([alice, bob, carol].map((party) => party.derivePublicKey(0)), 2)]);
const leafHash = tree.leaves[0]!.leafHash;
const funding = createTransaction(2); // a made-up transaction paying the multisig 3 PRL
addInputByTxid(funding, 'cc'.repeat(32), 0);
funding.addOutput(p2mr({ merkleRoot: tree.root }).output, parsePearl('3'));

const unsigned = createTransaction(2);
addInputByTxid(unsigned, funding.getId(), 0);
unsigned.addOutput(toOutputScript(alice.deriveAddress(5), network), parsePearl('2.9999'));
const psbt = createPsbt(unsigned);
prepareP2mrScriptPathInput(psbt, 0, { tree, leafIndex: 0, value: parsePearl('3'), previousTransaction: funding });
const shared = psbt.toBase64();

// Alice and Carol each sign their own copy.
const fromAlice = parsePsbt(shared);
alice.signScriptPathInput(fromAlice, 0, { index: 0, leafHash });
const fromCarol = parsePsbt(shared);
carol.signScriptPathInput(fromCarol, 0, { index: 0, leafHash });

// Whoever collects them merges and finalizes.
const merged = parsePsbt(fromAlice.toBase64()).combine(parsePsbt(fromCarol.toBase64()));
console.log(finalizePsbt(merged).getId());
```

The leaf is two of three keys, so Alice's and Carol's signatures are enough and Bob never signs. [Multisig and timelocks](multisig-and-timelocks.md) builds such leaves and explains the witness they need. When every input of the PSBT is a P2MR output, each input has to carry its previous transaction, which `prepareP2mrScriptPathInput` stores from its `previousTransaction` option ([Previous transactions](p2mr.md#previous-transactions)).

## Finalize leaves that need more than signatures

Some leaves take witness items that no signer adds: a hash lock, a timelock branch that also wants a preimage, or a leaf that joins items with OP_CAT. The PSBT carries the signatures between the parties as usual, and whoever finalizes supplies the rest with `finalizeScriptPathInput`.

In this example both Alice and Bob sign, and the spender also reveals the secret behind a hash. The tree sits in a P2TR output whose internal key nobody can sign for, so the leaf is the only way to spend it:

```ts run
import {
  NUMS_INTERNAL_KEY,
  OP_CODES,
  addInputByTxid,
  assembleScriptTree,
  compileScript,
  createPsbt,
  createTransaction,
  deriveSigningAccountFromSeed,
  finalizePsbt,
  finalizeScriptPathInput,
  mnemonicToSeed,
  networks,
  p2trScriptOnly,
  parsePearl,
  parsePsbt,
  prepareTaprootScriptPathInput,
  sha256,
  toOutputScript,
  verifyFinalizedPsbt,
  PearlError,
} from 'pearljs';

const network = networks.regtest;
const seed = mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const alice = deriveSigningAccountFromSeed(seed, network, 0);
const bob = deriveSigningAccountFromSeed(seed, network, 1);
const [A, B] = [alice.derivePublicKey(0), bob.derivePublicKey(0)];

// Both sign, and the spender also reveals the secret behind the hash.
const secret = new TextEncoder().encode('swap secret 42');
const leaf = compileScript([
  OP_CODES.OP_SHA256, sha256(secret), OP_CODES.OP_EQUALVERIFY,
  A, OP_CODES.OP_CHECKSIGVERIFY,
  B, OP_CODES.OP_CHECKSIG,
]);
const tree = assembleScriptTree([leaf]);
const { leafHash } = tree.leaves[0]!;
// No key path: the internal key is one nobody can sign for.
const output = p2trScriptOnly({ merkleRoot: tree.root }).output;

const unsigned = createTransaction(2);
addInputByTxid(unsigned, 'ee'.repeat(32), 0); // a made-up output paying `output` 1 PRL
unsigned.addOutput(toOutputScript(alice.deriveAddress(9), network), parsePearl('0.9999'));
const psbt = createPsbt(unsigned);
prepareTaprootScriptPathInput(psbt, 0, { internalPubkey: NUMS_INTERNAL_KEY, tree, leafIndex: 0, value: parsePearl('1') });
console.log(output.length); // 34

// Alice signs and sends the PSBT to Bob; Bob signs and sends it back.
alice.signScriptPathInput(psbt, 0, { index: 0, leafHash });
const atBob = parsePsbt(psbt.toBase64());
bob.signScriptPathInput(atBob, 0, { index: 0, leafHash });
const back = parsePsbt(atBob.toBase64());

// Signatures alone do not satisfy the leaf, and finalizePsbt says so.
try {
  finalizePsbt(back);
} catch (err) {
  console.log((err as PearlError).code); // WITNESS_ITEMS_NEEDED
}

// The items in witness order: the last one is on top when the leaf starts.
// The leaf hashes the top item, then checks A, then B.
finalizeScriptPathInput(back, 0, { stack: (signatureFor) => [signatureFor(B), signatureFor(A), secret] });
const tx = finalizePsbt(back);
console.log(tx.ins[0]!.witness.length, verifyFinalizedPsbt(back).ok); // 5 true
```

`stack` is the list of items the leaf starts with, bottom first, or a function that builds that list. The function receives `signatureFor(publicKey)`, which returns the signature the PSBT holds for a key the leaf pushes after verifying it, and throws `SIGNATURES_MISSING` when there is none. The script and the control block are added for you. When the input has several leaves and no signature shows which one is meant, pass `leafHash` as well.

Before anything is written, `finalizeScriptPathInput` runs the finished witness through Pearl's script rules for that input and throws a `ScriptRejectedError` if the script engine refuses it ([Custom witnesses](../reference/psbt-checks.md#custom-witnesses)). Finalize the custom inputs first and then call `finalizePsbt`, or `finalizePayment`, for the rest.

## Next steps

- [Build a multisig vault with timelocks](multisig-and-timelocks.md)
- [Build a hash timelock contract](hash-timelocks.md)
- [PSBT checks and compatibility](../reference/psbt-checks.md)
