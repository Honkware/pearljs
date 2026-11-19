/**
 * Pool effort and luck over the blocks of a simulated chain.
 *
 * Mines forty blocks on pearljs/testing's SimulatedChain, some of them to a
 * pool's address, alongside a made-up log of the shares the pool accepted.
 * For each block the pool found it prints the round's effort, then the
 * pool's luck over the window with a 95% interval. Bounds come from the
 * blocks' own bits and the configuration the pool's miners commit to.
 */

import {
  bitsToTarget,
  customNetwork,
  effort,
  jackpotBound,
  luck,
  networks,
  shareValue,
  toOutputScript,
} from 'pearljs';
import type { MiningConfiguration } from 'pearljs';
import { SimulatedChain, testAccount } from 'pearljs/testing';

// Regtest with mainnet-like bits, so a share and a block differ in difficulty.
const network = customNetwork(networks.regtest, { powLimitBits: 0x1d00ffff, powLimit: bitsToTarget(0x1d00ffff) });
const chain = new SimulatedChain({ network, premine: 0 });
const pool = testAccount(0, network).deriveAddress(0);
const poolScript = toOutputScript(pool, network);

// The configuration pearld's own prover uses: k 2048, rank 128, a 4 by 8 tile.
const config: MiningConfiguration = {
  commonDim: 2048, rank: 128, mmaType: 0,
  rows: [0, 8, 64, 72], cols: [0, 1, 8, 9, 32, 33, 40, 41], moe: null,
};
const SHARE_BITS = 0x1e00ffff;

// A share log: shares the pool accepted before each block, drawn at the true rate.
let seed = 7;
const random = (): number => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) / 2 ** 32;
};

const sharesBefore = new Map<number, number>();
for (let i = 0; i < 40; i += 1) {
  const height = chain.height + 1;
  const blockBound = jackpotBound(network.powLimitBits, config);
  const perBlock = 1 / shareValue(jackpotBound(SHARE_BITS, config), blockBound);
  // The pool holds about a third of the network's work.
  sharesBefore.set(height, Math.round((-Math.log(1 - random()) * perBlock) / 3));
  chain.mine(1, random() < 0.3 ? { coinbaseTo: pool } : {});
}

// Walk the chain: every block adds the round's shares; a block paying the pool closes the round.
let round: { shareBound: bigint; blockBound: bigint }[] = [];
let found = 0;
let expected = 0;
for (const block of chain.blocks.slice(1)) {
  const blockBound = jackpotBound(block.block.header.bits, config);
  const shareBound = jackpotBound(SHARE_BITS, config);
  const shares = sharesBefore.get(block.height) ?? 0;
  round = round.concat(Array.from({ length: shares }, () => ({ shareBound, blockBound })));
  const ours = block.txs[0]!.outs.some((out) => Buffer.from(out.script).equals(poolScript));
  if (!ours) continue;
  const roundEffort = effort(round);
  console.log(`height ${String(block.height).padStart(2)}  shares ${String(round.length).padStart(6)}  effort ${(roundEffort * 100).toFixed(1)}%`);
  found += 1;
  expected += roundEffort;
  round = [];
}
expected += effort(round);
console.log(`open round: ${round.length} shares`);

const result = luck(found, expected);
console.log(`found ${found} blocks against ${expected.toFixed(2)} expected`);
console.log(`luck ${(result.luck * 100).toFixed(1)}% (95%: ${(result.low * 100).toFixed(1)}% to ${(result.high * 100).toFixed(1)}%)`);
