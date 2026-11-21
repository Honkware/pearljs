// P2MR on testnet2. One wallet send funds, in one transaction: a script tree
// with a 2-of-3 multi_a leaf and a CSV leaf (twice, one output for each
// leaf), an XMSS key kept outside the wallet with its index in a file store,
// and an XMSS key the wallet holds. Then each is spent back to the first
// address: the multisig leaf by two signers through a PSBT, the CSV leaf
// once refused before its lock and then after it, the outside key with one
// signature whose index the file shows advanced after the store is reopened,
// and the wallet's key, whose index survives closing and reopening the wallet.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  PearlRpcError,
  addInputByTxid,
  assembleScriptTree,
  checkStandard,
  checksigScript,
  createPsbt,
  createTransaction,
  createXmssSigner,
  csvScript,
  encodeSequence,
  estimateVsize,
  feeForVsize,
  finalizePsbt,
  generateXmssSeeds,
  multiAScript,
  p2mr,
  p2mrAddress,
  parseTransaction,
  prepareP2mrScriptPathInput,
  serializeTransaction,
  signXmssP2mrInput,
  toOutputScript,
  xmssLeafScript,
  type PearlWallet,
  type ScriptTree,
  type Transaction,
} from '../../src/index.js';
import { createFileXmssIndexStore, readXmssIndexFile } from '../../src/xmss-file-store.js';
import { account, confirmed, describeTestnet, feeRate, fundsOrSkip, home, network, node, openWallet, record, walletDir } from './env.js';

const VALUE = 300_000n;
const LOCK = encodeSequence({ blocks: 2 });
const runDir = join(dirname(walletDir), 'runs', `p2mr-${Date.now()}`);
const signers = [account(3), account(4), account(5)];
const vault: ScriptTree = assembleScriptTree([
  multiAScript(signers.map((signer) => signer.derivePublicKey(0)), 2),
  csvScript(LOCK, checksigScript(signers[0]!.derivePublicKey(1))),
]);
const vaultAddress = p2mrAddress({ merkleRoot: vault.root }, network);
const seeds = generateXmssSeeds();
const indexFile = join(runDir, 'outside.xmss-index');
let outsideTree: ScriptTree;

let wallet: PearlWallet;
let skip: string | null = null;
let funding: Transaction;
let rate = 0n;
let walletKey = '';

const voutOf = (script: Uint8Array, skipFirst = 0): number =>
  funding.outs.findIndex((out, i) => i >= skipFirst && Buffer.from(out.script).equals(Buffer.from(script)));

/** An unsigned spend of one funding output to the first address, less the fee for how it will be spent. `stack` gives the witness sizes under a leaf estimateVsize cannot read. */
function spendTo(vout: number, tree: ScriptTree, leafIndex: number, sequence?: number, stack?: number[]): Transaction {
  const tx = createTransaction(2);
  addInputByTxid(tx, funding.getId(), vout, sequence);
  tx.addOutput(toOutputScript(home(), network), 0n);
  const fee = feeForVsize(estimateVsize(tx, [{ type: 'scriptPath', tree, leafIndex, p2mr: true, ...(stack === undefined ? {} : { stack }) }]), rate);
  tx.outs[0]!.value = funding.outs[vout]!.value - fee;
  return tx;
}

async function broadcast(test: string, tx: Transaction): Promise<string> {
  checkStandard(tx, { prevouts: tx.ins.map((input) => funding.outs[input.index]!) });
  const txid = await node.sendRawTransaction(serializeTransaction(tx));
  record('d p2mr', test, txid, { vsize: tx.virtualSize() });
  return txid;
}

describeTestnet('P2MR spends on testnet2', () => {
  beforeAll(async () => {
    wallet = await openWallet();
    skip = await fundsOrSkip(wallet, 5n * VALUE);
    rate = await feeRate();
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    // The outside key's seeds, kept so its coins can be recovered by hand if a run dies.
    writeFileSync(join(runDir, 'outside.xmss-seeds.json'), JSON.stringify({ private: Buffer.from(seeds.privateSeed).toString('hex'), public: Buffer.from(seeds.publicSeed).toString('hex') }), { mode: 0o600 });
    const store = createFileXmssIndexStore(indexFile, { create: true });
    const signer = createXmssSigner(seeds.privateSeed, seeds.publicSeed, store);
    outsideTree = assembleScriptTree([xmssLeafScript(signer.publicKey)]);
    signer.destroy();
    store.close();
  });
  afterAll(async () => {
    await wallet?.close();
  });

  it('funds the vault twice and both XMSS keys in one wallet send, confirmed', async (context) => {
    if (skip !== null) context.skip(skip);
    const key = await wallet.addXmssKey({ label: 'testnet2 xmss' });
    // fundsOrSkip synced the wallet first, so the key is born after that tip and no backend scans its address from genesis.
    expect(key.birthHeight).not.toBeNull();
    walletKey = key.id;
    const sent = await wallet.send({
      recipients: [
        { address: vaultAddress, amount: VALUE },
        { address: vaultAddress, amount: VALUE },
        { address: p2mrAddress({ merkleRoot: outsideTree.root }, network), amount: VALUE },
        { address: key.address, amount: VALUE },
      ],
      feeRate: rate,
      label: 'p2mr: fund',
    });
    record('d p2mr', 'fund vault, outside XMSS key and wallet XMSS key', sent.txid);
    funding = parseTransaction(sent.hex);
    await confirmed(sent.txid);
  });

  it('spends the multi_a leaf with two of the three signers through a PSBT', async (context) => {
    if (skip !== null || funding === undefined) context.skip(skip ?? 'not funded');
    const vout = voutOf(p2mr({ merkleRoot: vault.root }).output);
    const psbt = createPsbt(spendTo(vout, vault, 0));
    prepareP2mrScriptPathInput(psbt, 0, { tree: vault, leafIndex: 0, value: VALUE, previousTransaction: funding });
    signers[0]!.signScriptPathInput(psbt, 0, { index: 0, leafHash: vault.leaves[0]!.leafHash });
    signers[2]!.signScriptPathInput(psbt, 0, { index: 0, leafHash: vault.leaves[0]!.leafHash });
    const txid = await broadcast('multi_a leaf spend', finalizePsbt(psbt));
    await confirmed(txid);
  });

  it('spends the CSV leaf, which the node refuses until the funding is two blocks deep', async (context) => {
    if (skip !== null || funding === undefined) context.skip(skip ?? 'not funded');
    const vout = voutOf(p2mr({ merkleRoot: vault.root }).output, voutOf(p2mr({ merkleRoot: vault.root }).output) + 1);
    const sign = (): Transaction => {
      const psbt = createPsbt(spendTo(vout, vault, 1, LOCK, [64]));
      prepareP2mrScriptPathInput(psbt, 0, { tree: vault, leafIndex: 1, value: VALUE, previousTransaction: funding });
      signers[0]!.signScriptPathInput(psbt, 0, { index: 1, leafHash: vault.leaves[1]!.leafHash });
      return finalizePsbt(psbt);
    };
    const depth = (await node.getRawTransaction(funding.getId())).confirmations ?? 0;
    if (depth < 2) {
      const refusal = await node.sendRawTransaction(serializeTransaction(sign())).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(PearlRpcError);
      expect((refusal as Error).message).toMatch(/sequence lock/);
      record('d p2mr', 'CSV leaf refused before its lock', '', { depth, message: (refusal as Error).message });
    }
    await confirmed(funding.getId(), 2);
    const txid = await broadcast('CSV leaf spend', sign());
    await confirmed(txid);
  });

  it('spends the outside XMSS key with one signature, and the reopened file store is past that index', async (context) => {
    if (skip !== null || funding === undefined) context.skip(skip ?? 'not funded');
    const vout = voutOf(p2mr({ merkleRoot: outsideTree.root }).output);
    const tx = spendTo(vout, outsideTree, 0);
    const store = createFileXmssIndexStore(indexFile);
    const signer = createXmssSigner(seeds.privateSeed, seeds.publicSeed, store);
    expect(await signer.remaining()).toBe(31);
    await signXmssP2mrInput(tx, 0, signer, { prevouts: [funding.outs[vout]!], tree: outsideTree, leafIndex: 0, previousTransactions: [funding] });
    signer.destroy();
    store.close();
    // An XMSS signature starts with its index, big-endian.
    expect(Buffer.from(tx.ins[0]!.witness[0]!.subarray(0, 4)).readUInt32BE()).toBe(0);
    expect(readXmssIndexFile(indexFile)).toMatchObject({ next: 1, remaining: 30, locked: false });
    const reopened = createFileXmssIndexStore(indexFile);
    const again = createXmssSigner(seeds.privateSeed, seeds.publicSeed, reopened);
    expect(await again.remaining()).toBe(30);
    again.destroy();
    reopened.close();
    const txid = await broadcast('outside XMSS key spend', tx);
    await confirmed(txid);
  });

  it('spends the wallet XMSS key, and the wallet reopened has it at index 1 with index 0 seen on chain', async (context) => {
    if (skip !== null || funding === undefined) context.skip(skip ?? 'not funded');
    await wallet.sync();
    const sent = await wallet.send({ recipients: [{ address: home(), amount: 'max' }], from: { xmss: walletKey }, feeRate: rate, label: 'p2mr: wallet XMSS home' });
    record('d p2mr', 'wallet XMSS key spend', sent.txid, { vsize: sent.vsize });
    expect(wallet.xmssKeys().find((key) => key.id === walletKey)!.nextIndex).toBe(1);
    await confirmed(sent.txid);
    await wallet.close();
    wallet = await openWallet();
    await wallet.sync();
    const key = wallet.xmssKeys().find((entry) => entry.id === walletKey)!;
    expect(key).toMatchObject({ nextIndex: 1, remaining: 30, highestOnChain: 0, frozen: null });
    expect(wallet.balance().total).toBeGreaterThan(0n);
  });
});
