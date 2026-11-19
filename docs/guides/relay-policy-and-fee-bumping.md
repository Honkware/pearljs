# Relay policy and fee bumping

A pearld node accepts a transaction into its mempool, and relays it to other nodes, only if it follows the node's relay policy. That policy is stricter than consensus: a transaction can be valid in a block and still be refused for a fee that is too small, a dust output or an unsupported version. pearljs checks a transaction against pearld's rules before you broadcast it, estimates the size and fee of a transaction before it is signed, and raises the fee of a transaction that is slow to confirm.

## Check a transaction before sending it

`checkStandard` applies pearld's relay rules and throws with pearld's own reason when the node would refuse the transaction. The payment builder already calls it on everything it returns, so use it for transactions you build another way, such as [by hand](payments-by-hand.md):

```ts run
import {
  addInputByTxid,
  createPsbt,
  createTransaction,
  checkStandard,
  deriveSigningAccountFromSeed,
  finalizePsbt,
  mnemonicToSeed,
  networks,
  toOutputScript,
} from 'pearljs';

const network = networks.regtest;
const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const account = deriveSigningAccountFromSeed(mnemonicToSeed(phrase), network);
const prevouts = [{ script: toOutputScript(account.deriveAddress(0), network), value: 100_000n }];

function signedSpend(outputValue: bigint) {
  const unsigned = createTransaction(2);
  addInputByTxid(unsigned, '11'.repeat(32), 0);
  unsigned.addOutput(toOutputScript(account.deriveAddress(1), network), outputValue);
  const psbt = createPsbt(unsigned);
  account.prepareInput(psbt, 0, { index: 0, value: 100_000n });
  account.signInput(psbt, 0, { index: 0 });
  return finalizePsbt(psbt);
}

checkStandard(signedSpend(99_800n), { prevouts }); // passes: 200 grain for 111 vbytes

for (const value of [99_950n, 200n]) {
  try {
    checkStandard(signedSpend(value), { prevouts });
  } catch (err) {
    console.log((err as Error).message); // a fee under the relay fee, then a dust output
  }
}
```

`prevouts` gives the script and value of each output the transaction spends, which the fee checks need, and `height` and `medianTimePast` turn on the finality check. `checkStandard` does not check signatures, sequence locks or coinbase maturity, and it does not look the inputs up. [Standardness checks](../reference/relay-policy-rules.md#standardness-checks) lists the checks in pearld's order and the options that change them, and [Dust and the relay fee](../reference/relay-policy-rules.md#dust-and-the-relay-fee) covers the two value limits.

## Estimate size and fee

The fee depends on the signed size of a transaction, which is not known until it is signed. `estimateVsize` works it out in advance from a description of how each input will be spent: it fills each input with a witness of the right size and measures the result. Pass the result to `feeForVsize` for the fee at a given rate:

```ts run
import {
  addInputByTxid,
  assembleScriptTree,
  checksigScript,
  createTransaction,
  estimateVsize,
  feeForVsize,
  multiAScript,
  p2tr,
  xmssLeafScript,
  type SpendEstimate,
} from 'pearljs';

const key = (n: number) => new Uint8Array(32).fill(n);
const unsigned = createTransaction(2);
addInputByTxid(unsigned, '11'.repeat(32), 0);
unsigned.addOutput(p2tr({ internalPubkey: key(9) }).output, 50_000n);

const xmssTree = assembleScriptTree([xmssLeafScript(new Uint8Array(64))]);
const multisigTree = assembleScriptTree([multiAScript([key(2), key(3), key(4)], 2)]);
const checksigTree = assembleScriptTree([checksigScript(key(2))]);

const ways: Record<string, SpendEstimate> = {
  'key path': { type: 'keyPath' },
  'P2MR checksig leaf': { type: 'scriptPath', tree: checksigTree, leafIndex: 0, p2mr: true },
  'P2MR 2-of-3 leaf': { type: 'scriptPath', tree: multisigTree, leafIndex: 0, p2mr: true },
  'P2MR XMSS leaf': { type: 'scriptPath', tree: xmssTree, leafIndex: 0, p2mr: true },
};
for (const [name, spend] of Object.entries(ways)) {
  const vsize = estimateVsize(unsigned, [spend]);
  console.log(name, vsize, 'vbytes,', feeForVsize(vsize, 1000n), 'grain at 1000 grain/kvB');
}
```

The estimate is exact for key paths, checksig leaves, multi_a leaves signed by exactly the threshold number of keys, and XMSS leaves. That holds because a Schnorr signature is always 64 bytes, or 65 with a sighash type other than SIGHASH_DEFAULT. XMSS spends are large: this one-input, one-output spend is 701 vbytes through an XMSS leaf and 121 through a checksig leaf.

Other leaves, and inputs whose witness ends with an annex, need more detail ([Size estimates](../reference/relay-policy-rules.md#size-estimates)).

## Replace-by-fee

Replace-by-fee lets you send a new version of an unconfirmed transaction, spending the same coins at a higher fee, so that it confirms sooner. pearld keeps btcd's opt-in form of it rather than Bitcoin Core's full replace-by-fee, so only a transaction that signals it can be replaced. A transaction signals in one of two ways:

- One of its inputs has a sequence number at or below 0xfffffffd (`MAX_RBF_SEQUENCE`).
- It spends an unconfirmed transaction that is itself replaceable. Bitcoin Core never implemented this rule.

To make a payment replaceable, build it with `rbf: true`. Oyster's transactions use the final sequence number, so they can never be replaced, and a node started with `--rejectreplacement` refuses every replacement.

pearld accepts a replacement only if it pays more, in rate and in total, than everything it evicts, and meets the other rules in [Replacement rules](../reference/relay-policy-rules.md#replacement-rules).

The functions below check these rules against a mempool you give them, as a map from txid to `{ tx, fee }` in the order the node accepted the transactions. Build the map from the node's `getRawMempoolVerbose` and `getRawTransactionHex`, or from your own record of what you sent.

First check that the stuck transaction can be replaced, then build the same payment at a higher rate:

```ts run
import {
  checkPackageLimits,
  checkReplacement,
  deriveSigningAccountFromSeed,
  mnemonicToSeed,
  networks,
  parsePearl,
  payFromAccount,
  replacementFee,
  signalsReplacement,
  toOutputScript,
  type AccountPaymentOptions,
  type MempoolTx,
} from 'pearljs';

const network = networks.regtest;
const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const account = deriveSigningAccountFromSeed(mnemonicToSeed(phrase), network);

const options: AccountPaymentOptions = {
  network,
  utxos: [{ txid: '11'.repeat(32), vout: 0, value: parsePearl('1'), script: toOutputScript(account.deriveAddress(0), network), confirmations: 6, index: 0 }],
  recipients: [{ address: account.deriveAddress(1), amount: parsePearl('0.25') }],
  feeRate: 1000n, // grain/kvB
  changeAddress: account.deriveAddress(0, true),
  rbf: true,
};

// The transaction that is stuck, as the node's mempool holds it.
const original = payFromAccount(account, options);
const pool = new Map<string, MempoolTx>([[original.txid, { tx: original.transaction, fee: original.fee }]]);
if (!signalsReplacement(original.transaction, pool)) throw new Error('only a child can speed this up');

// The same payment at a higher rate. Same inputs, so it conflicts with the original.
const replacement = payFromAccount(account, { ...options, feeRate: 3000n });
```

`signalsReplacement(tx, mempool?)` checks the second way of signalling only when it is given the mempool. The replacement spends the same coins as the original, which is what makes the two conflict.

The builder takes a fee rate rather than a fee, so choose a rate, build, and compare the result with `replacementFee(evicted, vsize)`, the smallest fee that meets both fee rules. Then run `checkReplacement(tx, fee, mempool)`, which applies pearld's replacement checks and returns the txids it would evict, or throws pearld's message:

```ts continues
const needed = replacementFee([{ fee: original.fee, vsize: original.vsize }], replacement.vsize);
console.log('pays', replacement.fee, 'grain, needs at least', needed);

const evicted = checkReplacement(replacement.transaction, replacement.fee, pool);
checkPackageLimits(replacement.transaction, pool, { replaced: evicted });
console.log('replaces', evicted.length, 'transaction');
```

Between its two replacement checks pearld also runs its standardness and relay fee checks, which are the `checkStandard` checks the builder has already run.

A transaction that did not signal replace-by-fee can still be sped up by a child that pays for both ([Child pays for parent](../reference/relay-policy-rules.md#child-pays-for-parent)), and chains of unconfirmed transactions have their own limits ([Package limits](../reference/relay-policy-rules.md#package-limits)).
