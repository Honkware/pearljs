/**
 * A 2-of-3 multisig with a timelocked recovery leaf, in a P2MR output, signed
 * by two co-signers who pass a PSBT between them.
 *
 * Runs offline. The three co-signers are three accounts of one test
 * mnemonic so the example needs no other keys; in practice each is another
 * person's wallet and only the base64 PSBT travels.
 */
import {
  addInputByTxid,
  assembleScriptTree,
  checksigScript,
  createPsbt,
  createTransaction,
  csvScript,
  deriveSigningAccountFromSeed,
  encodeAddress,
  encodeSequence,
  finalizePsbt,
  inspectTransaction,
  mnemonicToSeed,
  multiAScript,
  networks,
  p2mr,
  parsePearl,
  parsePsbt,
  prepareP2mrScriptPathInput,
  scriptToAsm,
  toOutputScript,
} from 'pearljs';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const network = networks.regtest;
const seed = mnemonicToSeed(MNEMONIC);
const alice = deriveSigningAccountFromSeed(seed, network, 0);
const bob = deriveSigningAccountFromSeed(seed, network, 1);
const carol = deriveSigningAccountFromSeed(seed, network, 2);

// Everyone shares public keys; each uses child 0 of their account.
const keys = [alice, bob, carol].map((signer) => signer.derivePublicKey(0));
const tree = assembleScriptTree([
  multiAScript(keys, 2),
  // Carol alone, 1008 blocks after the output confirms.
  csvScript(encodeSequence({ blocks: 1008 }), checksigScript(keys[2]!)),
]);
const output = p2mr({ merkleRoot: tree.root }).output;
console.log('vault address', encodeAddress({ version: 2, program: tree.root }, network));
tree.leaves.forEach((leaf, i) => console.log(`leaf ${i}`, scriptToAsm(leaf.script)));

// A made-up transaction paying the vault 3 PRL.
const funding = createTransaction(2);
addInputByTxid(funding, 'cc'.repeat(32), 0);
funding.addOutput(output, parsePearl('3'));

// Alice builds the spend and prepares the input for the multisig leaf.
const unsigned = createTransaction(2);
addInputByTxid(unsigned, funding.getId(), 0);
unsigned.addOutput(toOutputScript(alice.deriveAddress(5), network), parsePearl('2.9999'));
const psbt = createPsbt(unsigned);
prepareP2mrScriptPathInput(psbt, 0, { tree, leafIndex: 0, value: parsePearl('3'), previousTransaction: funding });
const leafHash = tree.leaves[0]!.leafHash;
alice.signScriptPathInput(psbt, 0, { index: 0, leafHash });

// Carol receives the PSBT as text, checks it and adds her signature.
const received = parsePsbt(psbt.toBase64());
carol.signScriptPathInput(received, 0, { index: 0, leafHash });

// Two of three signed, so the PSBT finalizes. Bob's witness item stays empty.
const spend = finalizePsbt(received);
console.log('spend', spend.getId());
console.log('witness item sizes', spend.ins[0]!.witness.map((item) => item.length).join(' '));

const info = inspectTransaction(spend, [{ script: output, value: parsePearl('3') }], network);
const how = info.inputs[0]!.spend;
if (how.type === 'scriptPath') console.log('spent through a', how.leaf, 'leaf,', how.threshold, 'of', how.keys.length);

for (const signer of [alice, bob, carol]) signer.destroy();
