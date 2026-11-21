# Build and spend a P2MR output

A P2MR output, short for pay to Merkle root, locks coins to a set of scripts instead of to a key. The scripts are the leaves of a Merkle tree, and the output holds only the tree's 32-byte root, so its output script is `OP_2 <root>` (witness version 2) and its addresses start with `prl1z` on mainnet. To spend it, the spender reveals one leaf script, shows with a few hashes from the tree that the leaf belongs to the root, and satisfies the script, usually with a signature.

Pearl's ordinary P2TR addresses can carry the same kind of tree, but next to a key that can spend the coins on its own. A P2MR output has no such key, so the coins move only under the conditions written into its leaves. That suits shared custody such as two keys of three, a key that can spend only after a timelock, a swap that pays whoever reveals a secret, and XMSS keys, the post-quantum signatures Pearl checks inside a leaf.

The examples build a tree of two single-key leaves, make its address, and spend such an output from a BIP86 account.

## Build the tree and its address

`assembleScriptTree` takes the leaf scripts in order and returns the tree: its root, and for each leaf the script, its hash and the Merkle proof that a spend reveals. `p2mr` turns the root into an output script and `p2mrAddress` turns it into an address:

```ts run
import { assembleScriptTree, checksigScript, p2mrAddress, networks, p2mr, scriptToAsm } from 'pearljs';

const alice = new Uint8Array(32).fill(2); // x-only public keys
const bob = new Uint8Array(32).fill(3);

const tree = assembleScriptTree([checksigScript(alice), checksigScript(bob)]);
const output = p2mr({ merkleRoot: tree.root }).output; // OP_2 <root>
const address = p2mrAddress({ merkleRoot: tree.root }, networks.mainnet);

console.log(address); // prl1z...
tree.leaves.forEach((leaf, i) => console.log(i, scriptToAsm(leaf.script), leaf.proof.length / 32, 'proof hashes'));
```

Each leaf here is `checksigScript(key)`, the script `<key> OP_CHECKSIG`, which whoever holds that key spends with a signature. Either Alice or Bob can spend this output, and a spend shows only the leaf it uses.

`assembleScriptTree` pairs the leaves the way Pearl's Go `AssembleTaprootScriptTree` does, so the same scripts in the same order give the same root and proofs as Pearl. It pairs the leaves from left to right, joins an odd last leaf to the pair before it, and then merges the pairs as a queue until one root is left. Because the input is a flat list, the order of the scripts is all that decides the tree's shape. Every leaf gets leaf version 0xc0, the only version Pearl executes, and a list with the same script twice is refused.

The leaf scripts come from builders for the common conditions, or from your own script:

| Leaf | Builder | Spent with |
| --- | --- | --- |
| One key | `checksigScript(key)` | `signP2mrInput`, `payFromAccount`, PSBT |
| k of n keys | `multiAScript(keys, k)` | PSBT ([Multisig and timelocks](multisig-and-timelocks.md)) |
| XMSS key | `xmssLeafScript(publicKey)` | `signXmssP2mrInput` ([XMSS](../concepts/xmss.md)) |
| Timelocked | `cltvScript(n, leaf)`, `csvScript(n, leaf)` | As the inner leaf, with the locktime or sequence set |
| Anything else | `compileScript([...])` ([Scripts](scripts.md)) | `signTapscriptUnchecked` and `scriptPathWitness` |

> **Warning:** The address holds only the root, so a spend needs the script of the leaf it uses and the hashes that prove it. In practice that means keeping every leaf script, in order, next to the keys. Without the scripts the output cannot be spent, even by someone who holds every key.

## Spend through an account

When a leaf is `<child key> OP_CHECKSIG` for a key of a BIP86 account, `payFromAccount` spends the output just as it spends the account's ordinary coins. On the unspent output, give the child's `index` and add `p2mr` with the tree and the leaf to spend through:

```ts run
import {
  addInputByTxid,
  assembleScriptTree,
  checksigScript,
  createTransaction,
  deriveSigningAccountFromSeed,
  formatPearl,
  mnemonicToSeed,
  networks,
  p2mr,
  parsePearl,
  payFromAccount,
} from 'pearljs';

const network = networks.regtest;
const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const account = deriveSigningAccountFromSeed(mnemonicToSeed(phrase), network);

// A one-leaf tree held by child 7.
const tree = assembleScriptTree([checksigScript(account.derivePublicKey(7))]);
const output = p2mr({ merkleRoot: tree.root }).output;

// The transaction that paid the P2MR address. Here it is made up; on a
// chain, fetch it with getRawTransactionHex and parseTransaction.
const funding = createTransaction(2);
addInputByTxid(funding, 'aa'.repeat(32), 0);
funding.addOutput(output, parsePearl('5'));

const payment = payFromAccount(account, {
  network,
  utxos: [
    {
      txid: funding.getId(),
      vout: 0,
      value: parsePearl('5'),
      script: output,
      confirmations: 1,
      index: 7,
      p2mr: { tree, leafIndex: 0 },
    },
  ],
  recipients: [{ address: account.deriveAddress(0), amount: 'max' }],
  feeRate: 1000n, // grain/kvB
  previousTransactions: [funding],
});
console.log(payment.txid, payment.vsize, 'vbytes, fee', formatPearl(payment.fee), 'PRL');
```

`payFromAccount` prices the input at the real size of that leaf's witness, so the fee it reports is the fee of the signed transaction. `previousTransactions` holds the transaction that paid the P2MR address.

## Previous transactions

The P2MR signers take the transactions that created the outputs being spent. When every input of the spending transaction is a P2MR output, they look up each input in those transactions and check that the output it points at has the script and value you gave, before anything is signed.

Where you pass them depends on where you sign:

| Signing with | Pass |
| --- | --- |
| `signP2mrInput`, `account.signP2mrInput`, `signXmssP2mrInput` | `previousTransactions`, one for each input's txid |
| `payFromAccount` | `previousTransactions`, which it attaches to the inputs |
| `signP2mrScriptPathInput`, `account.signScriptPathInput` on a PSBT | Each input's `nonWitnessUtxo`, which `prepareP2mrScriptPathInput` sets from its `previousTransaction` option |

If the check fails, the signer throws one of these errors and signs nothing:

| Message | Code | Cause |
| --- | --- | --- |
| `this spend needs the previous transactions (previousTransactions) to check input values before signing; set trustPrevouts to skip the check` | `PREVIOUS_TRANSACTIONS_MISSING` | No previous transactions were given |
| `input <n> is missing the previous transaction it spends` | `PREVIOUS_TRANSACTIONS_MISSING` | The transaction for input n is not among them |
| `prevout <n> does not match its previous transaction` | `PREVOUT_MISMATCH` | The script or value given for input n differs from the output in that transaction |

The signers require previous transactions only when every input is P2MR and the sighash type does not include ANYONECANPAY. Previous transactions given for any other spend are checked as well. `trustPrevouts: true` skips the check for an application that has already verified the values, for example by reading them from its own node.

## Next steps

- [Sign a P2MR spend](p2mr-sign.md) signs a leaf on the transaction, through a PSBT or on a hardware device.
- [Spend any other P2MR leaf](p2mr-other-leaves.md) covers leaves that need a preimage, a code separator or an annex.
- [Control blocks and script trees](../reference/p2mr-control-blocks.md) lists the control block helpers and puts the same trees in P2TR outputs.
