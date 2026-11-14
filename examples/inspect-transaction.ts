/**
 * Read a signed transaction against the outputs it spends: fee, fee rate,
 * sizes, replace-by-fee signalling, addresses and how each input was spent.
 *
 * Runs offline. The transaction is built here so the example has something
 * to read; one fetched from a node is parsed with parseTransaction, and its
 * prevouts come from the transactions it spends.
 */
import {
  deriveSigningAccountFromSeed,
  feeRateToGrainPerVbyte,
  formatPearl,
  inspectTransaction,
  mnemonicToSeed,
  networks,
  parsePearl,
  parseTransaction,
  payFromAccount,
  toOutputScript,
} from 'pearljs';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const network = networks.testnet2;
const account = deriveSigningAccountFromSeed(mnemonicToSeed(MNEMONIC), network);

const payment = payFromAccount(account, {
  network,
  utxos: [
    {
      txid: '11'.repeat(32),
      vout: 0,
      value: parsePearl('1'),
      script: toOutputScript(account.deriveAddress(0), network),
      confirmations: 6,
      index: 0,
    },
  ],
  recipients: [{ address: account.deriveAddress(1), amount: parsePearl('0.25') }],
  feeRate: 1500n,
  changeAddress: account.deriveAddress(0, true),
  rbf: true,
});
account.destroy();

// From here on only the hex and the spent outputs are used.
const tx = parseTransaction(payment.hex);
const info = inspectTransaction(tx, payment.prevouts, network);

console.log('txid    ', info.txid);
console.log('wtxid   ', info.wtxid);
console.log('size    ', info.size, 'bytes,', info.weight, 'weight,', info.vsize, 'vbytes');
console.log('fee     ', formatPearl(info.fee), 'PRL,', feeRateToGrainPerVbyte(info.feeRate), 'grain per vbyte');
console.log('rbf     ', info.rbf);
for (const input of info.inputs) {
  console.log('input   ', `${input.txid.slice(0, 8)}:${input.vout}`, input.address, formatPearl(input.value), input.spend.type);
}
for (const output of info.outputs) {
  console.log('output  ', output.type, output.address, formatPearl(output.value));
}
