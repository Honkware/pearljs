/**
 * Build a P2MR script tree, derive its address, and spend the output through
 * one of its leaves, first on the transaction and then through payFromAccount.
 *
 * Runs offline. The funding transaction is made up here; on a chain it is
 * the transaction that paid the P2MR address, fetched with
 * getRawTransactionHex and parseTransaction.
 */
import {
  addInputByTxid,
  assembleScriptTree,
  checksigScript,
  checkStandard,
  createTransaction,
  deriveSigningAccountFromSeed,
  p2mrAddress,
  formatPearl,
  mnemonicToSeed,
  networks,
  p2mr,
  parsePearl,
  payFromAccount,
  scriptToAsm,
  toOutputScript,
} from 'pearljs';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const network = networks.regtest;
const account = deriveSigningAccountFromSeed(mnemonicToSeed(MNEMONIC), network);

// Three single-key leaves, held by the account's children 0, 1 and 2.
const tree = assembleScriptTree([0, 1, 2].map((index) => checksigScript(account.derivePublicKey(index))));
const output = p2mr({ merkleRoot: tree.root }).output;
const address = p2mrAddress({ merkleRoot: tree.root }, network);
console.log('P2MR address', address);
tree.leaves.forEach((leaf, i) => console.log(`leaf ${i}`, scriptToAsm(leaf.script)));

// A transaction that pays the address 5 PRL.
const funding = createTransaction(2);
addInputByTxid(funding, 'aa'.repeat(32), 0);
funding.addOutput(output, parsePearl('5'));

// Spend it through leaf 1, signing on the transaction.
const destination = account.deriveAddress(9);
const spend = createTransaction(2);
addInputByTxid(spend, funding.getId(), 0);
spend.addOutput(toOutputScript(destination, network), parsePearl('4.9999'));
const prevouts = [{ script: output, value: parsePearl('5') }];
account.signP2mrInput(spend, 0, {
  index: 1, // the child whose key leaf 1 pushes
  prevouts,
  tree,
  leafIndex: 1,
  previousTransactions: [funding],
});
checkStandard(spend, { prevouts });
console.log('signed on the transaction', spend.getId(), spend.virtualSize(), 'vbytes');

// The same spend through the payment builder, which works out the fee.
const payment = payFromAccount(account, {
  network,
  utxos: [
    {
      txid: funding.getId(),
      vout: 0,
      value: parsePearl('5'),
      script: output,
      confirmations: 1,
      index: 1,
      p2mr: { tree, leafIndex: 1 },
    },
  ],
  recipients: [{ address: destination, amount: 'max' }],
  feeRate: 1000n,
  previousTransactions: [funding],
});
console.log('through payFromAccount', payment.txid, 'fee', formatPearl(payment.fee), 'PRL');

account.destroy();
