# Build a multisig vault with timelocks

A vault is an output that needs several keys to spend, with a way back in if keys are lost, such as a recovery key that can spend alone after a delay. On Pearl each of those conditions is a leaf script in a script tree. The co-signers' signatures are collected through a PSBT, and the recovery leaf can be spent once its timelock has passed. Swaps use hash timelock leaves instead, which [Build a hash timelock contract](hash-timelocks.md) covers.

Multisig on Pearl is always a `multi_a` leaf, `<key> OP_CHECKSIG <key> OP_CHECKSIGADD ... <k> OP_NUMEQUAL`, because `OP_CHECKMULTISIG` and `OP_CHECKMULTISIGVERIFY` are disabled.

## Build a vault

This tree has three ways out: any two of three keys, the recovery key alone once the output is 1008 blocks old, or Alice alone from block 200000.

```ts run
import {
  assembleScriptTree,
  checksigScript,
  cltvScript,
  csvScript,
  p2mrAddress,
  encodeSequence,
  multiAScript,
  networks,
  parseMultiA,
  scriptToAsm,
} from 'pearljs';

// x-only public keys, one from each party.
const alice = new Uint8Array(32).fill(2);
const bob = new Uint8Array(32).fill(3);
const carol = new Uint8Array(32).fill(4);
const recovery = new Uint8Array(32).fill(5);

const tree = assembleScriptTree([
  multiAScript([alice, bob, carol], 2),
  csvScript(encodeSequence({ blocks: 1008 }), checksigScript(recovery)),
  cltvScript(200_000, checksigScript(alice)),
]);
console.log(p2mrAddress({ merkleRoot: tree.root }, networks.mainnet)); // a P2MR address
tree.leaves.forEach((leaf) => console.log(scriptToAsm(leaf.script)));
console.log(parseMultiA(tree.leaves[0]!.script)?.threshold); // 2
```

The tree sits in a [P2MR output](p2mr.md) here, but it could also go in a P2TR output next to a key path ([Script trees in P2TR outputs](../reference/p2mr-control-blocks.md#script-trees-in-p2tr-outputs)). The address holds only the tree's root, so every party needs all the leaf scripts, in order, to rebuild the tree and spend.

## Collect signatures

One party builds the transaction and prepares the input, each co-signer adds a signature for the leaf, and whoever holds the PSBT when the threshold is met finalizes it. Only the base64 PSBT travels between them:

```ts run
import {
  addInputByTxid,
  assembleScriptTree,
  createPsbt,
  createTransaction,
  deriveSigningAccountFromSeed,
  finalizePsbt,
  fromOutputScript,
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
// Three accounts of one test phrase stand in for three people's wallets.
const seed = mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const alice = deriveSigningAccountFromSeed(seed, network, 0);
const bob = deriveSigningAccountFromSeed(seed, network, 1);
const carol = deriveSigningAccountFromSeed(seed, network, 2);

const tree = assembleScriptTree([multiAScript([alice, bob, carol].map((party) => party.derivePublicKey(0)), 2)]);
const output = p2mr({ merkleRoot: tree.root }).output;
const leafHash = tree.leaves[0]!.leafHash;

const funding = createTransaction(2); // a made-up transaction paying the vault 3 PRL
addInputByTxid(funding, 'cc'.repeat(32), 0);
funding.addOutput(output, parsePearl('3'));

// Alice builds, prepares and signs.
const unsigned = createTransaction(2);
addInputByTxid(unsigned, funding.getId(), 0);
unsigned.addOutput(toOutputScript(alice.deriveAddress(5), network), parsePearl('2.9999'));
const psbt = createPsbt(unsigned);
prepareP2mrScriptPathInput(psbt, 0, { tree, leafIndex: 0, value: parsePearl('3'), previousTransaction: funding });
alice.signScriptPathInput(psbt, 0, { index: 0, leafHash });
const forCarol = psbt.toBase64();

// One signature is not enough yet.
try {
  finalizePsbt(parsePsbt(forCarol));
} catch (err) {
  console.log((err as Error).message); // multi_a leaf has 1 of the 2 signatures it needs
}

// Carol parses what she was sent, checks it pays what she expects, and signs.
const received = parsePsbt(forCarol);
for (const out of received.txOutputs) console.log(fromOutputScript(out.script, network), out.value);
carol.signScriptPathInput(received, 0, { index: 0, leafHash });

const tx = finalizePsbt(received);
console.log(tx.getId(), tx.ins[0]!.witness.map((item) => item.length)); // [ 64, 0, 64, 104, 1 ]
```

The PSBT comes from someone else, so each co-signer should read its outputs and amounts before signing, as Carol does here. [Parsing](../reference/psbt-checks.md#parsing) lists what `parsePsbt` refuses.

Pearl rejects a multi_a witness without the empty items for keys that did not sign, so always finalize with `finalizePsbt` rather than the `Psbt` class's own `finalizeAllInputs()`, which leaves them out. [Multisig witnesses](../reference/multisig-and-timelocks-locks.md#multisig-witnesses) has the layout and the checks `finalizePsbt` makes.

## Timelocks

`cltvScript` and `csvScript` put a lock in front of any leaf:

| Builder | Script | Locks until |
| --- | --- | --- |
| `cltvScript(locktime, leaf)` | `<locktime> OP_CHECKLOCKTIMEVERIFY OP_DROP <leaf>` | An absolute block height (under 500000000, `LOCKTIME_THRESHOLD`) or Unix time (at or above it) |
| `csvScript(sequence, leaf)` | `<sequence> OP_CHECKSEQUENCEVERIFY OP_DROP <leaf>` | The spent output is a number of blocks, or of 512-second units, old |

The script checks the lock against fields of the spending transaction, so the spender sets those fields to match:

- A CLTV spend needs a transaction locktime of the same kind as the leaf's, height or time, and at least as large, and an input sequence other than 0xffffffff.
- A CSV spend needs a version 2 transaction and an input sequence of the same kind as the leaf's, blocks or seconds, and at least as long. The node also holds the transaction back until the input is that old.

`encodeSequence` makes the sequence for a relative lock. [Sequences](../reference/multisig-and-timelocks-locks.md#sequences) has how it rounds and the BIP68 fields, [Spending a timelocked leaf](../reference/multisig-and-timelocks-locks.md#spending-a-timelocked-leaf) spends the vault's recovery leaf, and [Signers by leaf](../reference/multisig-and-timelocks-locks.md#signers-by-leaf) lists which function spends each kind of leaf.
