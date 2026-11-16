// Transaction inspection against spends Pearl signed for the vectors: each
// kind of input must be read back from its witness as what Go built, with
// the fee, sizes and addresses that follow from the prevouts. Coinbases are
// read from the blocks Go built: height, payout, witness commitment.

import { describe, expect, it } from 'vitest';
import {
  addressInfo,
  blockSubsidy,
  createTransaction,
  deriveSigningAccountFromSeed,
  embed,
  fromOutputScript,
  hash256,
  inspectTransaction,
  networks,
  parseBlock,
  parseTransaction,
  payFromAccount,
  toOutputScript,
  witnessCommitment,
  witnessTransactionId,
  xmssSign,
} from '../src/index.js';
import type { InputSpend, TxOutput } from '../src/index.js';
import vectors from '../vectors/pearl-go.json' with { type: 'json' };
import mainnetSpend from './fixtures/pr111-mainnet-xmss-spend.json' with { type: 'json' };
import { bytesToHex, hexToBytes } from './vector-helpers.js';

const network = networks.mainnet;
const prevoutsOf = (items: { script: string; value: number }[]): TxOutput[] =>
  items.map((item) => ({ script: hexToBytes(item.script), value: BigInt(item.value) }));

function scriptPath(spend: InputSpend): Extract<InputSpend, { type: 'scriptPath' }> {
  if (spend.type !== 'scriptPath') throw new Error(`expected a script path, got ${spend.type}`);
  return spend;
}

describe('inspectTransaction', () => {
  for (const vector of vectors.signing) {
    it(`reads the ${vector.name} key-path spend`, () => {
      const tx = parseTransaction(vector.finalTxHex);
      const prevouts = [{ script: hexToBytes(`5120${vector.tweakedPubKey}`), value: BigInt(vector.value) }];
      const info = inspectTransaction(tx, prevouts, network);
      expect(info.txid).toBe(vector.txid);
      expect(info.inputs[0]!.spend).toEqual({ type: 'keyPath', sighashType: vector.hashType });
      expect(info.inputs[0]!.value).toBe(BigInt(vector.value));
      expect(toOutputScript(info.inputs[0]!.address!, network)).toEqual(prevouts[0]!.script);
    });
  }

  for (const vector of vectors.scriptPathSpends) {
    it(`reads the ${vector.name} script-path spend`, () => {
      const tx = parseTransaction(vector.finalTxHex);
      const info = inspectTransaction(tx, prevoutsOf(vector.prevouts), network);
      const spend = scriptPath(info.inputs[vector.inputIndex]!.spend);
      expect(spend.p2mr).toBe(vector.kind === 'p2mr');
      expect(spend.leaf).toBe('checksig');
      expect(bytesToHex(spend.script)).toBe(vector.leafScript);
      expect(bytesToHex(spend.leafHash)).toBe(vector.leafHash);
      expect(bytesToHex(spend.controlBlock)).toBe(vector.controlBlock);
      expect(bytesToHex(spend.keys[0]!)).toBe(vector.leafScript.slice(2, 66));
      expect(spend.stack.map(bytesToHex)).toEqual([vector.signature]);
      expect(spend.commits).toBe(true);
      expect(spend.internalPubkey === undefined).toBe(vector.kind === 'p2mr');
      expect(info.wtxid).toBe(vector.wtxid);
      info.inputs.forEach((input, i) => {
        if (i !== vector.inputIndex) expect(input.spend.type).toBe('keyPath');
      });
    });
  }

  for (const vector of vectors.multiASpends) {
    it(`reads the multi_a spend ${vector.name}`, () => {
      const info = inspectTransaction(parseTransaction(vector.finalTxHex), prevoutsOf(vector.prevouts), network);
      const spend = scriptPath(info.inputs[0]!.spend);
      expect(spend.leaf).toBe('multiA');
      expect(spend.p2mr).toBe(false);
      expect(spend.threshold).toBe(vector.threshold);
      expect(spend.keys.length).toBe(vector.keyIndices.length);
      expect(bytesToHex(spend.internalPubkey!)).toBe(vector.internalPubKey);
      // The vector's lengths end with the leaf script and control block.
      expect(spend.stack.map((item) => item.length)).toEqual(vector.witnessLengths.slice(0, -2));
      expect(spend.commits).toBe(true);
    });
  }

  for (const vector of vectors.xmss.spends) {
    it(`reads the XMSS spend ${vector.name}`, () => {
      const info = inspectTransaction(parseTransaction(vector.finalTxHex), prevoutsOf(vector.prevouts), network);
      const spend = scriptPath(info.inputs[vector.inputIndex]!.spend);
      expect(spend.leaf).toBe('xmss');
      expect(spend.p2mr).toBe(true);
      expect(bytesToHex(spend.script)).toBe(vector.leafScripts[vector.leafIndex]);
      expect(bytesToHex(spend.keys[0]!)).toBe(vectors.xmss.keys.find((key) => key.name === vector.key)!.publicKey);
      expect(spend.stack.map(bytesToHex).join('')).toBe(vector.signature);
      expect(spend.commits).toBe(true);
    });
  }

  it('reports the fee and size of the XMSS spend Pearl recorded on mainnet', () => {
    const tx = parseTransaction(mainnetSpend.spendTxHex);
    const funded = { script: new Uint8Array(34), value: BigInt(mainnetSpend.fundingValue) };
    const info = inspectTransaction(tx, [funded], network);
    expect(info.txid).toBe(mainnetSpend.spendTxid);
    expect(info.fee).toBe(BigInt(mainnetSpend.fee));
    expect(info.vsize).toBe(tx.virtualSize());
    expect(info.feeRate).toBe((50000n * 1000n) / BigInt(tx.virtualSize()));
    expect(info.inputs[0]!.txid).toBe(mainnetSpend.fundingTxid);
    expect(info.inputs[0]!.vout).toBe(mainnetSpend.fundingVout);
    // The prevout script here is a placeholder, so nothing can be said of the witness.
    expect(info.inputs[0]!.spend).toEqual({ type: 'unknown' });
    expect(info.inputs[0]!.address).toBeNull();
  });

  it('reports a payment it built, addresses and replace-by-fee included', () => {
    const account = deriveSigningAccountFromSeed(hexToBytes(vectors.bip86.seed), networks.regtest);
    const utxo = {
      txid: '5a'.repeat(32), vout: 3, value: 1_000_000n, confirmations: 1, index: 4,
      script: toOutputScript(account.deriveAddress(4), networks.regtest),
    };
    const options = {
      network: networks.regtest,
      utxos: [utxo],
      recipients: [{ address: account.deriveAddress(9), amount: 250_000n }],
      feeRate: 3000n,
      changeAddress: account.deriveAddress(2, true),
    };
    const payment = payFromAccount(account, { ...options, rbf: true });
    const info = inspectTransaction(payment.transaction, payment.prevouts, networks.regtest);
    expect(info).toMatchObject({
      txid: payment.txid,
      wtxid: witnessTransactionId(payment.transaction),
      version: 1,
      locktime: 0,
      size: payment.hex.length / 2,
      weight: payment.transaction.weight(),
      vsize: payment.vsize,
      fee: payment.fee,
      rbf: true,
    });
    // Oyster's fee is for 155 vbytes and the signed transaction has 154.
    expect(info.fee).toBe(465n);
    expect(info.feeRate).toBe((465n * 1000n) / 154n);
    expect(info.inputs).toEqual([
      {
        txid: utxo.txid, vout: 3, sequence: 0xfffffffd, value: 1_000_000n, script: utxo.script,
        address: account.deriveAddress(4), spend: { type: 'keyPath', sighashType: 0 },
      },
    ]);
    expect(info.outputs.map((output) => [output.address, output.value, output.type])).toEqual([
      [account.deriveAddress(9), 250_000n, 'p2tr'],
      [account.deriveAddress(2, true), 1_000_000n - 250_000n - 465n, 'p2tr'],
    ]);
    expect(inspectTransaction(payFromAccount(account, options).transaction, payment.prevouts, networks.regtest).rbf).toBe(false);
  });

  it('names P2MR and OP_RETURN outputs', () => {
    const vector = vectors.coinSelection.cases.find((item) => item.name === 'several outputs with P2MR and OP_RETURN')!;
    const tx = parseTransaction(vector.unsignedTxHex);
    const prevouts = vector.inputs.map((id) => {
      const coin = vector.coins.find((item) => `${item.txid}:${item.vout}` === id)!;
      return { script: hexToBytes(coin.script), value: BigInt(coin.value) };
    });
    const info = inspectTransaction(tx, prevouts, network);
    expect(info.outputs.map((output) => output.type)).toEqual(['p2tr', 'p2mr', 'nulldata', 'p2tr']);
    expect(addressInfo(info.outputs[1]!.address!)).toMatchObject({ type: 'p2mr', networks: ['mainnet'] });
    expect(toOutputScript(info.outputs[1]!.address!, network)).toEqual(tx.outs[1]!.script);
    expect(info.outputs[2]!.address).toBeNull();
    expect(info.fee).toBe(BigInt(vector.fee));
    expect(info.inputs.every((input) => input.spend.type === 'unsigned')).toBe(true);
    expect(info.rbf).toBe(false);
  });

  it('says when a control block does not open the spent output', () => {
    const vector = vectors.scriptPathSpends.find((item) => item.name === 'p2mr-3-leaves-middle-all-anyonecanpay')!;
    const prevouts = prevoutsOf(vector.prevouts);
    const other = { ...prevouts[vector.inputIndex]!, script: hexToBytes(`5220${'99'.repeat(32)}`) };
    const info = inspectTransaction(parseTransaction(vector.finalTxHex), prevouts.map((p, i) => (i === vector.inputIndex ? other : p)), network);
    expect(scriptPath(info.inputs[vector.inputIndex]!.spend).commits).toBe(false);
  });

  it('sets an annex aside before reading the witness', () => {
    const vector = vectors.scriptPathSpends.find((item) => item.name === 'p2tr-1-leaf-default')!;
    const tx = parseTransaction(vector.finalTxHex);
    const annex = Uint8Array.from([0x50, 1, 2, 3]);
    tx.setWitness(vector.inputIndex, [...tx.ins[vector.inputIndex]!.witness, annex]);
    const input = inspectTransaction(tx, prevoutsOf(vector.prevouts), network).inputs[vector.inputIndex]!;
    expect(input.annex).toEqual(annex);
    expect(bytesToHex(scriptPath(input.spend).script)).toBe(vector.leafScript);
  });

  it('calls a witness it cannot place unknown', () => {
    const vector = vectors.signing[0]!;
    const tx = parseTransaction(vector.finalTxHex);
    const p2trPrevout = { script: hexToBytes(`5120${vector.tweakedPubKey}`), value: BigInt(vector.value) };
    const p2mrPrevout = { script: hexToBytes(`5220${vector.tweakedPubKey}`), value: BigInt(vector.value) };
    // A P2MR output has no key path.
    expect(inspectTransaction(tx, [p2mrPrevout], network).inputs[0]!.spend).toEqual({ type: 'unknown' });
    tx.setWitness(0, [new Uint8Array(63)]);
    expect(inspectTransaction(tx, [p2trPrevout], network).inputs[0]!.spend).toEqual({ type: 'unknown' });
    tx.setWitness(0, [new Uint8Array(64), new Uint8Array(34), new Uint8Array(20)]);
    expect(inspectTransaction(tx, [p2trPrevout], network).inputs[0]!.spend).toEqual({ type: 'unknown' });
  });

  it('refuses prevouts that do not fit the transaction', () => {
    const vector = vectors.signing[0]!;
    const tx = parseTransaction(vector.finalTxHex);
    expect(() => inspectTransaction(tx, [], network)).toThrow(/prevouts must match/);
    expect(() => inspectTransaction(tx, [{ script: hexToBytes(`5120${vector.tweakedPubKey}`), value: 1n }], network)).toThrow(/worth less/);
  });
});

describe('inspectTransaction on a coinbase', () => {
  const blockOf = (name: string) => parseBlock(hexToBytes(vectors.blocks.find((item) => item.name === name)!.hex));
  // generate.go numbers its synthetic blocks from height 100 and pays 50 PRL to one P2TR output.
  const synthetic = vectors.blocks.filter((item) => !item.name.endsWith('-genesis'));

  synthetic.forEach((vector, i) => {
    it(`reads the coinbase of ${vector.name}`, () => {
      const block = blockOf(vector.name);
      const tx = block.transactions[0]!;
      const info = inspectTransaction(tx, [], networks.regtest);
      expect(info.txid).toBe(vector.txids[0]);
      // pearld shows a coinbase's own witness hash, not the zeros that stand for it in the witness merkle tree.
      expect(info.wtxid).toBe(bytesToHex(hash256(tx.toBuffer()).reverse()));
      expect(info.wtxid === info.txid).toBe(tx.ins[0]!.witness.length === 0);
      expect(info.fee).toBe(0n);
      expect(info.feeRate).toBe(0n);
      expect(info.rbf).toBe(false);
      expect(info.inputs).toEqual([
        { txid: '00'.repeat(32), vout: 0xffffffff, sequence: tx.ins[0]!.sequence, value: 0n, script: new Uint8Array(0), address: null, spend: { type: 'coinbase' } },
      ]);
      const coinbase = info.coinbase!;
      expect(coinbase.height).toBe(100 + i);
      expect(coinbase.script).toEqual(tx.ins[0]!.script);
      expect(coinbase.reward).toBe(50_0000_0000n);
      expect(coinbase.subsidy).toBe(blockSubsidy(networks.regtest, 100 + i));
      expect(coinbase.fees).toBeUndefined();
      expect(coinbase.unclaimed).toBeUndefined();
      expect(info.outputs[0]).toMatchObject({ type: 'p2tr', value: 50_0000_0000n, address: fromOutputScript(tx.outs[0]!.script, networks.regtest) });
      // block.ts finds the commitment on its own; both must name the same bytes.
      const commitment = witnessCommitment(block);
      expect(coinbase.witnessCommitment).toEqual(commitment);
      expect(coinbase.witnessCommitmentIndex).toBe(commitment === null ? -1 : 1);
    });
  });

  it('holds the reward against the subsidy and the fees of the block', () => {
    const tx = blockOf('v3-four-spends').transactions[0]!;
    const subsidy = blockSubsidy(networks.regtest, 104);
    const info = inspectTransaction(tx, [], networks.regtest, { blockFees: 1234n });
    expect(info.coinbase).toMatchObject({ height: 104, subsidy, fees: 1234n, unclaimed: subsidy + 1234n - 50_0000_0000n });
    const greedy = inspectTransaction(tx, [], networks.regtest, { blockFees: 50_0000_0000n - subsidy - 1n });
    expect(greedy.coinbase!.unclaimed).toBe(-1n);
  });

  for (const name of ['mainnet', 'testnet', 'testnet2', 'regtest', 'simnet'] as const) {
    it(`finds no height in the ${name} genesis coinbase, and takes one from the options`, () => {
      const tx = blockOf(`${name}-genesis`).transactions[0]!;
      const info = inspectTransaction(tx, [], networks[name]);
      expect(info.coinbase).toMatchObject({ height: null, witnessCommitment: null, witnessCommitmentIndex: -1 });
      expect(info.coinbase!.subsidy).toBeUndefined();
      expect(inspectTransaction(tx, [], networks[name], { height: 0, blockFees: 0n }).coinbase).toMatchObject({ subsidy: 0n, unclaimed: -info.coinbase!.reward });
    });
  }

  it('reads heights as the script builder writes them and refuses any other encoding', () => {
    const at = (script: number[]): number | null => {
      const tx = createTransaction(1);
      tx.addInput(new Uint8Array(32), 0xffffffff, 0xffffffff, Uint8Array.from(script));
      tx.addOutput(hexToBytes(`5120${'11'.repeat(32)}`), 1n);
      return inspectTransaction(tx, [], networks.regtest).coinbase!.height;
    };
    expect(at([0x00])).toBe(0);
    expect(at([0x51])).toBe(1);
    expect(at([0x60, 0xff])).toBe(16);
    expect(at([0x01, 0x11])).toBe(17);
    expect(at([0x01, 0x7f])).toBe(127);
    // 128 needs a second byte to keep the sign bit clear.
    expect(at([0x02, 0x80, 0x00])).toBe(128);
    expect(at([0x01, 0x80])).toBeNull();
    expect(at([0x03, 0xa0, 0x86, 0x01, 0x07])).toBe(100_000);
    expect(at([0x04, 0xff, 0xff, 0xff, 0x7f])).toBe(0x7fffffff);
    // Not minimal, a small number as a push, a negative number, a push that runs past the end.
    expect(at([0x02, 0x64, 0x00])).toBeNull();
    expect(at([0x01, 0x05])).toBeNull();
    expect(at([0x04, 0xff, 0xff, 0x00, 0x9d])).toBeNull();
    expect(at([0x04, 0xfe, 0xff, 0x00, 0x1d])).toBe(0x1d00fffe);
    expect(at([0x03, 0x01])).toBeNull();
    expect(at([0x05, 1, 2, 3, 4, 5])).toBeNull();
    expect(at([])).toBeNull();
  });

  it('refuses prevouts for a coinbase and a wrong count for anything else', () => {
    const block = blockOf('v1-one-spend');
    const prevout = { script: new Uint8Array(0), value: 0n };
    expect(() => inspectTransaction(block.transactions[0]!, [prevout], networks.regtest)).toThrow(
      expect.objectContaining({ code: 'INSPECT_PREVOUTS', message: 'a coinbase transaction spends nothing: pass no prevouts' }),
    );
    expect(() => inspectTransaction(block.transactions[1]!, [], networks.regtest)).toThrow(
      expect.objectContaining({ code: 'INSPECT_PREVOUTS', message: 'prevouts must match the transaction inputs' }),
    );
    expect(() => inspectTransaction(block.transactions[1]!, [prevout], networks.regtest)).toThrow(
      expect.objectContaining({ code: 'INSPECT_PREVOUTS', message: 'the prevouts are worth less than the transaction spends' }),
    );
  });
});

describe('inspectTransaction details an explorer shows', () => {
  for (const vector of vectors.xmss.spends) {
    it(`reports the one-time index of the XMSS spend ${vector.name}`, () => {
      const info = inspectTransaction(parseTransaction(vector.finalTxHex), prevoutsOf(vector.prevouts), network);
      const spend = scriptPath(info.inputs[vector.inputIndex]!.spend);
      expect(spend.xmssIndex).toBe({ a: 0, b: 3, c: 30 }[vector.key]);
    });
  }

  it('reports the index a signature made here was given', () => {
    const vector = vectors.xmss.spends[0]!;
    const key = vectors.xmss.keys.find((item) => item.name === vector.key)!;
    const tx = parseTransaction(vector.finalTxHex);
    const witness = tx.ins[vector.inputIndex]!.witness;
    for (const index of [17]) {
      const signature = xmssSign(hexToBytes(key.secretKey), index, new Uint8Array(32).fill(index));
      tx.setWitness(vector.inputIndex, [...[0, 1, 2, 3, 4].map((i) => signature.slice(i * 468, (i + 1) * 468)), ...witness.slice(-2)]);
      expect(scriptPath(inspectTransaction(tx, prevoutsOf(vector.prevouts), network).inputs[vector.inputIndex]!.spend).xmssIndex).toBe(index);
    }
  });

  it('reports no XMSS index for a stack that is not one whole signature, or for another leaf', () => {
    const vector = vectors.xmss.spends[0]!;
    const tx = parseTransaction(vector.finalTxHex);
    const witness = tx.ins[vector.inputIndex]!.witness;
    tx.setWitness(vector.inputIndex, [witness[0]!.slice(1), ...witness.slice(1)]);
    expect(scriptPath(inspectTransaction(tx, prevoutsOf(vector.prevouts), network).inputs[vector.inputIndex]!.spend).xmssIndex).toBeUndefined();
    const checksig = vectors.scriptPathSpends[0]!;
    const other = inspectTransaction(parseTransaction(checksig.finalTxHex), prevoutsOf(checksig.prevouts), network);
    expect('xmssIndex' in scriptPath(other.inputs[checksig.inputIndex]!.spend)).toBe(false);
  });

  it('reports what an OP_RETURN output carries when it is a single push', () => {
    const dataOf = (script: Uint8Array): Uint8Array | undefined => {
      const tx = createTransaction(2);
      tx.addInput(new Uint8Array(32).fill(7), 0);
      tx.addOutput(script, 0n);
      return inspectTransaction(tx, [{ script: hexToBytes(`5120${'22'.repeat(32)}`), value: 1000n }], network).outputs[0]!.data;
    };
    const payload = new Uint8Array(80).map((_, i) => i);
    expect(dataOf(embed({ data: payload.slice(0, 5) }).output)).toEqual(payload.slice(0, 5));
    expect(dataOf(embed({ data: payload }).output)).toEqual(payload);
    expect(dataOf(embed({ data: new Uint8Array(0) }).output)).toEqual(new Uint8Array(0));
    // A bare OP_RETURN, two pushes, and a push that claims more than is there.
    expect(dataOf(Uint8Array.from([0x6a]))).toBeUndefined();
    expect(dataOf(Uint8Array.from([0x6a, 0x01, 0xaa, 0x01, 0xbb]))).toBeUndefined();
    expect(dataOf(Uint8Array.from([0x6a, 0x05, 0xaa]))).toBeUndefined();
    expect(dataOf(Uint8Array.from([0x6a, 0x4c]))).toBeUndefined();
  });
});
