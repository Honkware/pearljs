// Annexes and OP_CODESEPARATOR on a regtest pearld: script-path spends of
// P2TR and P2MR outputs whose witness ends with an annex, and leaves with
// one and with two code separators, each signature made for the separator
// that has run by the time it is checked. pearld relays and mines all of
// them, and refuses the same spends signed for the wrong annex or position.

import { expect, it } from 'vitest';
import {
  assembleScriptTree,
  checkStandard,
  checksigScript,
  codeSeparatorPositions,
  compileScript,
  createTransaction,
  deriveSigningAccountFromSeed,
  inspectTransaction,
  mnemonicToSeed,
  OP_CODES,
  p2mr,
  p2mrControlBlock,
  p2tr,
  scriptPathWitness,
  signTapscriptUnchecked,
  taprootControlBlock,
} from '../../src/index.js';
import type { ScriptTree, Transaction, TxOutput } from '../../src/index.js';
import { addChange, broadcastAllAndConfirm, describeLive, fund, network, prevoutsOf, testMempoolAccept } from './chain.js';

const account = deriveSigningAccountFromSeed(mnemonicToSeed('zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong'), network);
const internalPubkey = account.derivePublicKey(300, true);
const VALUE = 20_000_000n;
const ANNEX = Uint8Array.of(0x50, 0x70, 0x65, 0x61, 0x72, 0x6c);
// txscript's ErrNullFail, which a leaf's failed signature check ends in.
const SIGNATURE_REFUSED = / - signature not empty on failed checksig /;

interface Spend {
  tx: Transaction;
  estimate: number;
  prevouts: TxOutput[];
}

/** An unsigned one-input spend of funding's output vout whose witness will have the given item sizes. */
function start(funding: Transaction, vout: number, items: number[]): Spend {
  const tx = createTransaction(2);
  tx.addInput(funding.getHash(), vout);
  const estimate = addChange(tx, VALUE, [{ type: 'witness', items }]);
  return { tx, estimate, prevouts: prevoutsOf(tx, [funding]) };
}

const output = (tree: ScriptTree, isP2mr: boolean): TxOutput => ({
  script: isP2mr ? p2mr({ merkleRoot: tree.root }).output : p2tr({ internalPubkey, merkleRoot: tree.root }).output,
  value: VALUE,
});

const controlBlock = (tree: ScriptTree, isP2mr: boolean): Uint8Array =>
  isP2mr ? p2mrControlBlock(tree, 0) : taprootControlBlock(internalPubkey, tree, 0);

async function acceptAndMine(spends: Spend[], funding: Transaction): Promise<void> {
  for (const { tx, estimate } of spends) {
    checkStandard(tx, { prevouts: prevoutsOf(tx, [funding]) });
    expect(await testMempoolAccept(tx)).toMatchObject({ allowed: true, vsize: estimate });
  }
  const infos = await broadcastAllAndConfirm(spends.map((spend) => spend.tx));
  infos.forEach((info, i) => expect(info.vsize).toBe(spends[i]!.estimate));
}

describeLive('annexes and code separators', () => {
  it('pearld relays and mines P2TR and P2MR script-path spends that carry an annex', async () => {
    const tree = assembleScriptTree([checksigScript(account.derivePublicKey(301))]);
    const script = tree.leaves[0]!.script;
    const funding = await fund([output(tree, false), output(tree, true), output(tree, true), output(tree, true)]);
    const signer = account.tapscriptSigner({ index: 301 });

    // P2TR, signed on the transaction.
    const taproot = start(funding, 0, [64, script.length, 33, ANNEX.length]);
    const signature = signTapscriptUnchecked(taproot.tx, 0, signer, { prevouts: taproot.prevouts, script, annex: ANNEX });
    taproot.tx.setWitness(0, scriptPathWitness([signature], script, controlBlock(tree, false), ANNEX));

    // P2MR through the checked signer.
    const merkle = start(funding, 1, [64, script.length, 1, ANNEX.length]);
    account.signP2mrInput(merkle.tx, 0, {
      index: 301,
      prevouts: merkle.prevouts,
      tree,
      leafIndex: 0,
      annex: ANNEX,
      previousTransactions: [funding],
    });
    expect(merkle.tx.ins[0]!.witness.at(-1)).toEqual(ANNEX);

    // The annex is signed: the same spend with another annex, or with the annex dropped, does not verify.
    const other = start(funding, 2, [64, script.length, 1, ANNEX.length]);
    const forAnnex = signTapscriptUnchecked(other.tx, 0, signer, { prevouts: other.prevouts, script, annex: ANNEX });
    other.tx.setWitness(0, scriptPathWitness([forAnnex], script, controlBlock(tree, true), Uint8Array.of(0x50, 0x00, 0x65, 0x61, 0x72, 0x6c)));
    expect(await testMempoolAccept(other.tx)).toMatchObject({ allowed: false, 'reject-reason': expect.stringMatching(SIGNATURE_REFUSED) });
    other.tx.setWitness(0, scriptPathWitness([forAnnex], script, controlBlock(tree, true)));
    expect(await testMempoolAccept(other.tx)).toMatchObject({ allowed: false, 'reject-reason': expect.stringMatching(SIGNATURE_REFUSED) });
    // And a signature made for no annex fails under one.
    const bare = signTapscriptUnchecked(other.tx, 0, signer, { prevouts: other.prevouts, script });
    other.tx.setWitness(0, scriptPathWitness([bare], script, controlBlock(tree, true), ANNEX));
    expect(await testMempoolAccept(other.tx)).toMatchObject({ allowed: false, 'reject-reason': expect.stringMatching(SIGNATURE_REFUSED) });

    await acceptAndMine([taproot, merkle], funding);
    for (const spend of [taproot, merkle]) {
      const input = inspectTransaction(spend.tx, spend.prevouts, network).inputs[0]!;
      expect(input.annex).toEqual(ANNEX);
      expect(input.spend).toMatchObject({ type: 'scriptPath', leaf: 'checksig' });
    }
  });

  it('pearld mines leaves with one and two code separators signed at the position each check runs under', async () => {
    const keys = [310, 311, 312].map((index) => account.derivePublicKey(index));
    const signers = [310, 311, 312].map((index) => account.tapscriptSigner({ index }));
    const one = compileScript([keys[0]!, OP_CODES.OP_CHECKSIGVERIFY, OP_CODES.OP_CODESEPARATOR, keys[1]!, OP_CODES.OP_CHECKSIG]);
    const two = compileScript([
      keys[0]!,
      OP_CODES.OP_CHECKSIGVERIFY,
      OP_CODES.OP_CODESEPARATOR,
      keys[1]!,
      OP_CODES.OP_CHECKSIGVERIFY,
      OP_CODES.OP_CODESEPARATOR,
      keys[2]!,
      OP_CODES.OP_CHECKSIG,
    ]);
    expect(codeSeparatorPositions(one)).toEqual([2]);
    expect(codeSeparatorPositions(two)).toEqual([2, 5]);

    const cases = [
      { script: one, isP2mr: true },
      { script: one, isP2mr: false },
      { script: two, isP2mr: true },
      { script: two, isP2mr: false },
    ].map((c) => ({ ...c, tree: assembleScriptTree([c.script]) }));
    const funding = await fund([...cases.map((c) => output(c.tree, c.isP2mr)), output(cases[2]!.tree, true)]);

    /** Signs check i of the leaf for the given separator positions; undefined is none. */
    const sign = (spend: Spend, script: Uint8Array, positions: (number | undefined)[]): Uint8Array[] =>
      positions
        .map((position, i) =>
          signTapscriptUnchecked(spend.tx, 0, signers[i]!, {
            prevouts: spend.prevouts,
            script,
            ...(position === undefined ? {} : { codeSeparatorPosition: position }),
          }),
        )
        // The first key is checked first, so its signature is on top.
        .reverse();

    const spends = cases.map(({ script, tree, isP2mr }, vout) => {
      const separators = codeSeparatorPositions(script);
      const spend = start(funding, vout, [...separators.map(() => 64), 64, script.length, isP2mr ? 1 : 33]);
      const stack = sign(spend, script, [undefined, ...separators]);
      spend.tx.setWitness(0, scriptPathWitness(stack, script, controlBlock(tree, isP2mr)));
      return spend;
    });

    // The position is signed: every other assignment of positions to the three checks fails.
    const wrong = start(funding, 4, [64, 64, 64, two.length, 1]);
    for (const positions of [
      [undefined, undefined, undefined],
      [undefined, 2, 2],
      [undefined, 5, 5],
      [2, 2, 5],
      [undefined, 2, undefined],
    ]) {
      wrong.tx.setWitness(0, scriptPathWitness(sign(wrong, two, positions), two, controlBlock(cases[2]!.tree, true)));
      expect(await testMempoolAccept(wrong.tx), String(positions)).toMatchObject({
        allowed: false,
        'reject-reason': expect.stringMatching(SIGNATURE_REFUSED),
      });
    }

    await acceptAndMine(spends, funding);
    for (const spend of spends) {
      expect(inspectTransaction(spend.tx, spend.prevouts, network).inputs[0]!.spend).toMatchObject({ type: 'scriptPath', leaf: 'other' });
    }
  });
});
