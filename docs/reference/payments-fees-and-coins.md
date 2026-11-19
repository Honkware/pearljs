# Fees and coin selection

## Fee units

Every fee rate in pearljs is a `bigint` in grain per 1000 vbytes, written grain/kvB in these guides. It is the unit pearld's relay fee and Oyster's RPC use. Wallet interfaces usually show grain per vbyte, which is a thousand times smaller.

```ts run
import { feeRateFromGrainPerVbyte, feeRateFromPearlPerKvB, feeRateToGrainPerVbyte, feeRateToPearlPerKvB } from 'pearljs';

console.log(feeRateFromGrainPerVbyte('1.5')); // 1500n: up to three decimals, or a bigint
console.log(feeRateToGrainPerVbyte(1500n)); // "1.5"
console.log(feeRateFromPearlPerKvB('0.00001')); // 1000n: the PRL/kvB that RPC replies show
console.log(feeRateToPearlPerKvB(1000n)); // "0.00001"
```

The type is `FeeRate`, an alias of `bigint`, and three names carry it:

| Name | Where | Meaning |
| --- | --- | --- |
| `feeRate` | `payFromAccount`, `buildPayment`, `sweepWif`, `selectCoins`, `feeForVsize`, `cpfpChildFee`, `OysterClient.sendToAddress` and `sendMany` | The rate to pay |
| `relayFeeRate` | `payFromAccount`, `buildPayment`, `finalizePayment`, `sweepWif`, `checkStandard`, `isDust`, `minRelayFee`, `checkReplacement`, `replacementFee`, `cpfpChildFee` | The node's `--minrelaytxfee`, when it is not the default `DEFAULT_RELAY_FEE_RATE` (1000n) |
| `maxFeeRate` | `signP2mrInput`, `signXmssP2mrInput`, `checkStandard`, `testMempoolAccept` | The highest rate to sign or accept |

`estimateFeeRate` on a backend, `estimateFee` on the pearld client and `packageFeeRate` return a rate in the same unit, and `OYSTER_DEFAULT_FEE_RATE` is one.

Fees themselves, as opposed to rates, are always grain: `payment.fee`, `InsufficientFundsError.fee`, `feeForVsize(vsize, feeRate)`.

A payment whose fee falls under pearld's relay minimum, 1000 grain/kvB, is refused when it is built, unless `relayFeeRate` says the node runs with a lower one.

`parsePearl` refuses an amount with leading zeros, since `"00000001"` is more likely a mangled `"0.00000001"` than one PRL. `feeRateFromGrainPerVbyte` refuses a rate with leading zeros in the same way.

## Fee ceiling

A forgotten change output turns the whole remainder into fee. Oyster's transaction rules have no upper bound, and pearld's `sendrawtransaction` ignores its fee limit. So pearljs holds a spend to a ceiling on the fee rate, `maxFeeRate`. It is `DEFAULT_MAX_FEE_RATE`, 5,000,000 grain/kvB, unless the call passes another. To pay more on purpose, pass a higher `maxFeeRate` with that call.

The default equals the 5000 grain per vbyte at which `finalizePsbt` refuses. It is half of the 0.1 PRL/kvB that pearld's `testmempoolaccept` allows by default.

These refuse a spend above the ceiling with `FEE_TOO_HIGH`:

- `signP2mrInput`, `signXmssP2mrInput` and their async variants refuse to sign ([The fee guard](../guides/p2mr-sign.md#fee-guard)).
- `PearlWallet.send`, `bumpFee` and `sweep` refuse before a key is used or anything is recorded. A refused XMSS spend therefore costs no index.
- `prepareSend`, `estimateSend` and `submitSigned` hold a wallet send to the same ceiling. `submitSigned` uses the ceiling the send was prepared under.

In the wallet the ceiling applies to the fee the transaction really pays, worked out from the spent values and the outputs, whatever its inputs. When the remainder after the fee is too small to be change, it joins the fee, and that counts.

Without `feeRate`, the wallet asks the backend for an estimate. It refuses an estimate that is not a positive rate (`BACKEND_RESPONSE`) or is above the ceiling, so a wrong estimate cannot set the fee.

`checkStandard` and `testMempoolAccept` also take a `maxFeeRate`, the highest rate they accept. `finalizePsbt` has its own fixed guard at 5000 grain per vbyte ([Build a transaction by hand](../guides/payments-by-hand.md#build-the-transaction)).

## Coin selection

Coin selection follows Oyster, so a pearljs wallet spends the way Pearl's own does. The rules:

- Coins are taken largest first until they cover the recipients and the fee.
- The fee is the fee rate times the signed size, rounded down, and it always pays for a change output, whether or not one is added.
- The size is Oyster's estimate for key-path inputs, which runs a fraction of a vbyte per input above the real size.
- Change that is zero, or under the dust limit at the default relay fee (333 grain for a P2TR or P2MR output), goes to the fee and no change output is made.

`strategy` chooses the order coins are offered in:

| `strategy` | Behaviour |
| --- | --- |
| `'largest'` (default) | Largest value first, Oyster's default |
| `'random'` | Oyster's other strategy: drops coins that cost more to spend than they hold at the fee rate, then shuffles the rest. `random` supplies the randomness as a function returning a number in [0, 1) |
| `'all'` | Spends every coin given, as Oyster does with outputs the user picked |
| a function | `(utxos, feeRate) => utxos` in the order to offer them, for a rule of your own |

## Differences from Oyster

Three things differ from Oyster on purpose:

- A P2MR input is priced at the real size of its leaf. Oyster prices every input as a key path and so pays too little for one.
- Change goes last. Oyster moves it to a random position.
- Sequence numbers signal replace-by-fee when `rbf: true` is given. Oyster never signals it.

`selectCoins`, `arrangeCoins` and `spendableUtxos` are the pure functions underneath, for callers that want the selection without the transaction.

## Confirmations and coinbase outputs

Outputs need `confirmations`, as `listunspent` reports them, or `confirmationsFromHeight(height, tipHeight)` computed from block heights. An output with no `confirmations` counts as unconfirmed. An output is left out below `minConfirmations`, which is 1 as in Oyster's sends. Pass `minConfirmations: 0` to spend unconfirmed outputs.

Coinbase outputs, marked `coinbase: true`, wait for the network's `coinbaseMaturity`. That is 100 confirmations on every Pearl network (`COINBASE_MATURITY`), and fewer on a `customNetwork` that says so. The `coinbaseMaturity` option overrides it, and `spendableUtxos` called without a network uses 100. Outputs of zero value are never spent.

## Insufficient funds

When what is left cannot pay, the builder throws `InsufficientFundsError`. It carries `missing`, `available`, `required` and `fee` in grain. Its message says how many outputs were held back as unconfirmed, immature or empty.
