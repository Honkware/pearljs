// Relay policy on the public network's node, at no cost: transactions spend
// a stranger's unspent P2TR output with a made-up signature, so nothing can
// ever be relayed. pearld checks the outputs, version and fee before it runs
// any script, so for each transaction checkStandard refuses, the node refuses
// it for the same reason, both in testmempoolaccept and in
// sendrawtransaction; and one checkStandard passes gets through every policy
// check and fails only on its signature.

import { beforeAll, expect, it } from 'vitest';
import {
  PearlRpcError,
  PolicyError,
  checkStandard,
  createTransaction,
  embed,
  estimateVsize,
  minRelayFee,
  parseBlock,
  parseTransaction,
  serializeTransaction,
  toOutputScript,
  transactionId,
  type PearlErrorCode,
  type Transaction,
  type TxOutput,
} from '../../src/index.js';
import { account, describeTestnet, network, node } from './env.js';

let coin: { txid: string; vout: number; output: TxOutput };
const recipient = (): Uint8Array => toOutputScript(account(5).deriveAddress(0), network);

/** An unspent, mature P2TR output somewhere in the last 300 blocks that no mempool transaction spends. */
async function strangersCoin(): Promise<typeof coin> {
  const tip = await node.getBlockCount();
  // A rehearsal chain is shorter than 120 blocks: there the search starts at the newest mature coinbase.
  const newest = tip - 120 >= 1 ? tip - 120 : tip - network.coinbaseMaturity;
  for (let height = newest; height > Math.max(0, tip - 300); height--) {
    const block = parseBlock(await node.getRawBlock(await node.getBlockHash(height)));
    for (const tx of block.transactions) {
      const txid = transactionId(tx);
      for (const [vout, out] of tx.outs.entries()) {
        if (out.script.length !== 34 || out.script[0] !== 0x51 || out.value < 1_000_000n) continue;
        if ((await node.getTxOut(txid, vout, false)) === null) continue;
        if ((await node.getTxSpendingPrevOut([{ txid, vout }]))[0]?.spendingtxid) continue;
        return { txid, vout, output: { script: out.script, value: out.value } };
      }
    }
  }
  throw new Error('no unspent P2TR output of 0.01 PRL or more in the last 300 blocks');
}

/** Spends the stranger's coin to outputs, with a 64-byte witness that has the shape of a key-path signature. */
function spend(outputs: readonly TxOutput[], version = 2): Transaction {
  const tx = createTransaction(version);
  tx.addInput(Buffer.from(coin.txid, 'hex').reverse(), coin.vout);
  for (const out of outputs) tx.addOutput(out.script, out.value);
  tx.ins[0]!.witness = [new Uint8Array(64).fill(1)];
  return tx;
}

/** The coin less a normal fee, to the throwaway recipient, after the outputs given. */
function withChange(outputs: readonly TxOutput[], version = 2): Transaction {
  const draft = spend([...outputs, { script: recipient(), value: 0n }], version);
  const fee = minRelayFee(estimateVsize(draft, [{ type: 'keyPath' }])) * 2n;
  const spent = outputs.reduce((sum, out) => sum + out.value, 0n);
  return spend([...outputs, { script: recipient(), value: coin.output.value - spent - fee }], version);
}

async function nextBlock(): Promise<{ height: number; medianTimePast: number }> {
  const info = await node.getBlockchainInfo();
  return { height: info.blocks + 1, medianTimePast: info.mediantime };
}

async function expectSameRefusal(tx: Transaction, code: PearlErrorCode, wrapped: boolean): Promise<void> {
  let predicted = '';
  try {
    checkStandard(tx, { prevouts: [coin.output], ...(await nextBlock()) });
  } catch (error) {
    expect(error).toBeInstanceOf(PolicyError);
    expect((error as PolicyError).code).toBe(code);
    predicted = (error as Error).message;
  }
  expect(predicted, 'checkStandard passed it').not.toBe('');
  const reason = wrapped ? `transaction ${transactionId(tx)} is not standard: ${predicted}` : predicted;
  const [result] = await node.testMempoolAccept([serializeTransaction(tx)]);
  expect(result).toMatchObject({ allowed: false, 'reject-reason': reason });
  const refusal = await node.sendRawTransaction(serializeTransaction(tx)).then(
    () => null,
    (error: unknown) => error,
  );
  expect(refusal).toBeInstanceOf(PearlRpcError);
  expect((refusal as PearlRpcError).message).toContain(reason);
}

describeTestnet('relay policy of a testnet2 node run with --rejectnonstd', () => {
  beforeAll(async () => {
    coin = await strangersCoin();
  });

  it('refuses a 332-grain output as dust, as checkStandard does', async () => {
    await expectSameRefusal(withChange([{ script: recipient(), value: 332n }]), 'POLICY_DUST', true);
  });

  it('refuses a SegWit v0 output by consensus, as checkStandard does', async () => {
    const p2wpkh = Uint8Array.from([0x00, 0x14, ...new Uint8Array(20).fill(7)]);
    await expectSameRefusal(withChange([{ script: p2wpkh, value: 100_000n }]), 'SANITY_OUTPUT_SCRIPT', false);
  });

  it('refuses two OP_RETURN outputs, as checkStandard does', async () => {
    const data = embed({ data: Uint8Array.of(1, 2, 3) }).output;
    await expectSameRefusal(withChange([{ script: data, value: 0n }, { script: data, value: 0n }]), 'POLICY_MULTIPLE_NULLDATA', true);
  });

  it('refuses transaction version 3, as checkStandard does', async () => {
    await expectSameRefusal(withChange([], 3), 'POLICY_VERSION', true);
  });

  it('refuses a fee one grain under the relay fee, as checkStandard does', async () => {
    const draft = spend([{ script: recipient(), value: 0n }]);
    const fee = minRelayFee(estimateVsize(draft, [{ type: 'keyPath' }])) - 1n;
    await expectSameRefusal(spend([{ script: recipient(), value: coin.output.value - fee }]), 'POLICY_FEE_TOO_LOW', false);
  });

  it('passes a transaction checkStandard passes through every policy check, to fail only on its signature', async () => {
    const tx = withChange([{ script: recipient(), value: 333n }]);
    checkStandard(tx, { prevouts: [coin.output], ...(await nextBlock()) });
    const [result] = await node.testMempoolAccept([serializeTransaction(tx)]);
    expect(result!.allowed).toBe(false);
    expect(result!['reject-reason']).toMatch(/^failed to validate input [0-9a-f]{64}:0 which references output /);
    expect(parseTransaction(serializeTransaction(tx)).getId()).toBe(transactionId(tx));
  });
});
