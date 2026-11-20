# Control blocks and script trees

## P2MR control blocks

`p2mrControlBlock(tree, leafIndex)` is the last witness item of a P2MR spend. It is the byte 0xc1 (leaf version 0xc0 with the parity bit Pearl requires set) followed by the leaf's proof.

| Helper | Use |
| --- | --- |
| `parseP2mrControlBlock` | Reads a control block with the checks of Pearl's `ParseMerkleRootControlBlock` |
| `rootFromProof` | Hashes a leaf up to its root |
| `verifyP2mrLeafCommitment` | Throws unless a control block and script open a given witness program |
| `tapLeafHash`, `tapBranchHash` | The tagged hashes underneath |

## Signature message

`tapscriptSighash` computes the signature message as Pearl's consensus code does, pinned by vectors generated from Pearl's Go code. It is what the script-path signers sign.

## Code separators and the annex

A code separator in a leaf and an annex on an input each need an extra argument when you sign, and Pearl's script engine checks both.

For a signature checked after an `OP_CODESEPARATOR` has run, the signer needs the position of the last separator executed. The position counts the opcodes before the separator, and a push of any size counts as one. `codeSeparatorPositions(script)` lists the position of every separator in a leaf, and you pass the right one to the signer as `codeSeparatorPosition`. A signature check that runs before any separator takes no position.

The annex is an optional last witness item that starts with the byte 0x50 (`TAPROOT_ANNEX_TAG`). Pearl gives it no meaning and relays it. When an input carries one, pass the same `annex` to the signer and to `scriptPathWitness`. `signP2mrInput` and `signXmssP2mrInput` take `annex` too. `inspectTransaction` reports an input's annex separately from its stack, and `estimateVsize` prices it from `annexLength` ([Relay policy and fee bumping](../guides/relay-policy-and-fee-bumping.md)).

This leaf checks one signature before a separator and one after it, and the spend carries an annex:

```ts run
import {
  OP_CODES,
  addInputByTxid,
  assembleScriptTree,
  codeSeparatorPositions,
  compileScript,
  createTransaction,
  networks,
  p2mr,
  p2mrControlBlock,
  parsePearl,
  scriptPathWitness,
  signTapscriptUnchecked,
  signerFromPrivateKey,
  toOutputScript,
} from 'pearljs';

const first = signerFromPrivateKey(new Uint8Array(32).fill(1));
const second = signerFromPrivateKey(new Uint8Array(32).fill(2));
// The first check runs before the separator, the second after it.
const script = compileScript([
  first.publicKey,
  OP_CODES.OP_CHECKSIGVERIFY,
  OP_CODES.OP_CODESEPARATOR,
  second.publicKey,
  OP_CODES.OP_CHECKSIG,
]);
const [separator] = codeSeparatorPositions(script); // 2: after one push and one opcode
const tree = assembleScriptTree([script]);

const tx = createTransaction(2);
addInputByTxid(tx, 'ee'.repeat(32), 0); // a made-up output paying the tree 1 PRL
tx.addOutput(toOutputScript('rprl1p8dhv8twyj9ezfvk62vvsfgw39s4dgl9t42y0549dc4d2947jj4cs30wfpz', networks.regtest), parsePearl('0.9999'));

const annex = Uint8Array.of(0x50, 0x01);
const signed = { prevouts: [{ script: p2mr({ merkleRoot: tree.root }).output, value: parsePearl('1') }], script, annex };
const firstSignature = signTapscriptUnchecked(tx, 0, first, signed);
const secondSignature = signTapscriptUnchecked(tx, 0, second, { ...signed, codeSeparatorPosition: separator! });
// The script checks the first key first, so its signature is on top of the stack.
tx.setWitness(0, scriptPathWitness([secondSignature, firstSignature], script, p2mrControlBlock(tree, 0), annex));
console.log(tx.ins[0]!.witness.length); // 5: two signatures, the script, the control block, the annex
```

A PSBT has no field for an annex or a separator position, so the PSBT signers sign for neither, and leaves like these are always signed on the transaction as shown here.

## Script trees in P2TR outputs

P2TR outputs can carry the same kind of tree next to their key path. The tree, leaves and signatures are the same. Only the control block and the PSBT fields differ.

A P2TR output with a script tree is `p2tr({ internalPubkey, merkleRoot: tree.root })`. It can be spent by its key path, or by a leaf through a PSBT. `prepareTaprootScriptPathInput` adds the BIP371 fields: the witness UTXO, the internal key, the Merkle root, and the leaf with its control block. The same `signScriptPathInput` and `finalizePsbt` finish it. Pearl's own PSBT code reads and finalizes these.

```ts run
import {
  addInputByTxid,
  assembleScriptTree,
  checksigScript,
  createPsbt,
  createTransaction,
  deriveSigningAccountFromSeed,
  finalizePsbt,
  mnemonicToSeed,
  networks,
  p2tr,
  parsePearl,
  prepareTaprootScriptPathInput,
  toOutputScript,
} from 'pearljs';

const network = networks.regtest;
const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const account = deriveSigningAccountFromSeed(mnemonicToSeed(phrase), network);

const internalPubkey = account.derivePublicKey(0, true);
const tree = assembleScriptTree([0, 1, 2].map((index) => checksigScript(account.derivePublicKey(index))));
const output = p2tr({ internalPubkey, merkleRoot: tree.root }).output;

const unsigned = createTransaction(2);
addInputByTxid(unsigned, 'ee'.repeat(32), 0); // a made-up output paying `output` 1 PRL
unsigned.addOutput(toOutputScript(account.deriveAddress(9), network), parsePearl('0.9999'));

const psbt = createPsbt(unsigned);
prepareTaprootScriptPathInput(psbt, 0, { internalPubkey, tree, leafIndex: 2, value: parsePearl('1') });
account.signScriptPathInput(psbt, 0, { index: 2, leafHash: tree.leaves[2]!.leafHash });
console.log(finalizePsbt(psbt).getId(), output.length);
```

`taprootControlBlock`, `parseTaprootControlBlock`, `taprootOutputKey` and `verifyTaprootLeafCommitment` are the P2TR counterparts of the P2MR helpers. No previous transactions are needed for a P2TR input.

For a P2TR output that only its leaves can spend, use `p2trScriptOnly({ merkleRoot: tree.root })`. Its internal key is `NUMS_INTERNAL_KEY`, the point H of BIP341. Its x coordinate is the SHA-256 of the generator's uncompressed encoding, so nobody holds a private key for it. Pass the same constant as `internalPubkey` to `prepareTaprootScriptPathInput` when spending. A P2MR output has no key path to begin with.

A hardware device signs the key path of an output with a tree through `signTaprootKeyPathInputAsync`, which hands the signer the Merkle root to tweak with.
