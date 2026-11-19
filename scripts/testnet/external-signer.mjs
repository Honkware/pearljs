// A signer in its own process, standing in for a device or an offline
// machine: it reads one request as JSON on stdin, { network, psbt,
// recipients: [{ address, amount }], maxFee, nextChangeIndex }, checks the
// PSBT pays what the request says and that every other output is its own
// change, signs every input with account 0 of the phrase in the secrets file
// named by PEARL_SIGNER_SECRETS, and writes the signed transaction's hex.
import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { checkPsbtPayment, deriveSigningAccountFromSeed, finalizePsbt, mnemonicToSeed, networks, parsePsbt, serializeTransaction } from 'pearljs';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const network = networks[request.network];
const { mnemonic } = JSON.parse(readFileSync(process.env.PEARL_SIGNER_SECRETS ?? '', 'utf8'));
const account = deriveSigningAccountFromSeed(mnemonicToSeed(mnemonic), network);
const psbt = parsePsbt(request.psbt);
const summary = checkPsbtPayment(psbt, account.watchOnlyAccount(), {
  network,
  recipients: request.recipients.map(({ address, amount }) => ({ address, amount: BigInt(amount) })),
  maxFee: BigInt(request.maxFee),
  nextChangeIndex: request.nextChangeIndex,
});
for (let i = 0; i < psbt.inputCount; i += 1) account.signInput(psbt, i);
const hex = Buffer.from(serializeTransaction(finalizePsbt(psbt))).toString('hex');
account.destroy();
process.stdout.write(JSON.stringify({ hex, sent: String(summary.sent), change: String(summary.change), fee: String(summary.fee) }));
