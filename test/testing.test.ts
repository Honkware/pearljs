// The simulated chain of pearljs/testing on its own: that its blocks are
// ones Pearl's block checks pass, that its mempool refuses what pearld's
// refuses with pearld's code and text, and that mining, maturity, reorgs,
// double spends and the clock do what a test asks of them.

import { describe, expect, it } from 'vitest';
import {
  PearlError,
  PearlRpcError,
  addInputByTxid,
  blockHashHex,
  blockSubsidy,
  checkCertificateBinding,
  checkCertificateRules,
  checkMerkleRoot,
  checkWitnessCommitment,
  createPsbt,
  createTransaction,
  customNetwork,
  deriveSigningAccountFromSeed,
  encodeSequence,
  finalizePsbt,
  inspectTransaction,
  mnemonicToSeed,
  networks,
  parseBlock,
  parsePearl,
  payFromAccount,
  serializeBlock,
  toOutputScript,
  verifyTransaction,
} from '../src/index.js';
import type { PearlNetworkName, PearlSigningAccount, Transaction, WalletUtxo } from '../src/index.js';
import { FAUCET_MNEMONIC, SimulatedChain, TEST_MNEMONIC, testAccount, testAddress, testKey, testMnemonic, testXmssSeeds } from '../src/testing.js';
import { GENESIS_BLOCKS } from '../src/testing/genesis.js';
import vectors from '../vectors/pearl-go.json' with { type: 'json' };
import { bytesToHex as toHex } from './vector-helpers.js';

const prl = parsePearl;
// Five blocks to maturity keeps the chains here short; the rule is the network's own.
const quick = customNetwork(networks.regtest, { coinbaseMaturity: 5 });
const small = (): SimulatedChain => new SimulatedChain({ network: quick });
const alice = testAccount(0);
const bob = testAccount(1);

/** A key-path spend of one coin of an account's child, with whatever sequence and locktime the test needs. */
function spend(
  account: PearlSigningAccount,
  coin: WalletUtxo,
  options: { index?: number; to?: string; amount?: bigint; fee?: bigint; sequence?: number; locktime?: number; version?: number } = {},
): Transaction {
  const fee = options.fee ?? 500n;
  const amount = options.amount ?? coin.value - fee;
  const tx = createTransaction(options.version ?? 2);
  addInputByTxid(tx, coin.txid, coin.vout, options.sequence ?? 0xffffffff);
  tx.addOutput(toOutputScript(options.to ?? bob.deriveAddress(0), networks.regtest), amount);
  if (coin.value - amount - fee > 0n) tx.addOutput(coin.script, coin.value - amount - fee);
  tx.locktime = options.locktime ?? 0;
  const psbt = createPsbt(tx);
  account.prepareInput(psbt, 0, { index: options.index ?? 0, value: coin.value });
  account.signInput(psbt, 0, { index: options.index ?? 0 });
  return finalizePsbt(psbt);
}

/** The PearlRpcError a call throws, or a failure of the test. */
function refusal(run: () => unknown): PearlRpcError {
  try {
    run();
  } catch (err) {
    expect(err).toBeInstanceOf(PearlRpcError);
    return err as PearlRpcError;
  }
  throw new Error('expected the chain to refuse');
}

describe('the blocks of a simulated chain', () => {
  for (const name of Object.keys(networks) as PearlNetworkName[]) {
    it(`starts ${name} at the network's real genesis block`, () => {
      expect(GENESIS_BLOCKS[name]).toBe(vectors.blocks.find((block) => block.name === `${name}-genesis`)!.hex);
      const chain = new SimulatedChain({ network: networks[name], premine: 2 });
      expect(chain.blocks[0]!.hash).toBe(networks[name].genesisHash);
      expect(chain.blocks[1]!.parent).toBe(networks[name].genesisHash);
      expect(chain.faucet.address.startsWith(`${networks[name].bech32Hrp}1p`)).toBe(true);
    });
  }

  it('mines blocks that pass every block check pearljs has, at each certificate version', () => {
    // Forks at heights 3 and 6 put V1, V2 and V3 certificates in one short chain.
    const forked = customNetwork(quick, { forkHeights: { moe: 3, saltedSeed: 6, denseOnly: 0, rankPenalty: 0 } });
    const chain = new SimulatedChain({ network: forked, premine: 8 });
    chain.pay(alice.deriveAddress(0), prl('1'));
    chain.mine();
    expect(chain.blocks.map((block) => block.block.certificate?.version)).toEqual([1, 1, 1, 2, 2, 2, 3, 3, 3, 3]);
    chain.blocks.slice(1).forEach((block, i) => {
      const height = i + 1;
      // Through bytes and back, as an explorer reads a block from getblock.
      const parsed = parseBlock(serializeBlock(block.block));
      expect(blockHashHex(parsed.header)).toBe(block.hash);
      expect(block.height).toBe(height);
      expect(toHex(parsed.header.prevBlock.slice().reverse())).toBe(chain.blocks[height - 1]!.hash);
      expect(parsed.header.bits).toBe(forked.powLimitBits);
      expect(parsed.header.timestamp).toBe(block.time);
      checkMerkleRoot(parsed);
      checkWitnessCommitment(parsed);
      checkCertificateBinding(parsed);
      checkCertificateRules(parsed.certificate, forked, height);
      const coinbase = inspectTransaction(parsed.transactions[0]!, [], forked, { blockFees: block.fees }).coinbase!;
      expect(coinbase).toMatchObject({ height, subsidy: blockSubsidy(forked, height), unclaimed: 0n });
      expect(coinbase.witnessCommitment).not.toBeNull();
      for (const tx of parsed.transactions.slice(1)) expect(verifyTransaction(tx, chain.prevouts(tx)!)).toEqual({ ok: true });
    });
    expect(chain.tip.txs).toHaveLength(2);
    expect(chain.tip.fees).toBeGreaterThan(0n);
  });

  it('is the same chain on every run, and another one for another start time', () => {
    const hashes = (chain: SimulatedChain): string[] => chain.blocks.map((block) => block.hash);
    const run = (): SimulatedChain => {
      const chain = small();
      chain.pay(alice.deriveAddress(0), prl('2'));
      chain.mine(2);
      return chain;
    };
    expect(hashes(run())).toEqual(hashes(run()));
    expect(hashes(new SimulatedChain({ network: quick, time: 1_900_000_000 }))[1]).not.toBe(hashes(small())[1]);
  });

  it('pays the coinbase where a test says and the rest to the faucet, and refuses one that claims too much', () => {
    const chain = small();
    const [ref] = chain.mine(1, { coinbaseTo: alice.deriveAddress(0), value: prl('50') });
    const coinbase = chain.tip.txs[0]!;
    expect(ref).toEqual({ height: chain.height, hash: chain.tip.hash });
    expect(coinbase.outs[0]).toMatchObject({ value: prl('50') });
    expect(coinbase.outs.reduce((sum, out) => sum + out.value, 0n)).toBe(blockSubsidy(quick, chain.height));
    const before = chain.height;
    expect(() => chain.mine(1, { coinbaseTo: alice.deriveAddress(0), value: blockSubsidy(quick, before + 1) + 1n })).toThrow(
      expect.objectContaining({ code: 'SIMULATION_INVALID' }),
    );
    expect(chain.height).toBe(before);
  });
});

describe('confirmations and coinbase maturity', () => {
  it('counts confirmations from the tip and marks coinbase outputs', async () => {
    const chain = small();
    const address = alice.deriveAddress(0);
    const paid = chain.pay(address, prl('3'));
    expect(await chain.getUtxos([address])).toMatchObject([{ txid: paid.getId(), vout: 0, value: prl('3'), confirmations: 0, coinbase: false, address }]);
    expect(await chain.getBalance([address])).toEqual({ confirmed: 0n, unconfirmed: prl('3'), immature: 0n });
    chain.mine();
    expect((await chain.getUtxos([address]))[0]!.confirmations).toBe(1);
    chain.mine(4);
    expect((await chain.getUtxos([address]))[0]!.confirmations).toBe(5);
    expect(await chain.getBalance([address])).toEqual({ confirmed: prl('3'), unconfirmed: 0n, immature: 0n });
    expect(await chain.getTransaction(paid.getId())).toEqual({ txid: paid.getId(), block: { height: chain.height - 4, hash: chain.blocks[chain.height - 4]!.hash, time: chain.blocks[chain.height - 4]!.time } });
  });

  it('holds a coinbase output back until the network says it is mature, in the balance and in the mempool', async () => {
    const chain = small();
    const address = alice.deriveAddress(0);
    chain.mine(1, { coinbaseTo: address, value: prl('50') });
    const [coin] = await chain.getUtxos([address]);
    expect(coin).toMatchObject({ coinbase: true, confirmations: 1 });
    expect(await chain.getBalance([address])).toEqual({ confirmed: 0n, unconfirmed: 0n, immature: prl('50') });
    const early = spend(alice, coin!);
    const minedAt = chain.height;
    chain.mine(3);
    // Four confirmations: the next block would be the fifth since the coinbase, one short of five blocks after it.
    const err = refusal(() => chain.accept(early));
    expect(err.rpcCode).toBe(-26);
    expect(err.message).toContain(
      `TX rejected: tried to spend coinbase transaction output ${coin!.txid}:0 from height ${minedAt} at height ${chain.height + 1} before required maturity of 5 blocks`,
    );
    expect(() => chain.mine(1, { include: [early] })).toThrow(/before required maturity/);
    chain.mine();
    expect(await chain.getBalance([address])).toEqual({ confirmed: prl('50'), unconfirmed: 0n, immature: 0n });
    expect(chain.accept(early)).toBe(early.getId());
  });

  it('uses the maturity of the network it was given', () => {
    const chain = new SimulatedChain({ premine: 100 });
    expect(chain.network.coinbaseMaturity).toBe(100);
    // The block after the hundredth is the first that may spend the first coinbase.
    expect(chain.faucet.balance()).toBe(blockSubsidy(networks.regtest, 1));
    chain.mine();
    expect(chain.faucet.balance()).toBe(blockSubsidy(networks.regtest, 1) + blockSubsidy(networks.regtest, 2));
  });
});

describe('the simulated mempool', () => {
  const funded = (): { chain: SimulatedChain; coin: WalletUtxo } => {
    const chain = small();
    return { chain, coin: chain.fund(alice.deriveAddress(0), prl('10')) };
  };

  it('accepts a signed payment and reports its fee and size before and after', () => {
    const { chain, coin } = funded();
    const tx = spend(alice, coin, { amount: prl('4'), fee: 700n });
    expect(chain.check(tx)).toEqual({ txid: tx.getId(), fee: 700n, vsize: tx.virtualSize(), evicts: [] });
    expect(chain.mempool.has(tx.getId())).toBe(false);
    expect(chain.accept(tx.toHex())).toBe(tx.getId());
    expect(chain.mempool.get(tx.getId())).toMatchObject({ fee: 700n, vsize: tx.virtualSize(), height: chain.height, time: chain.time });
    expect(chain.spender(coin.txid, coin.vout)).toEqual({ txid: tx.getId(), confirmed: false });
    chain.mine();
    expect(chain.mempool.size).toBe(0);
    expect(chain.spender(coin.txid, coin.vout)).toEqual({ txid: tx.getId(), confirmed: true });
    expect(chain.tip.fees).toBe(700n);
  });

  it('refuses what pearld refuses, with its code and text', () => {
    const { chain, coin } = funded();
    const good = spend(alice, coin, { amount: prl('4') });
    const cases: [string, Transaction, number, string][] = [
      ['a signature by the wrong key', spend(bob, coin), -26, 'TX rejected: failed to validate input'],
      ['an output below the dust threshold', spend(alice, coin, { amount: 100n }), -26, 'TX rejected: transaction output 0: payment is dust: 100'],
      ['a fee under the relay minimum', spend(alice, coin, { fee: 10n }), -26, 'which is under the required amount of'],
      ['more out than in', spend(alice, { ...coin, value: coin.value + 1n }, { fee: 0n }), -26, 'TX rejected: total value of all transaction inputs'],
      ['version 3', spend(alice, coin, { version: 3 }), -26, 'TX rejected: transaction version 3 is not in the valid range of 1-2'],
      ['an input nobody has seen', spend(alice, { ...coin, txid: 'ab'.repeat(32) }), -25, `references outputs of unknown or fully-spent transaction ${'ab'.repeat(32)}`],
      ['a lock time in the future', spend(alice, coin, { locktime: 10_000, sequence: 0xfffffffe }), -26, 'TX rejected: transaction is not finalized'],
    ];
    for (const [name, tx, code, text] of cases) {
      const err = refusal(() => chain.accept(tx));
      expect(err.rpcCode, name).toBe(code);
      expect(err.message, name).toContain(text);
      expect(err.code).toBe('RPC_ERROR');
      expect(err.method).toBe('sendrawtransaction');
      // check says the same without the prefix sendrawtransaction adds.
      expect(refusal(() => chain.check(tx)).message, name).toContain(text.replace('TX rejected: ', ''));
    }
    expect(chain.mempool.size).toBe(0);

    chain.accept(good);
    const twice = refusal(() => chain.accept(good));
    expect([twice.rpcCode, twice.message]).toEqual([-26, `sendrawtransaction: TX rejected: already have transaction in mempool ${good.getId()} (code -26)`]);
    chain.mine();
    const again = refusal(() => chain.accept(good));
    expect([again.rpcCode, again.message]).toEqual([-27, 'sendrawtransaction: TX rejected: transaction already exists in blockchain (code -27)']);
    expect(refusal(() => chain.accept('zz')).rpcCode).toBe(-22);
    expect(refusal(() => chain.accept(chain.tip.txs[0]!)).message).toContain('transaction is an individual coinbase');
  });

  it('applies the replacement rules: only a signalling transaction is replaced, and only for more fee', () => {
    const { chain, coin } = funded();
    const stubborn = spend(alice, coin, { amount: prl('4') });
    chain.accept(stubborn);
    const rival = spend(alice, coin, { amount: prl('5'), fee: 5000n });
    expect(refusal(() => chain.accept(rival)).message).toContain(`TX rejected: output already spent in mempool: output=${coin.txid}:${coin.vout}, tx=${stubborn.getId()}`);
    chain.drop(stubborn.getId());

    const first = spend(alice, coin, { amount: prl('4'), sequence: 0xfffffffd });
    chain.accept(first);
    const child = spend(bob, { txid: first.getId(), vout: 0, value: prl('4'), script: first.outs[0]!.script, address: bob.deriveAddress(0), confirmations: 0, coinbase: false }, { to: alice.deriveAddress(1) });
    chain.accept(child);
    const cheap = spend(alice, coin, { amount: prl('5'), fee: 600n, sequence: 0xfffffffd });
    expect(refusal(() => chain.accept(cheap)).rpcCode).toBe(-26);
    const removed: string[] = [];
    chain.subscribe((event) => event.type === 'removed' && removed.push(event.txid));
    const better = spend(alice, coin, { amount: prl('5'), fee: 5000n, sequence: 0xfffffffd });
    expect(chain.check(better).evicts.sort()).toEqual([first.getId(), child.getId()].sort());
    chain.accept(better);
    expect([...chain.mempool.keys()]).toEqual([better.getId()]);
    expect(removed.sort()).toEqual([first.getId(), child.getId()].sort());

    const strict = new SimulatedChain({ network: quick, rejectReplacement: true });
    const held = strict.fund(alice.deriveAddress(0), prl('10'));
    strict.accept(spend(alice, held, { amount: prl('4'), sequence: 0xfffffffd }));
    expect(refusal(() => strict.accept(spend(alice, held, { amount: prl('5'), fee: 5000n }))).rpcCode).toBe(-26);
  });

  it('stops a chain of unconfirmed transactions at 25', () => {
    const { chain, coin } = funded();
    let last: WalletUtxo = coin;
    for (let i = 0; i < 25; i += 1) {
      const tx = spend(alice, last, { to: alice.deriveAddress(0) });
      chain.accept(tx);
      last = { ...last, txid: tx.getId(), vout: 0, value: tx.outs[0]!.value };
    }
    expect(refusal(() => chain.accept(spend(alice, last, { to: alice.deriveAddress(0) }))).message).toContain('too-long-mempool-chain');
    chain.mine();
    expect(chain.tip.txs).toHaveLength(26);
    expect(chain.accept(spend(alice, last, { to: alice.deriveAddress(0) }))).toHaveLength(64);
  });

  it('enforces relative lock times by height and by time', () => {
    const { chain, coin } = funded();
    const afterThree = spend(alice, coin, { sequence: encodeSequence({ blocks: 3 }) });
    expect(refusal(() => chain.accept(afterThree)).message).toContain("TX rejected: transaction's sequence locks on inputs not met");
    chain.mine();
    expect(() => chain.check(afterThree)).toThrow(/sequence locks/);
    expect(() => chain.mine(1, { include: [afterThree] })).toThrow(/sequence locks/);
    chain.mine();
    // The coin has three confirmations, so the next block is the third after its own.
    expect(chain.accept(afterThree)).toBe(afterThree.getId());
    // Version 1 transactions carry no relative locks.
    const other = chain.fund(alice.deriveAddress(1), prl('1'));
    expect(chain.check(spend(alice, other, { index: 1, version: 1, sequence: encodeSequence({ blocks: 50 }) })).fee).toBe(500n);

    const timed = chain.fund(alice.deriveAddress(2), prl('1'));
    const afterAnHour = spend(alice, timed, { index: 2, sequence: encodeSequence({ seconds: 3584 }) });
    expect(() => chain.check(afterAnHour)).toThrow(/sequence locks/);
    // The lock counts from the median time before the coin's block; six blocks move the median of eleven.
    chain.advanceTime(4000);
    chain.mine(5);
    expect(() => chain.check(afterAnHour)).toThrow(/sequence locks/);
    chain.mine(1);
    expect(chain.check(afterAnHour).fee).toBe(500n);
  });

  it('lets an absolute lock time in once the chain has reached it', () => {
    const { chain, coin } = funded();
    const atHeight = spend(alice, coin, { locktime: chain.height + 2, sequence: 0xfffffffe });
    expect(() => chain.check(atHeight)).toThrow(/not finalized/);
    expect(() => chain.mine(1, { include: [atHeight] })).toThrow(/unfinalized/);
    chain.mine(2);
    expect(chain.accept(atHeight)).toBe(atHeight.getId());

    const other = chain.fund(alice.deriveAddress(1), prl('1'));
    const atTime = spend(alice, other, { index: 1, locktime: chain.medianTimePast() + 5000, sequence: 0xfffffffe });
    expect(() => chain.check(atTime)).toThrow(/not finalized/);
    chain.advanceTime(6000);
    chain.mine(6);
    expect(chain.medianTimePast()).toBeGreaterThan(atTime.locktime);
    expect(chain.check(atTime).fee).toBe(500n);
  });

  it('mines a valid transaction that is not standard when a test includes it, and never an invalid one', () => {
    const { chain, coin } = funded();
    const dust = chain.faucet.build([{ address: alice.deriveAddress(3), amount: 100n }]);
    expect(() => chain.accept(dust)).toThrow(/payment is dust/);
    chain.mine(1, { include: [dust] });
    expect(chain.tip.txs.map((tx) => tx.getId())).toContain(dust.getId());
    const forged = spend(bob, coin);
    const height = chain.height;
    expect(() => chain.mine(1, { include: [forged] })).toThrow(expect.objectContaining({ code: 'SIMULATION_INVALID', message: expect.stringContaining('failed to validate input') }));
    expect(() => chain.mine(1, { include: [chain.tip.txs[0]!] })).toThrow(/is a coinbase/);
    expect(chain.height).toBe(height);
  });
});

describe('reorganizations', () => {
  for (const depth of [1, 2, 5]) {
    it(`replaces the top ${depth} blocks with a longer branch and mines their transactions again`, async () => {
      const chain = small();
      const address = alice.deriveAddress(0);
      chain.mine(5);
      const paid = chain.pay(address, prl('2'));
      chain.mine(depth);
      const old = chain.blocks.slice(-depth);
      const events: string[] = [];
      chain.subscribe((event) => (event.type === 'connected' || event.type === 'disconnected') && events.push(`${event.type} ${event.block.height}`));
      const height = chain.height;
      const refs = chain.reorg(depth);
      expect(chain.height).toBe(height + 1);
      expect(refs.map((ref) => ref.height)).toEqual(Array.from({ length: depth + 1 }, (_, i) => height - depth + 1 + i));
      // Blocks come off from the tip down and go on from the fork up.
      expect(events).toEqual([
        ...Array.from({ length: depth }, (_, i) => `disconnected ${height - i}`),
        ...Array.from({ length: depth + 1 }, (_, i) => `connected ${height - depth + 1 + i}`),
      ]);
      for (const block of old) {
        expect(chain.isActive(block)).toBe(false);
        expect(chain.block(block.hash)).toBe(block);
      }
      expect(chain.blocks[height - depth + 1]!.parent).toBe(old[0]!.parent);
      expect(chain.chainTips().map((tip) => tip.hash)).toEqual([chain.tip.hash, old[depth - 1]!.hash]);
      // The payment is in the first block of the new branch.
      expect(await chain.getTransaction(paid.getId())).toEqual({ txid: paid.getId(), block: { height: height - depth + 1, hash: chain.blocks[height - depth + 1]!.hash, time: chain.blocks[height - depth + 1]!.time } });
      expect((await chain.getUtxos([address]))[0]!.confirmations).toBe(depth + 1);
      expect(chain.mempool.size).toBe(0);
    });
  }

  it('leaves the transactions in the mempool when asked, and the chain shorter when no blocks are mined', async () => {
    const chain = small();
    const paid = chain.pay(alice.deriveAddress(0), prl('2'));
    chain.mine(2);
    const height = chain.height;
    chain.reorg(2, { keepInMempool: true });
    expect(chain.height).toBe(height + 1);
    expect([...chain.mempool.keys()]).toEqual([paid.getId()]);
    expect(await chain.getTransaction(paid.getId())).toEqual({ txid: paid.getId(), block: null });
    chain.mine();
    chain.reorg(1, { mine: 0 });
    expect(chain.height).toBe(height + 1);
    expect(chain.mempool.has(paid.getId())).toBe(true);
    expect(() => chain.reorg(chain.height + 1)).toThrow(expect.objectContaining({ code: 'SIMULATION_INVALID' }));
    expect(() => chain.reorg(0)).toThrow(PearlError);
  });

  it('double-spends a faucet payment on the new branch, and what was built on it goes too', async () => {
    const chain = small();
    const address = alice.deriveAddress(0);
    const coin = chain.fund(address, prl('2'));
    const onward = spend(alice, coin, { amount: prl('1') });
    chain.accept(onward);
    chain.mine();
    const kept = chain.pay(alice.deriveAddress(1), prl('3'));
    chain.mine();
    chain.reorg(3, { replace: [coin.txid] });
    expect(chain.transaction(coin.txid)).toBeNull();
    expect(chain.transaction(onward.getId())).toBeNull();
    expect(await chain.getUtxos([address, bob.deriveAddress(0)])).toEqual([]);
    expect(await chain.getSpendStatus({ txid: coin.txid, vout: 0 })).toEqual({ status: 'unknown' });
    // The payment nobody conflicted with is mined again.
    expect((await chain.getTransaction(kept.getId()))!.block).not.toBeNull();
    const conflict = chain.blocks[chain.height - 3]!.txs[1]!;
    expect(chain.faucet.funded(conflict)).toBe(true);
    expect(verifyTransaction(conflict, chain.prevouts(conflict)!)).toEqual({ ok: true });
    expect(() => chain.reorg(1, { replace: [onward.getId()] })).toThrow(/no transaction/);
  });

  it('forgets a coin made and spent inside a block it takes off', async () => {
    const chain = small();
    const paid = chain.pay(alice.deriveAddress(0), prl('2'));
    const [coin] = await chain.getUtxos([alice.deriveAddress(0)]);
    const onward = spend(alice, coin!, { amount: prl('1') });
    chain.accept(onward);
    chain.mine();
    expect(chain.tip.txs).toHaveLength(3);
    // The payment is double-spent; what spent it in the same block has nothing left to spend.
    chain.reorg(1, { replace: [paid.getId()], keepInMempool: true });
    expect(chain.coin(paid.getId(), 0)).toBeNull();
    expect(chain.mempool.size).toBe(0);
    expect(() => chain.check(onward)).toThrow(/orphan transaction/);
    for (const { tx } of chain.mempool.values()) expect(chain.prevouts(tx)).not.toBeNull();
  });

  it('mines an included transaction after the mempool parent it spends, and replaces a chain of faucet payments at its root', () => {
    const chain = small();
    const coin = chain.fund(alice.deriveAddress(0), prl('2'));
    const parent = spend(alice, coin, { to: alice.deriveAddress(1), amount: prl('1') });
    chain.accept(parent);
    const child = spend(alice, { ...coin, txid: parent.getId(), vout: 0, value: prl('1'), script: parent.outs[0]!.script }, { index: 1, amount: 100n, fee: 400n });
    chain.mine(1, { include: [child] });
    expect(chain.tip.txs.slice(1).map((tx) => tx.getId())).toEqual([parent.getId(), child.getId()]);
    expect(() => chain.mine(1, { include: [spend(alice, { ...coin, txid: 'ee'.repeat(32) })], skipMempool: true })).toThrow(/does not exist or has already been spent/);

    // More payments between blocks than the faucet has confirmed coins, so the last ones spend its own change.
    const paid = Array.from({ length: 130 }, (_, i) => chain.pay(testAddress(i), prl('1')));
    const last = paid[paid.length - 1]!;
    const before = paid.find((tx) => tx.getId() === toHex(last.ins[0]!.hash.slice().reverse()))!;
    chain.mine();
    chain.reorg(1, { replace: [before.getId(), last.getId()] });
    expect(chain.transaction(before.getId())).toBeNull();
    expect(chain.transaction(last.getId())).toBeNull();
    expect(chain.blocks[chain.height - 1]!.txs).toHaveLength(1 + 1 + 128);
  });

  it('takes a conflict signed by the test for coins the faucet does not hold', () => {
    const chain = small();
    const coin = chain.fund(alice.deriveAddress(0), prl('2'));
    const sent = spend(alice, coin, { amount: prl('1') });
    chain.accept(sent);
    chain.mine();
    expect(() => chain.reorg(1, { replace: [sent.getId()] })).toThrow(/sign the conflict yourself/);
    const conflict = spend(alice, coin, { to: alice.deriveAddress(9), fee: 900n });
    chain.reorg(1, { include: [conflict] });
    expect(chain.transaction(sent.getId())).toBeNull();
    expect(chain.transaction(conflict.getId())!.block!.height).toBe(chain.height - 1);
    expect(chain.mempool.size).toBe(0);
  });

  it('follows invalidate and reconsider between two branches, as invalidateblock and reconsiderblock do', () => {
    const chain = small();
    chain.mine(3);
    const [a1, a2] = chain.blocks.slice(-2) as [typeof chain.tip, typeof chain.tip];
    chain.invalidate(a1.hash);
    expect(chain.tip.hash).toBe(a1.parent);
    expect([chain.isInvalid(a1), chain.isInvalid(a2)]).toEqual([true, true]);
    const [b1] = chain.mine(1);
    // A branch of one does not outgrow a branch of two until the longer one is allowed again.
    chain.reconsider(a2.hash);
    expect(chain.tip).toBe(a2);
    expect(chain.isInvalid(a1)).toBe(false);
    expect(chain.chainTips().map((tip) => tip.hash)).toEqual([a2.hash, b1!.hash]);
    chain.invalidate(a2.hash);
    // Both branches now end at the same height: the chain stays on the one it is on.
    expect(chain.tip).toBe(a1);
    chain.invalidate(a1.hash);
    expect(chain.tip.hash).toBe(b1!.hash);
    expect(() => chain.invalidate(chain.blocks[0]!.hash)).toThrow(/genesis/);
    expect(() => chain.invalidate('00'.repeat(32))).toThrow(/no block/);
  });

  it('returns a transaction to the mempool when its block is invalidated and mines it on the other branch', () => {
    const chain = small();
    const coin = chain.fund(alice.deriveAddress(0), prl('2'));
    const sent = spend(alice, coin, { amount: prl('1') });
    chain.accept(sent);
    const [mined] = chain.mine();
    chain.invalidate(mined!.hash);
    expect(chain.mempool.has(sent.getId())).toBe(true);
    chain.mine(2);
    expect(chain.transaction(sent.getId())!.block!.height).toBe(mined!.height);
    // Going back would undo it again, but the old branch is shorter and invalid.
    chain.reconsider(mined!.hash);
    expect(chain.transaction(sent.getId())!.block!.hash).not.toBe(mined!.hash);
  });
});

describe('double spends and drops', () => {
  it('mines a conflict for a faucet payment, which removes it and what spends it', async () => {
    const chain = small();
    const address = alice.deriveAddress(0);
    const paid = chain.pay(address, prl('2'));
    const [coin] = await chain.getUtxos([address]);
    const onward = spend(alice, coin!, { amount: prl('1') });
    chain.accept(onward);
    const conflict = chain.doubleSpend(paid.getId());
    expect(chain.mempool.size).toBe(0);
    expect(chain.tip.txs.map((tx) => tx.getId())).toEqual([chain.tip.txs[0]!.getId(), conflict.getId()]);
    expect(await chain.getTransaction(paid.getId())).toBeNull();
    expect(await chain.getTransaction(onward.getId())).toBeNull();
    expect(await chain.getSpendStatus({ txid: toHex(paid.ins[0]!.hash.slice().reverse()), vout: paid.ins[0]!.index })).toEqual({
      status: 'spent',
      spender: conflict.getId(),
      confirmed: true,
    });
  });

  it('keeps the conflict in the mempool when asked not to mine it', () => {
    const chain = small();
    const paid = chain.pay(alice.deriveAddress(0), prl('2'));
    const conflict = chain.doubleSpend(paid.getId(), { mine: false });
    expect([...chain.mempool.keys()]).toEqual([conflict.getId()]);
  });

  it('needs the conflict from the test for a transaction of other keys', () => {
    const chain = small();
    const coin = chain.fund(alice.deriveAddress(0), prl('2'));
    const sent = spend(alice, coin, { amount: prl('1') });
    chain.accept(sent);
    expect(() => chain.doubleSpend(sent.getId())).toThrow(expect.objectContaining({ code: 'SIMULATION_INVALID' }));
    expect(() => chain.doubleSpend(sent.getId(), { conflict: chain.faucet.build([{ address: alice.deriveAddress(1), amount: 5000n }]) })).toThrow(/spends none of the inputs/);
    expect(chain.mempool.has(sent.getId())).toBe(true);
    const conflict = spend(alice, coin, { to: alice.deriveAddress(5), fee: 800n });
    expect(chain.doubleSpend(sent.getId(), { conflict })).toBe(conflict);
    expect(chain.transaction(sent.getId())).toBeNull();
    expect(chain.transaction(conflict.getId())!.block).toBe(chain.tip);
    expect(() => chain.doubleSpend(sent.getId())).toThrow(/not in the mempool/);
  });

  it('drops a mempool transaction with its descendants and frees their coins', async () => {
    const chain = small();
    const coin = chain.fund(alice.deriveAddress(0), prl('2'));
    const sent = spend(alice, coin, { amount: prl('1') });
    chain.accept(sent);
    chain.drop(sent.getId());
    expect(chain.mempool.size).toBe(0);
    expect(await chain.getSpendStatus(coin)).toEqual({ status: 'unspent', confirmations: 1 });
    expect(() => chain.drop(sent.getId())).toThrow(/not in the mempool/);
  });
});

describe('the clock', () => {
  it('stamps blocks one target spacing apart from a fixed start, and never reads the real time', () => {
    const chain = small();
    const times = chain.blocks.map((block) => block.time);
    expect(times[1]! - times[0]!).toBe(quick.targetSpacing);
    for (let i = 2; i < times.length; i += 1) expect(times[i]! - times[i - 1]!).toBe(quick.targetSpacing);
    expect(chain.time).toBe(chain.tip.time + quick.targetSpacing);
    expect(new SimulatedChain({ network: quick, premine: 1, time: 2_000_000_000 }).tip.time).toBe(2_000_000_000);
  });

  it('moves when a test moves it, and keeps each block time a second past its parent\'s', () => {
    const chain = small();
    chain.advanceTime(86_400);
    const expected = chain.time;
    chain.mine();
    expect(chain.tip.time).toBe(expected);
    // Set back to before the chain's own blocks, the next one takes the earliest time Pearl allows.
    chain.setTime(chain.blocks[1]!.time);
    const parent = chain.tip.time;
    chain.mine();
    expect(chain.tip.time).toBe(parent + 1);
    expect(() => chain.setTime(-1)).toThrow(RangeError);
    expect(chain.medianTimePast(0)).toBe(chain.blocks[0]!.time);
  });
});

describe('the faucet and the test keys', () => {
  it('funds an address with a confirmed coin that a payment can spend right away', async () => {
    const chain = small();
    const coin = chain.fund(alice.deriveAddress(4), prl('7'), { confirmations: 3 });
    expect(coin).toEqual((await chain.getUtxos([alice.deriveAddress(4)]))[0]);
    expect(coin.confirmations).toBe(3);
    const payment = payFromAccount(alice, {
      network: quick,
      utxos: [{ ...coin, index: 4 }],
      recipients: [{ address: testAddress(1), amount: prl('2') }],
      feeRate: 2000n,
      changeAddress: alice.deriveAddress(0, true),
    });
    expect(chain.accept(payment.transaction)).toBe(payment.txid);
    expect(() => chain.fund(alice.deriveAddress(0), 1n, { confirmations: 0 })).toThrow(RangeError);
  });

  it('pays many times between blocks without spending its own unconfirmed change', () => {
    const chain = small();
    const paid = Array.from({ length: 60 }, (_, i) => chain.pay(testAddress(i), prl('1')));
    expect(chain.mempool.size).toBe(60);
    // The first payments each took a confirmed coin of their own.
    const spent = paid.slice(0, 20).map((tx) => ({ txid: toHex(tx.ins[0]!.hash.slice().reverse()), vout: tx.ins[0]!.index }));
    expect(new Set(spent.map(({ txid, vout }) => `${txid}:${vout}`)).size).toBe(20);
    expect(spent.every(({ txid, vout }) => chain.coin(txid, vout) !== null)).toBe(true);
    chain.mine();
    expect(chain.tip.txs).toHaveLength(61);
  });

  it('signals replacement and pays the fee rate it is asked to', () => {
    const chain = small();
    const plain = chain.pay(testAddress(0), prl('1'));
    const flagged = chain.pay(testAddress(0), prl('1'), { rbf: true, feeRate: 10_000n });
    expect(plain.ins[0]!.sequence).toBe(0xffffffff);
    expect(flagged.ins[0]!.sequence).toBe(0xfffffffd);
    const rate = (entry: { fee: bigint; vsize: number }): bigint => (entry.fee * 1000n) / BigInt(entry.vsize);
    expect(rate(chain.mempool.get(plain.getId())!)).toBeGreaterThanOrEqual(2000n);
    expect(rate(chain.mempool.get(plain.getId())!)).toBeLessThan(2100n);
    expect(rate(chain.mempool.get(flagged.getId())!)).toBeGreaterThanOrEqual(10_000n);
  });

  it('sets coins aside for a transaction it built until that or a conflict is mined, and says when it runs dry', () => {
    const chain = new SimulatedChain({ network: quick, premine: 5 });
    const all = chain.faucet.balance();
    expect(all).toBe(blockSubsidy(quick, 1));
    const built = chain.faucet.build([{ address: testAddress(0), amount: all - prl('1') }]);
    expect(chain.faucet.balance()).toBe(0n);
    expect(() => chain.pay(testAddress(1), prl('1'))).toThrow(expect.objectContaining({ code: 'SIMULATION_INVALID', message: expect.stringContaining('mine blocks') }));
    chain.accept(built);
    // Its change is spendable at once, unconfirmed.
    expect(chain.faucet.balance()).toBeGreaterThan(0n);
    expect(() => chain.faucet.build([])).toThrow(/someone to pay/);
    expect(() => chain.faucet.build([{ amount: 1n }])).toThrow(/address or a script/);
  });

  it('gives the same keys, mnemonics and addresses on every run', () => {
    expect(testMnemonic(0)).toBe(testMnemonic(0));
    expect(testMnemonic(0)).not.toBe(testMnemonic(1));
    expect(testMnemonic(7).split(' ')).toHaveLength(12);
    // The first address of the usual test mnemonic on regtest, as Oyster derives it too.
    expect(testAccount(0).deriveAddress(0)).toBe(deriveSigningAccountFromSeed(mnemonicToSeed(TEST_MNEMONIC), networks.regtest).deriveAddress(0));
    expect(testAccount(0, networks.mainnet).deriveAddress(0).startsWith('prl1p')).toBe(true);
    expect(testAccount(1).deriveAddress(0)).not.toBe(testAccount(0).deriveAddress(0));
    expect(testAccount(0, networks.regtest, testMnemonic(3)).deriveAddress(0)).not.toBe(testAccount(0).deriveAddress(0));
    expect(testKey(1)).toHaveLength(32);
    expect(testKey(1)).not.toEqual(testKey(2));
    expect(testAddress(1)).toMatch(/^rprl1p/);
    expect(testXmssSeeds(0).privateSeed).toHaveLength(64);
    expect(testXmssSeeds(0).publicSeed).toHaveLength(32);
    expect(testXmssSeeds(0)).toEqual(testXmssSeeds(0));
    expect(TEST_MNEMONIC).not.toBe(FAUCET_MNEMONIC);
  });
});

describe('failures a test injects', () => {
  it('fails the next calls as a dropped connection does, then answers again', async () => {
    const chain = small();
    chain.failNext(2);
    await expect(chain.getTip()).rejects.toMatchObject({ code: 'RPC_NETWORK', kind: 'network', method: 'getTip' });
    await expect(chain.rpc.getBlockCount()).rejects.toMatchObject({ code: 'RPC_NETWORK', method: 'getblockcount' });
    expect(await chain.rpc.getBlockCount()).toBe(chain.height);
  });

  it('fails only the method named, with the error given', async () => {
    const chain = small();
    const tx = chain.faucet.build([{ address: testAddress(0), amount: prl('1') }]);
    chain.failNext(1, { method: 'broadcast', error: (method) => new PearlRpcError('http', method, 'HTTP 503', { status: 503 }) });
    expect((await chain.getTip()).height).toBe(chain.height);
    await expect(chain.broadcast(tx.toHex())).rejects.toMatchObject({ kind: 'http', status: 503 });
    expect(chain.mempool.size).toBe(0);
    expect(await chain.broadcast(tx.toHex())).toBe(tx.getId());
    expect(chain.calls.get('broadcast')).toBe(2);
    expect(chain.calls.get('getTip')).toBe(1);
  });
});
