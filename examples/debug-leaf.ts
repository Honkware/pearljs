/**
 * Step through a tapscript leaf one opcode at a time: a hash lock that also
 * needs a signature, first with the wrong preimage and then with the right
 * one, as Pearl's script engine would run it.
 *
 * Runs offline. The output being spent is made up here; on a chain it comes
 * from the transaction that paid the P2MR address.
 */
import {
  OP_CODES,
  assembleScriptTree,
  compileScript,
  createTransaction,
  debugInput,
  deriveSigningAccountFromSeed,
  executeScript,
  mnemonicToSeed,
  networks,
  p2mr,
  parsePearl,
  scriptToAsm,
  sha256,
  toOutputScript,
  verifyTransaction,
} from 'pearljs';
import type { ScriptResult, ScriptStep } from 'pearljs';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const network = networks.regtest;
const account = deriveSigningAccountFromSeed(mnemonicToSeed(MNEMONIC), network);

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const short = (bytes: Uint8Array): string => (bytes.length > 8 ? `${hex(bytes.subarray(0, 4))}..(${bytes.length})` : hex(bytes) || '""');

/** Prints every step of a run and returns its verdict. */
function trace(run: Generator<ScriptStep, ScriptResult, void>): ScriptResult {
  let step = run.next();
  while (!step.done) {
    const { scriptIndex, opcodeIndex, name, stack, executed } = step.value;
    const where = `${scriptIndex === 2 ? 'leaf  ' : 'output'} ${String(opcodeIndex).padStart(2)}`;
    console.log(`  ${where}  ${(executed ? name : `(${name})`).padEnd(16)} [${stack.map(short).join(' ')}]`);
    step = run.next();
  }
  return step.value;
}

function report(result: ScriptResult): void {
  if (result.ok) {
    console.log('  accepted');
  } else {
    const at = result.at === undefined ? '' : ` at opcode ${result.at.opcodeIndex}, ${result.at.name}`;
    console.log(`  refused: ${result.code}${at}: ${result.message}`);
  }
}

// The leaf: whoever knows the preimage and holds child 0 can spend.
const preimage = new TextEncoder().encode('open sesame');
const leaf = compileScript([
  OP_CODES.OP_SHA256,
  sha256(preimage),
  OP_CODES.OP_EQUALVERIFY,
  account.derivePublicKey(0),
  OP_CODES.OP_CHECKSIG,
]);
console.log('leaf', scriptToAsm(leaf));

// Before there is any transaction, try the hashing half of the leaf on its own.
console.log('\nthe hash check alone, with the right preimage');
report(trace(executeScript(leaf.subarray(0, 35), { stack: [Uint8Array.of(1), preimage] })));

// A P2MR output holding the leaf, and a transaction that spends it.
const tree = assembleScriptTree([leaf]);
const prevouts = [{ script: p2mr({ merkleRoot: tree.root }).output, value: parsePearl('1') }];
const spend = createTransaction(2);
spend.addInput(new Uint8Array(32).fill(0xaa), 0);
spend.addOutput(toOutputScript(account.deriveAddress(9), network), parsePearl('0.9999'));
account.signP2mrInput(spend, 0, { index: 0, prevouts, tree, leafIndex: 0, trustPrevouts: true });
const [signature, script, controlBlock] = spend.ins[0]!.witness;

console.log('\nthe spend with the wrong preimage');
spend.ins[0]!.witness = [signature!, new TextEncoder().encode('open barley'), script!, controlBlock!];
report(trace(debugInput(spend, 0, prevouts)));

console.log('\nthe spend with the right preimage');
spend.ins[0]!.witness = [signature!, preimage, script!, controlBlock!];
report(trace(debugInput(spend, 0, prevouts)));

console.log('\nwhole transaction', verifyTransaction(spend, prevouts));
