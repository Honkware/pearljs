// Signing paths no earlier live test took, each mined by a regtest pearld: a
// BIP86 payment of several inputs signed through signInputAsync with the
// account's own keyPathSigner standing in for a device, at SIGHASH_ALL; a
// key-path spend whose witness ends with an annex; leaves that take more than
// signatures (a hash lock with two signatures, a CLTV with a preimage, an
// OP_CAT leaf) on script-only P2TR and on P2MR, co-signed through base64 and
// finalized with finalizeScriptPathInput; the cold flow with proven change;
// and one leaf of a P2TR input that lists two.

import { xOnlyPointFromScalar } from 'tiny-secp256k1';
import { expect, it } from 'vitest';
import {
  assembleScriptTree,
  buildPayment,
  checkPsbtPayment,
  checksigScript,
  cltvScript,
  compileScript,
  createPsbt,
  createTransaction,
  deriveSigningAccountFromSeed,
  finalizePsbt,
  finalizeScriptPathInput,
  keyPathAddress,
  keyPathSighash,
  keyPathSignerFromPrivateKey,
  mnemonicToSeed,
  NUMS_INTERNAL_KEY,
  OP_CODES,
  p2mr,
  p2trScriptOnly,
  parsePsbt,
  pearldBackend,
  prepareP2mrScriptPathInput,
  prepareTaprootScriptPathInput,
  psbtOutputs,
  serializeTransaction,
  sha256,
  SigningError,
  toOutputScript,
  Transaction,
  verifyFinalizedPsbt,
  verifyTransaction,
} from '../src/index.js';
import type { Psbt, ScriptTree } from '../src/index.js';
import { addChange, broadcastAndConfirm, changeScript, describeLive, fund, mine, network, pearld, prevoutsOf, testMempoolAccept } from './chain.js';

const alice = deriveSigningAccountFromSeed(mnemonicToSeed('knife repeat expire skate screen early noodle spray van business tuna magic'), network);
const bob = deriveSigningAccountFromSeed(mnemonicToSeed('short proof topple senior exclude puppy pumpkin rally torch cute fatigue wagon'), network);
const VALUE = 20_000_000n;
const FEE = 20_000n;

/** What one side sends the other: the PSBT as base64, parsed again on arrival. */
const sent = (psbt: Psbt): Psbt => parsePsbt(psbt.toBase64());

describeLive('key-path signing through a device and with an annex', () => {
  it('signs three BIP86 inputs through signInputAsync with keyPathSigner as the device, at SIGHASH_ALL', async () => {
    const watching = alice.watchOnlyAccount();
    const values = [7_000_000n, 8_000_000n, 9_000_000n];
    const funding = await fund(values.map((value, i) => ({ script: toOutputScript(watching.deriveAddress(i), network), value })));
    const tx = createTransaction(2);
    values.forEach((_, i) => tx.addInput(funding.getHash(), i));
    tx.addOutput(toOutputScript(bob.deriveAddress(0), network), 20_000_000n);
    const estimate = addChange(tx, 24_000_000n, values.map(() => ({ type: 'keyPath' as const, sighashType: Transaction.SIGHASH_ALL })));

    let psbt = createPsbt(tx);
    values.forEach((value, i) => {
      watching.prepareInput(psbt, i, { index: i, value });
      psbt.updateInput(i, { sighashType: Transaction.SIGHASH_ALL });
    });
    const device = alice.keyPathSigner();
    // The account signs only the default type unless told otherwise.
    await expect(watching.signInputAsync(sent(psbt), 0, device)).rejects.toMatchObject({ code: 'SIGHASH_NOT_ALLOWED' });
    for (let i = 0; i < values.length; i += 1) {
      psbt = sent(psbt);
      await watching.signInputAsync(psbt, i, device, { allowedSighashTypes: [Transaction.SIGHASH_ALL] });
    }
    const signed = finalizePsbt(psbt);
    for (const input of signed.ins) {
      expect(input.witness).toHaveLength(1);
      expect(input.witness[0]!.length).toBe(65);
      expect(input.witness[0]![64]).toBe(Transaction.SIGHASH_ALL);
    }
    expect(await testMempoolAccept(signed)).toMatchObject({ allowed: true, vsize: estimate });
    await broadcastAndConfirm(signed);
  });

  it('spends a key path with an annex, and pearld refuses the same signature once the annex is dropped', async () => {
    const privateKey = sha256(new TextEncoder().encode('pearljs live annex key'));
    const address = keyPathAddress(privateKey, network);
    const funding = await fund([{ script: toOutputScript(address, network), value: VALUE }]);
    const prevouts = prevoutsOf(createSpend(funding), [funding]);
    const annex = Uint8Array.from([0x50, 0x70, 0x65, 0x61, 0x72, 0x6c]);
    const tx = createSpend(funding);
    const internalPubkey = xOnlyPointFromScalar(privateKey);
    const outputKey = toOutputScript(address, network).slice(2);
    const signature = await keyPathSignerFromPrivateKey(privateKey).signKeyPath({
      hash: keyPathSighash(tx, 0, { prevouts, annex }),
      outputKey,
      internalPubkey,
      merkleRoot: null,
      sighashType: 0,
      inputIndex: 0,
    });
    const without = tx.clone();
    without.setWitness(0, [signature]);
    // pearld's engine fails a key-path signature with ErrTaprootSigInvalid and no text
    // (node/txscript/taproot.go:118), so its reason names no cause; the interpreter names it.
    expect(await testMempoolAccept(without)).toMatchObject({ allowed: false, 'reject-reason': expect.stringMatching(/^failed to validate input \S+ which references output \S+ - {2}\(input witness/) as string });
    expect(verifyTransaction(without, prevouts)).toMatchObject({ ok: false, code: 'ErrTaprootSigInvalid', inputIndex: 0 });
    tx.setWitness(0, [signature, annex]);
    expect((await testMempoolAccept(tx)).allowed).toBe(true);
    const info = await broadcastAndConfirm(tx);
    expect((info.vin[0] as { txinwitness?: string[] }).txinwitness).toEqual([Buffer.from(signature).toString('hex'), Buffer.from(annex).toString('hex')]);
  });
});

function createSpend(funding: Transaction): Transaction {
  const tx = createTransaction(2);
  tx.addInput(funding.getHash(), 0);
  tx.addOutput(changeScript, VALUE - FEE);
  return tx;
}


type Kind = 'p2tr' | 'p2mr';
const secret = new TextEncoder().encode('pearljs live swap secret');
const blob = new TextEncoder().encode('pearl-live-covenant');
const A = alice.derivePublicKey(300);
const B = bob.derivePublicKey(300);
const twoParty = compileScript([OP_CODES.OP_SHA256, sha256(secret), OP_CODES.OP_EQUALVERIFY, A, OP_CODES.OP_CHECKSIGVERIFY, B, OP_CODES.OP_CHECKSIG]);
const catLeaf = compileScript([OP_CODES.OP_CAT, OP_CODES.OP_SHA256, sha256(blob), OP_CODES.OP_EQUAL]);
const preimageOnly = compileScript([OP_CODES.OP_SHA256, sha256(secret), OP_CODES.OP_EQUAL]);

function outputOf(kind: Kind, tree: ScriptTree): Uint8Array {
  return kind === 'p2tr' ? p2trScriptOnly({ merkleRoot: tree.root }).output : p2mr({ merkleRoot: tree.root }).output;
}

/** Funds the tree and returns a PSBT spending it through one leaf, prepared and sent to the first signer. */
async function prepared(kind: Kind, tree: ScriptTree, leafIndex: number, shape: { locktime?: number; sequence?: number } = {}): Promise<Psbt> {
  const funding = await fund([{ script: outputOf(kind, tree), value: VALUE }]);
  const tx = createTransaction(2);
  tx.locktime = shape.locktime ?? 0;
  tx.addInput(funding.getHash(), 0, shape.sequence ?? 0xfffffffd);
  tx.addOutput(changeScript, VALUE - FEE);
  const psbt = createPsbt(tx);
  if (kind === 'p2tr') prepareTaprootScriptPathInput(psbt, 0, { internalPubkey: NUMS_INTERNAL_KEY, tree, leafIndex, value: VALUE });
  else prepareP2mrScriptPathInput(psbt, 0, { tree, leafIndex, value: VALUE, previousTransaction: funding });
  return sent(psbt);
}

async function mined(psbt: Psbt): Promise<void> {
  const tx = finalizePsbt(sent(psbt));
  expect(verifyFinalizedPsbt(psbt)).toEqual({ ok: true });
  expect((await testMempoolAccept(tx)).allowed).toBe(true);
  await broadcastAndConfirm(tx);
}

describeLive('leaves that take more than signatures', () => {
  for (const kind of ['p2tr', 'p2mr'] as const) {
    it(`co-signs a two-party hash lock on ${kind} across base64 round trips and pearld mines it`, async () => {
      const tree = assembleScriptTree([twoParty, checksigScript(B)]);
      const { leafHash } = tree.leaves[0]!;
      let psbt = await prepared(kind, tree, 0);
      alice.signScriptPathInput(psbt, 0, { index: 300, leafHash });
      psbt = sent(psbt);
      bob.signScriptPathInput(psbt, 0, { index: 300, leafHash });
      psbt = sent(psbt);
      expect(() => finalizePsbt(sent(psbt))).toThrow(expect.objectContaining({ code: 'WITNESS_ITEMS_NEEDED' }) as Error);
      // B is checked last, so its signature is the deepest item.
      finalizeScriptPathInput(psbt, 0, { stack: (signatureFor) => [signatureFor(B), signatureFor(A), secret] });
      await mined(psbt);
    });

    it(`spends a CLTV and preimage leaf on ${kind} once its height is passed, and pearld holds it until then`, async () => {
      // Funding takes the next block, so the spend can enter the one after it at the earliest.
      const height = (await pearld.getBlockCount()) + 2;
      const tree = assembleScriptTree([cltvScript(height, preimageOnly)]);
      const psbt = await prepared(kind, tree, 0, { locktime: height, sequence: 0xfffffffe });
      expect(() => finalizeScriptPathInput(sent(psbt), 0, { stack: [blob] })).toThrow(expect.objectContaining({ scriptCode: 'ErrEvalFalse' }) as Error);
      finalizeScriptPathInput(psbt, 0, { stack: [secret] });
      const tx = finalizePsbt(sent(psbt));
      expect(await testMempoolAccept(tx)).toMatchObject({ allowed: false, 'reject-reason': expect.stringContaining('is not finalized') as string });
      await mine(1);
      await mined(psbt);
    });

    it(`finalizes an OP_CAT leaf on ${kind} from two pieces and pearld mines it`, async () => {
      const tree = assembleScriptTree([catLeaf, checksigScript(A)]);
      const psbt = await prepared(kind, tree, 0);
      expect(() => finalizeScriptPathInput(sent(psbt), 0, { stack: [blob] })).toThrow(expect.objectContaining({ scriptCode: 'ErrInvalidStackOperation' }) as Error);
      finalizeScriptPathInput(psbt, 0, { stack: [blob.slice(0, 7), blob.slice(7)] });
      await mined(psbt);
    });
  }

  it('signs and spends the second of two leaves a P2TR input lists', async () => {
    const tree = assembleScriptTree([checksigScript(A), checksigScript(B)]);
    const psbt = await prepared('p2tr', tree, 0);
    const second = createPsbt(createTransaction(2));
    second.addInput({ hash: new Uint8Array(32), index: 0 });
    prepareTaprootScriptPathInput(second, 0, { internalPubkey: NUMS_INTERNAL_KEY, tree, leafIndex: 1, value: VALUE });
    psbt.updateInput(0, { tapLeafScript: second.data.inputs[0]!.tapLeafScript! });
    expect(psbt.data.inputs[0]!.tapLeafScript).toHaveLength(2);
    const received = sent(psbt);
    bob.signScriptPathInput(received, 0, { index: 300, leafHash: tree.leaves[1]!.leafHash });
    const tx = finalizePsbt(sent(received));
    expect(tx.ins[0]!.witness[1]).toEqual(checksigScript(B));
    expect((await testMempoolAccept(tx)).allowed).toBe(true);
    await broadcastAndConfirm(tx);
  });
});

describeLive('cold signing with proven change', () => {
  it('builds with changeFrom, checks the PSBT offline, signs, and the change lands on the recorded child', async () => {
    const watching = bob.watchOnlyAccount();
    const backend = pearldBackend(pearld, { network });
    const addresses = [watching.deriveAddress(40), watching.deriveAddress(41)];
    await fund(addresses.map((address) => ({ script: toOutputScript(address, network), value: 6_000_000n })));
    const utxos = (await backend.getUtxos(addresses)).map((utxo) => ({ ...utxo, index: addresses.indexOf(utxo.address) + 40 }));
    const recipient = alice.deriveAddress(301);
    const payment = buildPayment({ network, utxos, recipients: [{ address: recipient, amount: 10_000_000n }], feeRate: 2000n, changeFrom: { account: watching, index: 7 } });
    payment.inputs.forEach((utxo, i) => watching.prepareInput(payment.psbt, i, utxo));
    const request = payment.psbt.toBase64();

    // Offline: the signer checks what the PSBT pays before signing anything.
    const psbt = parsePsbt(request);
    const summary = checkPsbtPayment(psbt, watching, { network, recipients: [{ address: recipient, amount: 10_000_000n }], maxFee: 10_000n });
    expect(summary).toMatchObject({ sent: 10_000_000n, change: payment.change, fee: payment.fee });
    expect(psbtOutputs(psbt, network, watching).find((output) => output.mine === true)).toMatchObject({ child: { index: 7, change: true }, value: payment.change });
    expect(() => checkPsbtPayment(psbt, watching, { network, recipients: [{ address: recipient, amount: 9_000_000n }] })).toThrow(SigningError);
    // Change at index 7 is out of reach of a restore that scans five past index 2, and within it from index 3.
    const expected = { network, recipients: [{ address: recipient, amount: 10_000_000n }], gapLimit: 5 };
    expect(() => checkPsbtPayment(psbt, watching, { ...expected, nextChangeIndex: 2 })).toThrow(expect.objectContaining({ code: 'PSBT_OUTPUT_UNEXPECTED', message: expect.stringContaining('where a restore would not find it') as string }) as Error);
    expect(checkPsbtPayment(psbt, watching, { ...expected, nextChangeIndex: 3 }).change).toBe(payment.change);
    expect(() => checkPsbtPayment(psbt, alice.watchOnlyAccount(), { network, recipients: [{ address: recipient, amount: 10_000_000n }] })).toThrow(expect.objectContaining({ code: 'PSBT_OUTPUT_UNEXPECTED' }) as Error);
    for (let i = 0; i < psbt.inputCount; i += 1) bob.signInput(psbt, i);
    const signed = finalizePsbt(sent(psbt));

    expect(await pearld.sendRawTransaction(serializeTransaction(signed))).toBe(payment.transaction.getId());
    const [block] = await mine(1);
    expect(await pearld.getRawTransaction(payment.transaction.getId())).toMatchObject({ blockhash: block, confirmations: 1 });
    const change = bob.deriveAddress(7, true);
    expect(await backend.getUtxos([change])).toMatchObject([{ txid: payment.transaction.getId(), value: payment.change, address: change, confirmations: 1 }]);
  });
});
