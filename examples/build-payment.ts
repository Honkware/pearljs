/**
 * Build and sign a payment from unspent outputs written out by hand, with
 * change, then send everything that is left with `amount: 'max'`.
 *
 * Runs offline: nothing is broadcast, and the outputs spent here do not exist
 * on any chain. With a node, the list comes from a wallet backend instead
 * (see send-payment.ts).
 */
import {
  deriveSigningAccountFromSeed,
  feeRateFromGrainPerVbyte,
  formatPearl,
  InsufficientFundsError,
  mnemonicToSeed,
  networks,
  parsePearl,
  payFromAccount,
  toOutputScript,
  type AccountUtxo,
} from 'pearljs';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const network = networks.regtest;
const account = deriveSigningAccountFromSeed(mnemonicToSeed(MNEMONIC), network);

// Each unspent output names the child key that holds it: `index`, and
// `change: true` for the change chain.
const utxos: AccountUtxo[] = [
  {
    txid: '6f1e3c0b5d1a4c0e9b7a2d4f8c6e0a1b3d5f7092a4c6e8f0b1d3f507192b4d6f',
    vout: 1,
    value: parsePearl('2'),
    script: toOutputScript(account.deriveAddress(3), network),
    confirmations: 12,
    index: 3,
  },
  {
    txid: '0b1d3f507192b4d6f6f1e3c0b5d1a4c0e9b7a2d4f8c6e0a1b3d5f7092a4c6e8f',
    vout: 0,
    value: parsePearl('0.75'),
    script: toOutputScript(account.deriveAddress(1, true), network),
    confirmations: 3,
    index: 1,
    change: true,
  },
];

const recipient = deriveSigningAccountFromSeed(mnemonicToSeed(MNEMONIC), network, 1).deriveAddress(0);
const feeRate = feeRateFromGrainPerVbyte('2'); // 2000n grain per 1000 vbytes

const payment = payFromAccount(account, {
  network,
  utxos,
  recipients: [{ address: recipient, amount: parsePearl('1.5') }],
  feeRate,
  changeAddress: account.deriveAddress(2, true),
});
console.log('txid  ', payment.txid);
console.log('inputs', payment.inputs.map((utxo) => `${utxo.txid.slice(0, 8)}:${utxo.vout}`).join(' '));
console.log('fee   ', formatPearl(payment.fee), 'PRL for', payment.vsize, 'vbytes');
console.log('change', formatPearl(payment.change), 'PRL at output', payment.changeIndex);
console.log('hex   ', payment.hex);

// Send-max spends every output and has no change.
const everything = payFromAccount(account, {
  network,
  utxos,
  recipients: [{ address: recipient, amount: 'max' }],
  feeRate,
});
console.log('max sends', formatPearl(everything.transaction.outs[0]!.value), 'PRL');

try {
  payFromAccount(account, {
    network,
    utxos,
    recipients: [{ address: recipient, amount: parsePearl('5') }],
    feeRate,
    changeAddress: account.deriveAddress(2, true),
  });
} catch (err) {
  if (!(err instanceof InsufficientFundsError)) throw err;
  console.log('short by', formatPearl(err.missing), 'PRL of', formatPearl(err.required));
}

account.destroy();
