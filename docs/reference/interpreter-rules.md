# Script interpreter rules

## Rules

The interpreter does what Pearl's engine does, including where that differs from BIP 341 and BIP 342:

- There are no script flags. Every rule below is consensus.
- Reserved and unknown opcodes fail when executed. Pearl removed the OP_SUCCESS rule, under which they would make a leaf succeed. In a branch that does not execute they are passed over.
- `OP_SUBSTR`, `OP_LEFT`, `OP_RIGHT`, `OP_INVERT`, `OP_AND`, `OP_OR`, `OP_XOR`, `OP_2MUL`, `OP_2DIV`, `OP_MUL`, `OP_DIV`, `OP_MOD`, `OP_LSHIFT` and `OP_RSHIFT` fail wherever they appear, executed or not. `OP_VERIF` and `OP_VERNOTIF` do too.
- `OP_NOP1` and `OP_NOP4` to `OP_NOP10` fail when executed. `OP_CHECKMULTISIG` and `OP_CHECKMULTISIGVERIFY` fail when executed.
- `OP_CAT` is enabled in leaves, limited to 520 bytes, and costs one unit of the signature operation budget per 64 bytes of its result.
- `OP_CHECKXMSSSIG` takes a 64-byte key and five 468-byte signature chunks, costs 1000 units of the budget, and pushes true or fails. It has no empty-signature case and always signs the `SIGHASH_DEFAULT` message.
- The budget is 50 plus the serialized size of the witness. Each check of a non-empty Schnorr signature costs 50.
- A public key that is not 32 bytes fails the leaf, as does one that is not a point on the curve, where BIP 342 leaves unknown key types valid.
- Leaf versions other than 0xc0 fail. Witness versions other than 1 and 2 fail, as does a program that is not 32 bytes.
- Minimal pushes, minimal numbers and minimal `OP_IF` arguments are required everywhere.
- An annex, a last witness item starting with 0x50 when there are at least two items, is removed and committed to by signatures, for P2TR and P2MR alike.
- `OP_CODESEPARATOR` is allowed, and every later signature of the leaf, XMSS included, commits to the opcode position of the last one executed.
- The signature message is the one Pearl's `NewTxSigHashes` and `calcTaprootSignatureHashRaw` compute.

An output script that is not a witness program is run as the engine runs it, under the rules for scripts outside a leaf, where signature opcodes fail. Such outputs cannot exist on chain.

The interpreter computes a transaction's sighash midstate once, as pearld's `TxSigHashes` does.

## Error codes

`SCRIPT_ERROR_CODES` lists every code. These are the ones a spend usually meets:

| Code | Meaning |
| --- | --- |
| `ErrTaprootSigInvalid` | A key path signature does not verify. The message is empty. |
| `ErrNullFail` | A signature in a leaf is not empty and does not verify, or an XMSS signature is invalid. |
| `ErrInvalidTaprootSigLen` | A Schnorr signature is not 64 bytes, or 65 with a non-zero sighash byte. |
| `ErrTaprootMerkleProofInvalid`, `ErrMerkleRootMerkleProofInvalid` | The leaf and control block do not open the P2TR or P2MR output. |
| `ErrMerkleRootNoKeyPathSpend` | A P2MR input has a single witness item. P2MR has no key path. |
| `ErrCleanStack` | The leaf left more or fewer than one item. |
| `ErrEvalFalse` | The leaf left one item and it is false. |
| `ErrUnsatisfiedLockTime` | `OP_CHECKLOCKTIMEVERIFY` or `OP_CHECKSEQUENCEVERIFY` is not satisfied by the transaction. |
| `ErrTaprootMaxSigOps` | The leaf used more signature operations than its witness pays for. |
| `ErrReservedOpcode`, `ErrDisabledOpcode` | The leaf ran an opcode Pearl does not execute. |
| `ErrMinimalData`, `ErrMinimalIf` | A push or number is not minimally encoded, or `OP_IF` got something other than empty or `01`. |

Four codes are not txscript's. When a public key or a Schnorr signature does not parse, the engine returns the signature library's error unchanged. The interpreter reports that library's name for it:

- `ErrPubKeyXTooBig`
- `ErrPubKeyNotOnCurve`
- `ErrSigRTooBig`
- `ErrSigSTooBig`

## Failures

A failure carries the name of the engine's `ErrorCode` and the engine's message, the same ones pearld logs and a Go test sees. This leaf needs the two numbers under it to add up to 6, and the witness gives it 2 and 3:

```ts run
import { OP_CODES, assembleScriptTree, compileScript, createTransaction, p2mr, p2mrControlBlock, verifyInput } from 'pearljs';

// A leaf that needs 2 and 3 on the stack to add up to 6.
const leaf = compileScript([OP_CODES.OP_ADD, OP_CODES.OP_6, OP_CODES.OP_EQUALVERIFY, OP_CODES.OP_1]);
const tree = assembleScriptTree([leaf]);
const prevouts = [{ script: p2mr({ merkleRoot: tree.root }).output, value: 1000n }];

const tx = createTransaction(2);
tx.addInput(new Uint8Array(32).fill(1), 0);
tx.ins[0]!.witness = [Uint8Array.of(2), Uint8Array.of(3), leaf, p2mrControlBlock(tree, 0)];

console.log(verifyInput(tx, 0, prevouts));
// {
//   ok: false,
//   code: 'ErrEqualVerify',
//   message: 'OP_EQUALVERIFY failed',
//   at: { scriptIndex: 2, opcodeIndex: 2, offset: 2, opcode: 136, name: 'OP_EQUALVERIFY' }
// }
```

`at` names the opcode that failed. `scriptIndex` is 1 for the output script and 2 for the leaf, as the engine numbers them. A failure that no single opcode caused, such as a control block that does not open the output, has no `at`. [Error codes](#error-codes) lists the codes a spend usually meets.

## Steps

`executeScript` yields one step per opcode. Each step has these fields:

| Field | Value |
| --- | --- |
| `opcode`, `name`, `data` | The opcode, with `data` for a push |
| `scriptIndex`, `opcodeIndex`, `offset` | Where it sits |
| `executed` | False for an opcode in a branch that is not taken |
| `stack`, `altStack` | The stacks after it, top last |
| `sigOpsBudget` | The signature operation budget |

An opcode that fails gets no step of its own, and the failure the generator returns names it in `at`. To collect the whole trace, loop with `for (const step of executeScript(leaf, { stack }))`. A `for` loop never sees the returned verdict, though, so call `next()` yourself as above when you need both.

## Leaves that read the transaction

Signature and timelock opcodes read the spending transaction, so pass it as `tx`, together with `prevouts` when the leaf sits in a real output. Without them the leaf runs against a stand-in: a version 2 transaction with lock time 0 and no outputs, whose one input has sequence 0 and spends a P2MR output with the script as its only leaf.

This leaf lets child 0 spend from block 500. The example signs the same spend with lock times 499 and 500 and runs the leaf on each:

```ts run
import {
  OP_CODES,
  assembleScriptTree,
  checksigScript,
  cltvScript,
  createTransaction,
  deriveSigningAccountFromSeed,
  executeScript,
  mnemonicToSeed,
  networks,
  p2mr,
  type ScriptResult,
  type ScriptStep,
} from 'pearljs';

const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const account = deriveSigningAccountFromSeed(mnemonicToSeed(phrase), networks.regtest);

// Spendable by child 0 from block 500.
const leaf = cltvScript(500, checksigScript(account.derivePublicKey(0)));
const tree = assembleScriptTree([leaf]);
const prevouts = [{ script: p2mr({ merkleRoot: tree.root }).output, value: 100_000n }];

function verdict(run: Generator<ScriptStep, ScriptResult, void>): ScriptResult {
  let step = run.next();
  while (!step.done) step = run.next();
  return step.value;
}

for (const locktime of [499, 500]) {
  const tx = createTransaction(2);
  tx.addInput(new Uint8Array(32).fill(1), 0, 0xfffffffe);
  tx.addOutput(Uint8Array.of(OP_CODES.OP_1), 99_000n);
  tx.locktime = locktime;
  // The funding transaction is made up, so there is nothing to check the prevouts against.
  account.signP2mrInput(tx, 0, { index: 0, prevouts, tree, leafIndex: 0, trustPrevouts: true });
  const [signature] = tx.ins[0]!.witness;
  const result = verdict(executeScript(leaf, { stack: [signature!], tx, prevouts }));
  console.log(locktime, result.ok ? 'ok' : `${result.code}: ${result.message}`);
}
// 499 ErrUnsatisfiedLockTime: locktime requirement not satisfied -- locktime is greater than the transaction locktime: 500 > 499
// 500 ok
```

`executeScript` gives the leaf the signature operation budget of a single-leaf P2MR spend with that stack. To step through an input exactly as pearld would run it, with its real witness, control block and budget, use `debugInput(tx, index, prevouts)`. It yields the two opcodes of the output script first. The engine checks the witness as part of the step that ends the output script, so that step already shows the stack the leaf starts with, or the single true value a key path leaves.
