# Spend any other P2MR leaf

Some P2MR leaves need more than a signature to spend: a preimage, items that take no signature at all, a signature that follows an `OP_CODESEPARATOR`, or an annex. Each kind can be spent through a PSBT, or by signing on the transaction and building the witness yourself. [Build and spend a P2MR output](p2mr.md) covers building the tree itself.

## Finalize a leaf that takes more than signatures

A leaf that wants a preimage, or one that takes no signature, still travels in a PSBT like any other. The signers add their signatures as usual, and whoever finalizes supplies the remaining items with `finalizeScriptPathInput`, the same function that finishes such a leaf in a P2TR output ([Finalize leaves that need more than signatures](psbt-co-signers.md#finalize-leaves-that-need-more-than-signatures)).

In this example the first input spends a hash lock, which needs a signature and the secret behind a hash. The second spends a leaf that joins two items with OP_CAT and compares the hash of the result, so it takes no signature:

```ts run
import {
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
  p2mr,
  parsePearl,
  parsePsbt,
  prepareP2mrScriptPathInput,
  sha256,
  toOutputScript,
  verifyFinalizedPsbt,
  ScriptRejectedError,
} from 'pearljs';

const network = networks.regtest;
const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const account = deriveSigningAccountFromSeed(mnemonicToSeed(phrase), network);
const key = account.derivePublicKey(0);

const secret = new TextEncoder().encode('open sesame');
const hashLock = compileScript([OP_CODES.OP_SHA256, sha256(secret), OP_CODES.OP_EQUALVERIFY, key, OP_CODES.OP_CHECKSIG]);
// Two items that must join into a committed value: no key, no signature.
const whole = new TextEncoder().encode('pearl-covenant');
const joined = compileScript([OP_CODES.OP_CAT, OP_CODES.OP_SHA256, sha256(whole), OP_CODES.OP_EQUAL]);
const tree = assembleScriptTree([hashLock, joined]);

const funding = createTransaction(2); // made up: two outputs paying the tree
addInputByTxid(funding, 'aa'.repeat(32), 0);
funding.addOutput(p2mr({ merkleRoot: tree.root }).output, parsePearl('1'));
funding.addOutput(p2mr({ merkleRoot: tree.root }).output, parsePearl('1'));

const unsigned = createTransaction(2);
addInputByTxid(unsigned, funding.getId(), 0);
addInputByTxid(unsigned, funding.getId(), 1);
unsigned.addOutput(toOutputScript(account.deriveAddress(9), network), parsePearl('1.9999'));
const psbt = createPsbt(unsigned);
prepareP2mrScriptPathInput(psbt, 0, { tree, leafIndex: 0, value: parsePearl('1'), previousTransaction: funding });
prepareP2mrScriptPathInput(psbt, 1, { tree, leafIndex: 1, value: parsePearl('1'), previousTransaction: funding });
account.signScriptPathInput(psbt, 0, { index: 0, leafHash: tree.leaves[0]!.leafHash });

// Whoever knows the secret finalizes, from the PSBT as it arrived.
const received = parsePsbt(psbt.toBase64());
try {
  finalizeScriptPathInput(received, 0, { stack: (signatureFor) => [secret, signatureFor(key)] });
} catch (err) {
  // The leaf hashes the top item, and the signature was on top.
  console.log((err as ScriptRejectedError).scriptCode); // ErrEqualVerify
}
finalizeScriptPathInput(received, 0, { stack: (signatureFor) => [signatureFor(key), secret] });
finalizeScriptPathInput(received, 1, { stack: [whole.slice(0, 5), whole.slice(5)] });
const tx = finalizePsbt(received);
console.log(tx.ins.map((input) => input.witness.length), verifyFinalizedPsbt(received).ok); // [ 4, 4 ] true
```

The stack lists the items bottom first, so the last one is on top when the leaf starts. The first attempt puts the signature on top, where the leaf expects the secret, so the script engine refuses it with `ErrEqualVerify` and the input stays as it was. The second attempt has the order right. [Finalize leaves that need more than signatures](psbt-co-signers.md#finalize-leaves-that-need-more-than-signatures) explains the `stack` option, the script check and the `WITNESS_ITEMS_NEEDED` error.

## Sign a leaf on the transaction

The PSBT signers cannot sign every leaf. A signature that follows an `OP_CODESEPARATOR`, or one for an input that carries an annex, needs information a PSBT has no field for. Sign those leaves on the transaction with `signTapscriptUnchecked` and build the witness yourself: the leaf's arguments, bottom of the stack first, then the script and the control block.

This leaf needs a signature and the preimage of a hash:

```ts run
import {
  OP_CODES,
  addInputByTxid,
  assembleScriptTree,
  compileScript,
  createTransaction,
  inspectTransaction,
  networks,
  p2mr,
  p2mrControlBlock,
  parsePearl,
  scriptPathWitness,
  sha256,
  signTapscriptUnchecked,
  signerFromPrivateKey,
  toOutputScript,
} from 'pearljs';

const network = networks.regtest;

// Any object with publicKey and signSchnorr signs a leaf. signerFromPrivateKey makes one
// from a raw key, and account.tapscriptSigner({ index }) one for an account's child.
const signer = signerFromPrivateKey(new Uint8Array(32).fill(9));

const preimage = new TextEncoder().encode('open sesame');
const script = compileScript([
  OP_CODES.OP_SHA256,
  sha256(preimage),
  OP_CODES.OP_EQUALVERIFY,
  signer.publicKey,
  OP_CODES.OP_CHECKSIG,
]);
const tree = assembleScriptTree([script]);
const output = p2mr({ merkleRoot: tree.root }).output;

const tx = createTransaction(2);
addInputByTxid(tx, 'dd'.repeat(32), 0); // a made-up output paying the tree 1 PRL
tx.addOutput(toOutputScript('rprl1p8dhv8twyj9ezfvk62vvsfgw39s4dgl9t42y0549dc4d2947jj4cs30wfpz', network), parsePearl('0.9999'));

const prevouts = [{ script: output, value: parsePearl('1') }];
const signature = signTapscriptUnchecked(tx, 0, signer, { prevouts, script });
// The script hashes the top item, so the preimage goes above the signature.
tx.setWitness(0, scriptPathWitness([signature, preimage], script, p2mrControlBlock(tree, 0)));

const spend = inspectTransaction(tx, prevouts, network).inputs[0]!.spend;
console.log(spend.type === 'scriptPath' && spend.commits); // true: the control block opens the output
```

`signTapscriptUnchecked` verifies its signature against the signer's key before returning it, and that is the only check it makes. It leaves the previous transactions, the fee and the script itself to you, so run the finished spend through `verifyInput` ([Check a spend with the script interpreter](interpreter.md)) to see whether Pearl's script engine accepts it, and try it with `testMempoolAccept` on regtest before using it with real funds.

A code separator in a leaf and an annex on an input each need an extra argument when you sign, and [Code separators and the annex](../reference/p2mr-control-blocks.md#code-separators-and-the-annex) shows both.
