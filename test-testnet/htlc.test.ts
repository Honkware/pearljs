// Hash timelocks on testnet2, in a P2TR tree (NUMS internal key) and a P2MR
// tree: one wallet send funds a claim and a refund contract of each kind.
// The claims are spent with the preimage, which is then read back out of the
// mined transaction; the refunds wait out a two-block CSV lock, and the node
// refuses each refund until then.

import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  NUMS_INTERNAL_KEY,
  PearlRpcError,
  addInputByTxid,
  assembleScriptTree,
  checkStandard,
  createPsbt,
  createTransaction,
  encodeSequence,
  estimateVsize,
  extractHtlcPreimage,
  feeForVsize,
  finalizePsbt,
  finalizeScriptPathInput,
  fromOutputScript,
  htlcLeaves,
  htlcStack,
  htlcStackSizes,
  p2mr,
  p2tr,
  parseTransaction,
  prepareP2mrScriptPathInput,
  prepareTaprootScriptPathInput,
  serializeTransaction,
  sha256,
  toOutputScript,
  type PearlWallet,
  type ScriptTree,
  type Transaction,
} from '../src/index.js';
import { account, confirmed, describeTestnet, feeRate, fundsOrSkip, home, network, node, openWallet, record } from './env.js';

const VALUE = 200_000n;
const LOCK = encodeSequence({ blocks: 2 });
const claimer = account(6);
const refunder = account(7);

interface Contract {
  name: string;
  kind: 'p2tr' | 'p2mr';
  preimage: Uint8Array;
  tree: ScriptTree;
  script: Uint8Array;
}

function contract(name: string, kind: 'p2tr' | 'p2mr', n: number): Contract {
  const preimage = Uint8Array.from(randomBytes(32));
  const { claim, refund } = htlcLeaves({
    hash: sha256(preimage),
    claimKey: claimer.derivePublicKey(n),
    refundKey: refunder.derivePublicKey(n),
    timelock: { sequence: LOCK },
  });
  const tree = assembleScriptTree([claim, refund]);
  const script = kind === 'p2mr' ? p2mr({ merkleRoot: tree.root }).output : p2tr({ internalPubkey: NUMS_INTERNAL_KEY, merkleRoot: tree.root }).output;
  return { name, kind, preimage, tree, script };
}

const contracts = [contract('P2TR claimed', 'p2tr', 0), contract('P2TR refunded', 'p2tr', 1), contract('P2MR claimed', 'p2mr', 2), contract('P2MR refunded', 'p2mr', 3)];
let wallet: PearlWallet;
let skip: string | null = null;
let funding: Transaction;
let rate = 0n;

function spend(c: Contract, leafIndex: 0 | 1, n: number): Transaction {
  const vout = funding.outs.findIndex((out) => Buffer.from(out.script).equals(Buffer.from(c.script)));
  const leaf = c.tree.leaves[leafIndex]!.script;
  const unsigned = createTransaction(2);
  addInputByTxid(unsigned, funding.getId(), vout, leafIndex === 1 ? LOCK : undefined);
  unsigned.addOutput(toOutputScript(home(), network), 0n);
  const vsize = estimateVsize(unsigned, [{ type: 'scriptPath', tree: c.tree, leafIndex, p2mr: c.kind === 'p2mr', stack: htlcStackSizes(leaf) }]);
  unsigned.outs[0]!.value = VALUE - feeForVsize(vsize, rate);
  const psbt = createPsbt(unsigned);
  if (c.kind === 'p2mr') prepareP2mrScriptPathInput(psbt, 0, { tree: c.tree, leafIndex, value: VALUE, previousTransaction: funding });
  else prepareTaprootScriptPathInput(psbt, 0, { internalPubkey: NUMS_INTERNAL_KEY, tree: c.tree, leafIndex, value: VALUE });
  (leafIndex === 0 ? claimer : refunder).signScriptPathInput(psbt, 0, { index: n, leafHash: c.tree.leaves[leafIndex]!.leafHash });
  finalizeScriptPathInput(psbt, 0, { stack: leafIndex === 0 ? htlcStack(leaf, { preimage: c.preimage }) : htlcStack(leaf) });
  const tx = finalizePsbt(psbt);
  expect(tx.virtualSize()).toBe(vsize);
  checkStandard(tx, { prevouts: [funding.outs[vout]!] });
  return tx;
}

describeTestnet('hash timelocks on testnet2', () => {
  beforeAll(async () => {
    wallet = await openWallet();
    skip = await fundsOrSkip(wallet, 5n * VALUE);
    rate = await feeRate();
  });
  afterAll(async () => {
    await wallet?.close();
  });

  it('funds four contracts in one send', async (context) => {
    if (skip !== null) context.skip(skip);
    const sent = await wallet.send({
      recipients: contracts.map((c) => ({ address: fromOutputScript(c.script, network), amount: VALUE })),
      feeRate: rate,
      label: 'htlc: fund',
    });
    record('e htlc', 'fund P2TR and P2MR contracts', sent.txid);
    funding = parseTransaction(sent.hex);
    await confirmed(sent.txid);
  });

  it('claims each claim contract with its preimage, which the mined transaction gives back', async (context) => {
    if (skip !== null || funding === undefined) context.skip(skip ?? 'not funded');
    for (const [n, c] of contracts.entries()) {
      if (!c.name.endsWith('claimed')) continue;
      const txid = await node.sendRawTransaction(serializeTransaction(spend(c, 0, n)));
      record('e htlc', `${c.name}: claim`, txid);
      await confirmed(txid);
      const mined = parseTransaction(await node.getRawTransactionHex(txid));
      expect(extractHtlcPreimage(mined, sha256(c.preimage))).toMatchObject({ inputIndex: 0, preimage: c.preimage });
    }
  });

  it('refunds each refund contract once its CSV lock has passed, and not before', async (context) => {
    if (skip !== null || funding === undefined) context.skip(skip ?? 'not funded');
    const refunds = [...contracts.entries()].filter(([, c]) => c.name.endsWith('refunded'));
    if (((await node.getRawTransaction(funding.getId())).confirmations ?? 0) < 2) {
      for (const [n, c] of refunds) {
        const refusal = await node.sendRawTransaction(serializeTransaction(spend(c, 1, n))).catch((error: unknown) => error);
        expect(refusal, c.name).toBeInstanceOf(PearlRpcError);
        expect((refusal as Error).message).toMatch(/sequence lock/);
      }
    }
    await confirmed(funding.getId(), 2);
    const txids = [];
    for (const [n, c] of refunds) {
      const txid = await node.sendRawTransaction(serializeTransaction(spend(c, 1, n)));
      record('e htlc', `${c.name}: refund`, txid);
      txids.push(txid);
    }
    for (const txid of txids) {
      await confirmed(txid);
      expect(extractHtlcPreimage(parseTransaction(await node.getRawTransactionHex(txid)), sha256(contracts[1]!.preimage))).toBeNull();
    }
  });
});
