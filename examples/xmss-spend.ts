/**
 * Make an XMSS key, lock an output to it in a P2MR leaf, and spend it.
 *
 * Runs offline with the in-memory index store, which forgets which indices
 * it handed out when the process ends. That is safe here only because the
 * key is thrown away too. A key that lives longer needs a durable store such
 * as createFileXmssIndexStore from pearljs/xmss-file-store.
 */
import {
  addInputByTxid,
  assembleScriptTree,
  checkStandard,
  createMemoryXmssIndexStore,
  createTransaction,
  createXmssSigner,
  deriveAccountFromSeed,
  generateXmssSeeds,
  p2mrAddress,
  mnemonicToSeed,
  networks,
  p2mr,
  parsePearl,
  signXmssP2mrInput,
  toOutputScript,
  xmssLeafScript,
  XMSS_MAX_SIGNATURES,
} from 'pearljs';

const network = networks.regtest;
const destination = deriveAccountFromSeed(
  mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'),
  network,
).deriveAddress(0);

// XMSS keys come from two random seeds, not from a mnemonic. Both must be
// kept to sign again.
const { privateSeed, publicSeed } = generateXmssSeeds();
const signer = createXmssSigner(privateSeed, publicSeed, createMemoryXmssIndexStore());

const tree = assembleScriptTree([xmssLeafScript(signer.publicKey)]);
const output = p2mr({ merkleRoot: tree.root }).output;
console.log('XMSS P2MR address', p2mrAddress({ merkleRoot: tree.root }, network));
console.log('signatures this key can make', XMSS_MAX_SIGNATURES);

// A made-up transaction paying the address 10 PRL.
const funding = createTransaction(2);
addInputByTxid(funding, 'bb'.repeat(32), 0);
funding.addOutput(output, parsePearl('10'));

const spend = createTransaction(2);
addInputByTxid(spend, funding.getId(), 0);
// An XMSS spend is about 700 vbytes, so leave a fee that covers it.
spend.addOutput(toOutputScript(destination, network), parsePearl('9.9999'));

const prevouts = [{ script: output, value: parsePearl('10') }];
await signXmssP2mrInput(spend, 0, signer, { prevouts, tree, leafIndex: 0, previousTransactions: [funding] });
checkStandard(spend, { prevouts });
console.log('spend', spend.getId(), spend.virtualSize(), 'vbytes');
console.log('witness items', spend.ins[0]!.witness.map((item) => item.length).join(' '));

signer.destroy();
privateSeed.fill(0);
