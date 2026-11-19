# Check a spend with the script interpreter

pearljs carries its own copy of Pearl's script engine, so a program can check that a transaction's inputs would pass pearld's script validation before broadcasting it, step through a leaf one opcode at a time, or test a contract without a node.

The interpreter is a port of Pearl's engine, `node/txscript`, which runs entirely in your process and reports failures in that engine's own terms. It covers everything Pearl executes: P2TR key paths and script paths, and P2MR script paths. Pearl's consensus allows no outputs other than P2TR, P2MR and OP_RETURN, so neither engine has legacy or SegWit v0 execution. [Script interpreter rules](../reference/interpreter-rules.md) lists the rules it follows and its error codes.

## Check a transaction before broadcasting

`verifyTransaction` takes the signed transaction and the output each input spends, in input order. A payment from the builder carries both:

```ts run
import {
  deriveSigningAccountFromSeed,
  feeRateFromGrainPerVbyte,
  mnemonicToSeed,
  networks,
  parsePearl,
  payFromAccount,
  toOutputScript,
  verifyTransaction,
} from 'pearljs';

const network = networks.regtest;
const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const account = deriveSigningAccountFromSeed(mnemonicToSeed(phrase), network);

const payment = payFromAccount(account, {
  network,
  utxos: [
    {
      txid: '6f1e3c0b5d1a4c0e9b7a2d4f8c6e0a1b3d5f7092a4c6e8f0b1d3f507192b4d6f',
      vout: 1,
      value: parsePearl('2'),
      script: toOutputScript(account.deriveAddress(0), network),
      confirmations: 6,
      index: 0,
    },
  ],
  recipients: [{ address: account.deriveAddress(8), amount: parsePearl('1.5') }],
  feeRate: feeRateFromGrainPerVbyte('2'),
  changeAddress: account.deriveAddress(2, true),
});

console.log(verifyTransaction(payment.transaction, payment.prevouts)); // { ok: true }

// The same transaction against an output worth one grain more: the signature
// committed to the amount, so the engine refuses it.
const wrong = [{ script: payment.prevouts[0]!.script, value: payment.prevouts[0]!.value + 1n }];
console.log(verifyTransaction(payment.transaction, wrong));
// { ok: false, code: 'ErrTaprootSigInvalid', message: '', inputIndex: 0 }
```

`verifyInput(tx, index, prevouts)` checks a single input. Both functions return `{ ok: true }` or a failure, and they throw only for bad arguments: a `prevouts` list without one entry per input, or a value that is not a bigint of grain within Pearl's bounds. Where an exception suits the calling code better, `assertAccepted(result)` turns a failure into a `ScriptRejectedError`, with the engine's code in `scriptCode` ([Errors](../reference/errors.md)).

For a PSBT, `verifyFinalizedPsbt(psbt)` extracts the transaction, takes the spent outputs from the PSBT and runs the same check, which makes it the self-check to run between `finalizePsbt` and broadcasting.

The interpreter checks scripts only. A transaction can pass it and still be refused for something else:

- inputs that do not cover the outputs;
- a lock time that has not passed yet;
- a relative lock that has not matured on chain;
- a relay rule of pearld's.

`checkSanity` and `checkStandard` cover the rules that need no chain ([Relay policy and fee bumping](relay-policy-and-fee-bumping.md)), and the rest needs a node.

A failure carries the name of the engine's `ErrorCode` and the engine's message, the same ones pearld logs and a Go test sees, and `at` names the opcode that failed ([Failures](../reference/interpreter-rules.md#failures)).

## Debug a leaf step by step

`executeScript` runs one leaf under tapscript rules from a stack you give it, with no output, control block or transaction needed. It is a generator: each step it yields is the state after one opcode, and the value it returns at the end is the verdict.

```ts run
import { OP_CODES, compileScript, executeScript, scriptToAsm, sha256 } from 'pearljs';

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

// Spendable by whoever knows two strings whose concatenation hashes to this.
const digest = sha256(new TextEncoder().encode('pearl'));
const leaf = compileScript([OP_CODES.OP_CAT, OP_CODES.OP_SHA256, digest, OP_CODES.OP_EQUAL]);
console.log(scriptToAsm(leaf));

const stack = ['pe', 'arl'].map((text) => new TextEncoder().encode(text));
const run = executeScript(leaf, { stack });
let step = run.next();
while (!step.done) {
  const { name, stack: after, sigOpsBudget } = step.value;
  console.log(name.padEnd(12), `[${after.map(hex).join(' ')}]`, `budget ${sigOpsBudget}`);
  step = run.next();
}
console.log(step.value); // { ok: true }
```

[Steps](../reference/interpreter-rules.md#steps) lists each step's fields, and [Leaves that read the transaction](../reference/interpreter-rules.md#leaves-that-read-the-transaction) runs a leaf that checks signatures or lock times and steps through an input as pearld would run it with `debugInput`.

## Next steps

- [Script interpreter rules](../reference/interpreter-rules.md)
- [Spend any other P2MR leaf](p2mr-other-leaves.md)
- [Collect signatures from co-signers](psbt-co-signers.md)
