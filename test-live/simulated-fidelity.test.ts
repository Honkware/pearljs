// One scripted sequence run on the real pearld and on pearljs/testing's
// SimulatedChain, started at the same height: payments, a duplicate, a
// double spend, a replacement too cheap and one that pays enough, a fee
// under the relay floor, a script failure, a sequence-locked spend, outputs
// above the inputs, duplicate inputs, version 3, an orphan, an immature
// coinbase spend, a duplicate of a mined transaction and a spend of a
// watched output. For every step the two must agree on acceptance,
// the RPC error code, sendrawtransaction's text and testmempoolaccept's
// reject reason, and on the websocket notifications the step causes.

import { Agent, WebSocket } from 'undici';
import { expect, it } from 'vitest';
import {
  createPsbt,
  createTransaction,
  deriveSigningAccountFromSeed,
  feeForVsize,
  finalizePsbt,
  mnemonicToSeed,
  parseBlock,
  parseTransaction,
  PearlRpcError,
  PearlWsClient,
  toOutputScript,
} from '../src/index.js';
import type { PearlSigningAccount, PearldRpc, Transaction, TxOutput } from '../src/index.js';
import { SimulatedChain } from '../src/testing.js';
import { describeLive, fund, live, mine, miner, network, nowhere, pearld } from './chain.js';

const payer = deriveSigningAccountFromSeed(mnemonicToSeed('warrior weasel feed fresh rare donkey endless light canoe flash allow column'), network);
const watched = payer.deriveAddress(20);
const COIN = 10_000_000n;
const WATCHED_EVENTS = ['blockconnected', 'filteredblockconnected', 'txaccepted', 'relevanttxaccepted', 'recvtx', 'redeemingtx'] as const;

interface Side {
  name: string;
  rpc: Pick<PearldRpc, 'sendRawTransaction' | 'testMempoolAccept' | 'getBlockCount' | 'getRawBlock' | 'getBlockHash'>;
  ws: PearlWsClient;
  /** Pays the outputs in one transaction and mines it. */
  fund(outputs: readonly TxOutput[]): Promise<Transaction>;
  /** Mines blocks whose coinbase pays the miner's first address. */
  mine(n: number): Promise<string[]>;
  /** Lets notifications arrive. */
  settle(): Promise<void>;
  close(): Promise<void>;
}

interface Outcome {
  step: string;
  accepted: boolean;
  code: number | null;
  message: string | null;
  reason: string | null;
  events: string[];
}

function realSide(): Side {
  const endpoint = live?.pearld ?? nowhere;
  const agent = new Agent({ connect: { ca: endpoint.ca } });
  const ws = new PearlWsClient({ url: endpoint.url, username: endpoint.username, password: endpoint.password, WebSocket, webSocketInit: { dispatcher: agent } });
  return {
    name: 'pearld',
    rpc: pearld,
    ws,
    fund: (outputs) => fund(outputs),
    mine: (n) => mine(n),
    settle: () => new Promise((resolve) => setTimeout(resolve, 1500)),
    async close() {
      await ws.close();
      await agent.close();
    },
  };
}

function simulatedSide(height: number): Side {
  const chain = new SimulatedChain({ premine: height });
  const ws = new PearlWsClient({ url: 'ws://simulated', WebSocket: chain.WebSocket });
  const coinbaseTo = miner.deriveAddress(0);
  return {
    name: 'simulated',
    rpc: chain.rpc,
    ws,
    async fund(outputs) {
      const tx = chain.faucet.build(outputs.map(({ script, value }) => ({ script, amount: value })));
      chain.accept(tx);
      chain.mine(1, { coinbaseTo });
      return tx;
    },
    async mine(n) {
      const hashes: string[] = [];
      for (let i = 0; i < n; i += 1) hashes.push(chain.mine(1, { coinbaseTo })[0]!.hash);
      return hashes;
    },
    settle: () => new Promise((resolve) => setTimeout(resolve, 50)),
    close: () => ws.close(),
  };
}

/** A key-path spend signed without any policy check, so pearld can be shown what policy refuses. */
function spend(account: PearlSigningAccount, coins: readonly { tx: Transaction; vout: number; index: number }[], outputs: readonly TxOutput[], shape: { sequence?: number; corrupt?: boolean; version?: number } = {}): Transaction {
  const tx = createTransaction(shape.version ?? 2);
  for (const coin of coins) tx.addInput(coin.tx.getHash(), coin.vout, shape.sequence ?? 0xffffffff);
  for (const output of outputs) tx.addOutput(output.script, output.value);
  const psbt = createPsbt(tx);
  coins.forEach((coin, i) => account.prepareInput(psbt, i, { index: coin.index, value: coin.tx.outs[coin.vout]!.value }));
  coins.forEach((coin, i) => account.signInput(psbt, i, { index: coin.index, auxRand: new Uint8Array(32) }));
  const signed = finalizePsbt(psbt);
  if (shape.corrupt === true) {
    const signature = Uint8Array.from(signed.ins[0]!.witness[0]!);
    signature[10] = signature[10]! ^ 1;
    signed.setWitness(0, [signature]);
  }
  return signed;
}

const to = (address: string, value: bigint): TxOutput => ({ script: toOutputScript(address, network), value });
// One input, two outputs at the given rate: a key-path spend is 154 vbytes with two P2TR outputs.
const feeAt = (rate: bigint, outputs = 2): bigint => feeForVsize(outputs === 2 ? 154 : 111, rate);

async function runScript(side: Side): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];
  const labels = new Map<string, string>();
  const seen: string[] = [];
  for (const name of WATCHED_EVENTS) {
    side.ws.on(name, (event: unknown) => {
      const value = event as { txid?: string; hash?: string; transaction?: string | { txid?: string } };
      const txid = typeof value.transaction === 'string' ? parseTransaction(value.transaction).getId() : (value.txid ?? null);
      seen.push(`${name}${txid === null ? '' : `:${labels.get(txid) ?? 'other'}`}`);
    });
  }
  await side.ws.call('notifyblocks');
  await side.ws.call('notifynewtransactions', [false]);
  await side.ws.notifyReceived([watched]);
  await side.ws.loadTxFilter({ addresses: [watched] });

  const funding = await side.fund(Array.from({ length: 8 }, (_, i) => to(payer.deriveAddress(i), COIN)));
  await side.settle();
  const coin = (i: number) => ({ tx: funding, vout: i, index: i });
  const change = (i: number) => payer.deriveAddress(100 + i);

  const step = async (name: string, tx: Transaction | null, run?: () => Promise<void>): Promise<Transaction | null> => {
    if (tx !== null) labels.set(tx.getId(), name);
    seen.length = 0;
    const outcome: Outcome = { step: name, accepted: true, code: null, message: null, reason: null, events: [] };
    if (tx !== null) {
      const [verdict] = await side.rpc.testMempoolAccept([tx.toHex()]);
      outcome.reason = verdict?.allowed === true ? null : normalize(verdict?.['reject-reason'] ?? '', labels);
      try {
        await side.rpc.sendRawTransaction(tx.toHex());
      } catch (err) {
        if (!(err instanceof PearlRpcError)) throw err;
        outcome.accepted = false;
        outcome.code = err.rpcCode ?? null;
        outcome.message = normalize(err.message, labels);
      }
    }
    await run?.();
    await side.settle();
    outcome.events = [...seen].sort();
    outcomes.push(outcome);
    return tx;
  };
  const payment = spend(payer, [coin(0)], [to(watched, 3_000_000n), to(change(0), COIN - 3_000_000n - feeAt(2000n))]);
  await step('payment', payment);
  await step('duplicate', payment);
  await step('double spend', spend(payer, [coin(0)], [to(change(1), COIN - feeAt(4000n, 1))]));
  const original = spend(payer, [coin(1)], [to(watched, 2_000_000n), to(change(2), COIN - 2_000_000n - feeAt(2000n))], { sequence: 0xfffffffd });
  await step('replaceable', original);
  await step('replacement too cheap', spend(payer, [coin(1)], [to(watched, 2_000_000n), to(change(3), COIN - 2_000_000n - feeAt(2000n) - 1n)], { sequence: 0xfffffffd }));
  await step('replacement', spend(payer, [coin(1)], [to(watched, 2_000_000n), to(change(4), COIN - 2_000_000n - feeAt(6000n))], { sequence: 0xfffffffd }));
  await step('fee under the relay floor', spend(payer, [coin(2)], [to(change(5), COIN - feeAt(500n, 1))]));
  await step('bad signature', spend(payer, [coin(3)], [to(change(6), COIN - feeAt(2000n, 1))], { corrupt: true }));
  await step('sequence lock', spend(payer, [coin(4)], [to(change(7), COIN - feeAt(2000n, 1))], { sequence: 10 }));
  // Raised after signing, since finalizePsbt refuses to make it; pearld checks the amounts before any signature.
  const overpaid = spend(payer, [coin(5)], [to(change(10), COIN - feeAt(2000n, 1))]);
  overpaid.outs[0]!.value = COIN + 1n;
  await step('outputs above the inputs', overpaid);
  // A PSBT cannot hold the same input twice, so the second is copied in after signing.
  const doubled = spend(payer, [coin(6)], [to(change(11), COIN - feeAt(4000n, 1))]);
  doubled.addInput(funding.getHash(), 6, 0xffffffff);
  doubled.setWitness(1, doubled.ins[0]!.witness);
  await step('duplicate inputs', doubled);
  await step('version 3', spend(payer, [coin(7)], [to(change(12), COIN - feeAt(2000n, 1))], { version: 3 }));
  const nowhereTx = createTransaction(2);
  nowhereTx.addOutput(toOutputScript(payer.deriveAddress(4), network), COIN);
  await step('orphan', spend(payer, [{ tx: nowhereTx, vout: 0, index: 4 }], [to(change(8), COIN - feeAt(2000n, 1))]));

  // A block: the payment and the replacement are mined, and the coinbase is too young to spend.
  await step('block', null, async () => {
    await side.mine(1);
  });
  const coinbase = parseBlock(await side.rpc.getRawBlock(await side.rpc.getBlockHash(await side.rpc.getBlockCount()))).transactions[0]!;
  const minerVout = coinbase.outs.findIndex((out) => Buffer.from(out.script).equals(toOutputScript(miner.deriveAddress(0), network)));
  await step('immature coinbase', spend(miner, [{ tx: coinbase, vout: minerVout, index: 0 }], [to(change(9), coinbase.outs[minerVout]!.value - feeAt(2000n, 1))]));
  await step('duplicate of a mined transaction', payment);
  await step('spend of a watched output', spendWatched(payment));
  await step('second block', null, async () => {
    await side.mine(1);
  });
  return outcomes;
}

function spendWatched(payment: Transaction): Transaction {
  return spend(payer, [{ tx: payment, vout: 0, index: 20 }], [to(payer.deriveAddress(30), 3_000_000n - feeAt(2000n, 1))]);
}

/** Hashes become the step that made them, or <hash>; long hex runs (witnesses, scripts) become <hex>. */
function normalize(text: string, labels: Map<string, string>): string {
  return text.replace(/[0-9a-f]{64}/g, (hash) => (labels.has(hash) ? `<${labels.get(hash)}>` : '<hash>')).replace(/[0-9a-f]{16,}/g, '<hex>');
}

describeLive('the simulated chain against pearld', () => {
  it('accepts and refuses the same transactions with the same codes, texts and notifications', async () => {
    const height = await pearld.getBlockCount();
    const real = realSide();
    const simulated = simulatedSide(height);
    let fromNode: Outcome[];
    let fromSimulation: Outcome[];
    try {
      fromNode = await runScript(real);
      fromSimulation = await runScript(simulated);
    } finally {
      await real.close();
      await simulated.close();
    }
    const differences = fromNode.flatMap((node, i) => {
      const sim = fromSimulation[i]!;
      return (['accepted', 'code', 'message', 'reason', 'events'] as const)
        .filter((field) => JSON.stringify(node[field]) !== JSON.stringify(sim[field]))
        .map((field) => ({ step: node.step, field, pearld: node[field], simulated: sim[field] }));
    });
    expect(differences).toEqual([]);
    // The script reached every kind of answer it was written for.
    expect(fromNode.filter((outcome) => !outcome.accepted).map((outcome) => outcome.code).sort()).toEqual([-25, -25, -25, -25, -25, -26, -26, -26, -26, -26, -26, -27]);
  });
});
