// The XMSS spend recorded on mainnet in pearl-research-labs/pearl#111,
// rebuilt byte for byte. It has a file of its own because its key is vector
// key a at index 0, which the vector spends also sign with, and signers in
// one process refuse a second message at a used index.

import { describe, expect, it } from 'vitest';
import {
  assembleScriptTree,
  createTransaction,
  createXmssSigner,
  p2mr,
  serializeTransaction,
  signXmssP2mrInput,
  transactionId,
  xmssKeygen,
  xmssLeafScript,
} from '../src/index.js';
import mainnetSpend from './fixtures/pr111-mainnet-xmss-spend.json' with { type: 'json' };
import { hexToBytes } from './vector-helpers.js';

describe('pearl-research-labs/pearl#111 mainnet spend', () => {
  it('rebuilds the recorded mainnet transaction byte for byte', async () => {
    const recorded = mainnetSpend;
    const keyA = createXmssSigner(
      hexToBytes(recorded.seedA.privateSeed),
      hexToBytes(recorded.seedA.publicSeed),
      { reserve: () => recorded.msgUid, peek: () => 0 },
    );
    const keyB = xmssKeygen(hexToBytes(recorded.seedB.privateSeed), hexToBytes(recorded.seedB.publicSeed));
    const treeA = assembleScriptTree([xmssLeafScript(keyA.publicKey)]);
    const treeB = assembleScriptTree([xmssLeafScript(keyB.publicKey)]);
    const scriptA = p2mr({ merkleRoot: treeA.root }).output;
    const scriptB = p2mr({ merkleRoot: treeB.root }).output;

    // xmsstxn.BuildSpend: version 2, one final-sequence input, one output.
    const tx = createTransaction(2);
    tx.addInput(hexToBytes(recorded.fundingTxid).reverse(), recorded.fundingVout, 0xffffffff);
    tx.addOutput(scriptB, BigInt(recorded.fundingValue - recorded.fee));
    await signXmssP2mrInput(tx, 0, keyA, {
      prevouts: [{ script: scriptA, value: BigInt(recorded.fundingValue) }],
      tree: treeA,
      leafIndex: 0,
      trustPrevouts: true, // the funding transaction itself is not in the fixture
    });

    expect(serializeTransaction(tx)).toBe(recorded.spendTxHex);
    expect(transactionId(tx)).toBe(recorded.spendTxid);
  });
});
