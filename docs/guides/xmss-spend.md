# Spend from an XMSS key

Spending from an XMSS key means making the key, locking an output to it in a P2MR leaf and signing a transaction that spends the output. Each XMSS signature uses up a one-time index, and signing twice at one index exposes the key, so read [Index state](../concepts/xmss.md#index-state) before you hold real funds with one.

## Make a key

An XMSS key is two random seeds, and `generateXmssSeeds` makes them. There is no recovery phrase for an XMSS key, so keep both seeds as its backup. `createXmssSigner` builds the key from the seeds and takes the store that will hand out its indices:

```ts run
import {
  addInputByTxid,
  assembleScriptTree,
  checkStandard,
  createMemoryXmssIndexStore,
  createTransaction,
  createXmssSigner,
  generateXmssSeeds,
  p2mrAddress,
  networks,
  p2mr,
  parsePearl,
  signXmssP2mrInput,
  toOutputScript,
  xmssLeafScript,
} from 'pearljs';

const network = networks.regtest;
const { privateSeed, publicSeed } = generateXmssSeeds();
const signer = createXmssSigner(privateSeed, publicSeed, createMemoryXmssIndexStore());
```

The memory store keeps its record of used indices only for the life of the process, which is fine for this example. For a key that holds funds, use the file store or one of your own from [Keep XMSS index state](xmss-store.md).

## Lock an output to it

The key's leaf script is `<public key> OP_CHECKXMSSSIG`. Put it in a script tree, and the tree's root gives the P2MR output and its address:

```ts continues
const tree = assembleScriptTree([xmssLeafScript(signer.publicKey)]);
const output = p2mr({ merkleRoot: tree.root }).output;
console.log('address', p2mrAddress({ merkleRoot: tree.root }, network));
```

The tree here has a single leaf. It can hold other leaves beside the XMSS one, and the spend below names the leaf it uses by its position, `leafIndex`. [P2MR](p2mr.md) covers trees with several leaves.

## Sign the spend

To spend the output, build a transaction with an input that points at it, then sign that input with `signXmssP2mrInput`. The funding transaction below is made up, so the example runs without a chain:

```ts continues
// A made-up transaction paying that address 10 PRL.
const funding = createTransaction(2);
addInputByTxid(funding, 'bb'.repeat(32), 0);
funding.addOutput(output, parsePearl('10'));

const tx = createTransaction(2);
addInputByTxid(tx, funding.getId(), 0);
tx.addOutput(toOutputScript('rprl1p8dhv8twyj9ezfvk62vvsfgw39s4dgl9t42y0549dc4d2947jj4cs30wfpz', network), parsePearl('9.9999'));

const prevouts = [{ script: output, value: parsePearl('10') }];
await signXmssP2mrInput(tx, 0, signer, { prevouts, tree, leafIndex: 0, previousTransactions: [funding] });
checkStandard(tx, { prevouts });
console.log(tx.getId(), tx.virtualSize(), 'vbytes'); // 701 vbytes
```

`prevouts` lists the script and value of each output the transaction spends, and `previousTransactions` holds the transactions that created them. `signXmssP2mrInput` checks the spent output, the previous transactions and the fee in the same way `signP2mrInput` does ([P2MR](p2mr.md)). It then reserves an index from the store, signs, and sets the input's witness: the 2340-byte signature split into five items of 468 bytes, then the leaf script and the control block.

`checkStandard` holds the transaction to pearld's relay rules before it is broadcast ([Relay policy and fee bumping](relay-policy-and-fee-bumping.md)). The fee here is whatever the input holds beyond the output, 0.0001 PRL.

## Wipe the key

Once the signing is done, clear the key from memory:

```ts continues
signer.destroy();
privateSeed.fill(0);
```

`signer.destroy()` overwrites the signer's copy of the secret key, and after it `sign` rejects with `this XMSS signer has been destroyed`. The seeds you passed in belong to you, so wipe those yourself. As with every key in JavaScript, this shortens the time the key sits in memory without removing every copy ([Security model](../concepts/security.md)).

## Let the builder work out the fee

The spend above set the output amount by hand. `buildPayment` chooses the fee from a rate instead, as long as each XMSS coin carries a `spend` that names its tree and leaf so the builder can price the signature. Sign each input of the transaction it returns with `signXmssP2mrInput`, then pass the signed copy to `finalizePayment`:

```ts run
import {
  addInputByTxid,
  assembleScriptTree,
  buildPayment,
  createMemoryXmssIndexStore,
  createTransaction,
  createXmssSigner,
  finalizePayment,
  formatPearl,
  networks,
  p2mr,
  parsePearl,
  signXmssP2mrInput,
  xmssLeafScript,
} from 'pearljs';

const network = networks.regtest;
const signer = createXmssSigner(new Uint8Array(64).fill(1), new Uint8Array(32).fill(2), createMemoryXmssIndexStore());
const tree = assembleScriptTree([xmssLeafScript(signer.publicKey)]);
const output = p2mr({ merkleRoot: tree.root }).output;

const funding = createTransaction(2); // made up, as above
addInputByTxid(funding, 'bb'.repeat(32), 0);
funding.addOutput(output, parsePearl('10'));

const payment = buildPayment({
  network,
  utxos: [
    {
      txid: funding.getId(),
      vout: 0,
      value: parsePearl('10'),
      script: output,
      confirmations: 1,
      spend: { type: 'scriptPath', tree, leafIndex: 0, p2mr: true },
    },
  ],
  recipients: [{ address: 'rprl1p8dhv8twyj9ezfvk62vvsfgw39s4dgl9t42y0549dc4d2947jj4cs30wfpz', amount: 'max' }],
  feeRate: 2000n, // grain/kvB
});

const signed = payment.transaction.clone();
for (let i = 0; i < payment.inputs.length; i += 1) {
  await signXmssP2mrInput(signed, i, signer, { prevouts: payment.prevouts, tree, leafIndex: 0, previousTransactions: [funding] });
}
const result = finalizePayment(payment, { signed });
console.log(result.vsize, 'vbytes, fee', formatPearl(result.fee), 'PRL');
```

XMSS spends are signed on the transaction rather than in a PSBT, because Pearl defines no PSBT field for XMSS signatures. [Build a payment for another signer](payments.md) explains `buildPayment` and `finalizePayment` in full.

## Sign with the primitives

Below the signer sit three primitives, `xmssKeygen`, `xmssSign` and `xmssVerify`. `xmssSign(secretKey, index, message)` takes the index from you and rebuilds the tree on every call. It refuses a secret key whose root does not belong to its seeds, and it verifies the signature before returning it. Use it only if you keep track of indices yourself, since `createXmssSigner` does that for you through its store.

`xmssScriptPathWitness(signature, script, controlBlock, annex)` lays out the witness for a signature made this way: the five 468-byte chunks, the leaf script and the control block.
