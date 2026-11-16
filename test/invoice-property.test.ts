// Property tests for the invoice monitor over generated chain histories:
// payments, blocks, reorgs and double spends around the expiry time, replayed
// once with a refresh after every event and again with refreshes skipped at
// random. Nothing paid is ever missing from the record, and the state follows
// from the chain and the clock, not from how often refresh ran.
//
// A double spend is seen only by a refresh that ran while the payment
// existed, so the sparse replay always refreshes just before one: that is
// the one fact a chain view cannot give back later. The generator is seeded,
// so a failure repeats.
//
//   PEARLJS_PROPERTY_RUNS=2000 npm test -- test/invoice-property.test.ts

import { describe, expect, it } from 'vitest';
import { encodeAddress } from '../src/address.js';
import { createInvoice, invoiceFromJson, invoiceToJson, refreshInvoice } from '../src/invoice.js';
import type { Invoice } from '../src/invoice.js';
import { networks } from '../src/networks.js';
import { ScriptedChain, random } from './invoice-helpers.js';

const NETWORK = networks.regtest;
const ADDRESS = encodeAddress({ version: 1, program: new Uint8Array(32).fill(7) }, NETWORK);
const OTHER = encodeAddress({ version: 1, program: new Uint8Array(32).fill(8) }, NETWORK);
const RUNS = Number(process.env.PEARLJS_PROPERTY_RUNS ?? 200);
const SEED = Number(process.env.PEARLJS_PROPERTY_SEED ?? 1);

type Event =
  | { kind: 'broadcast'; txid: string; amount: bigint; other: bigint }
  | { kind: 'direct'; txid: string; amount: bigint }
  | { kind: 'mine' }
  | { kind: 'reorg'; depth: number }
  | { kind: 'drop'; pick: number }
  | { kind: 'wait'; seconds: number };

function history(next: () => number): Event[] {
  const events: Event[] = [];
  const steps = 5 + Math.floor(next() * 25);
  for (let i = 0; i < steps; i++) {
    const roll = next();
    const amount = BigInt(Math.floor(next() * 60_000));
    if (roll < 0.3) events.push({ kind: 'broadcast', txid: `tx-${i}`, amount, other: next() < 0.3 ? 5n : 0n });
    else if (roll < 0.4) events.push({ kind: 'direct', txid: `tx-${i}`, amount });
    else if (roll < 0.6) events.push({ kind: 'mine' });
    else if (roll < 0.7) events.push({ kind: 'reorg', depth: 1 + Math.floor(next() * 3) });
    else if (roll < 0.75) events.push({ kind: 'drop', pick: next() });
    else events.push({ kind: 'wait', seconds: Math.floor(next() * 400) });
  }
  return events;
}

interface Replay {
  chain: ScriptedChain;
  invoice: Invoice;
  clock: number;
}

// Replays a history, refreshing after an event when `refreshAfter` says so.
async function replay(events: Event[], seenAt: boolean, refreshAfter: (i: number, event: Event) => boolean, check?: (r: Replay) => void): Promise<Replay> {
  const chain = new ScriptedChain({ height: 99, time: 900 });
  chain.reportSeenAt = seenAt;
  const r: Replay = { chain, clock: 1_000, invoice: createInvoice({ id: 'p', address: ADDRESS, amount: 100_000n, createdAt: 1_000, expiresAt: 2_000, requiredConfirmations: 2 }, NETWORK) };
  const refresh = async (): Promise<void> => {
    r.invoice = await refreshInvoice(r.invoice, chain, r.clock);
    // A restart through the codec changes nothing.
    r.invoice = invoiceFromJson(JSON.parse(JSON.stringify(invoiceToJson(r.invoice))), NETWORK);
    check?.(r);
  };
  for (const [i, event] of events.entries()) {
    if (event.kind === 'drop') await refresh();
    r.clock += 30;
    switch (event.kind) {
      case 'broadcast':
        chain.broadcast(event.txid, event.other > 0n ? { [ADDRESS]: event.amount, [OTHER]: event.other } : { [ADDRESS]: event.amount }, r.clock);
        break;
      case 'direct':
        chain.mineDirect(event.txid, { [ADDRESS]: event.amount }, r.clock);
        break;
      case 'mine':
        chain.mine(r.clock);
        break;
      case 'reorg':
        chain.disconnect(event.depth);
        break;
      case 'drop': {
        const pool = [...chain.mempool].sort();
        if (pool.length > 0) chain.drop(pool[Math.floor(event.pick * pool.length)]!);
        break;
      }
      case 'wait':
        r.clock += event.seconds;
        break;
    }
    if (refreshAfter(i, event)) await refresh();
  }
  await refresh();
  return r;
}

const listed = (invoice: Invoice) =>
  invoice.payments
    .filter((p) => p.status === 'unconfirmed' || p.status === 'confirmed')
    .map(({ txid, amount, status, block, confirmations, counted }) => ({ txid, amount, status, block, confirmations, counted }))
    .sort((a, b) => a.txid.localeCompare(b.txid));

const outcome = (invoice: Invoice) => ({
  state: invoice.state,
  paidAmount: invoice.paidAmount,
  uncountedAmount: invoice.uncountedAmount,
  confirmations: invoice.confirmations,
  listed: listed(invoice),
});

describe('invoice monitor properties', () => {
  it('records everything the chain paid the address, and the state does not depend on how often refresh ran', async () => {
    const next = random(SEED);
    for (let run = 0; run < RUNS; run++) {
      const events = history(next);
      const sparse = next();
      const where = `seed ${SEED}, run ${run}: ${JSON.stringify(events, (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))}`;
      const dense = await replay(events, true, () => true, ({ chain, invoice }) => {
        const paid = listed(invoice).reduce((sum, p) => sum + p.amount, 0n);
        expect(paid, where).toBe(chain.paidTo(ADDRESS));
        expect(invoice.paidAmount + invoice.uncountedAmount, where).toBe(paid);
      });
      const pick = random(run + 1);
      const rare = await replay(events, true, () => pick() < sparse);
      expect(outcome(rare.invoice), where).toEqual(outcome(dense.invoice));
    }
  });

  it('never counts less for refreshing more often when the backend reports no first-seen times', async () => {
    const next = random(SEED + 1);
    for (let run = 0; run < RUNS; run++) {
      const events = history(next);
      const where = `seed ${SEED + 1}, run ${run}`;
      const dense = await replay(events, false, () => true);
      const pick = random(run + 7);
      const rare = await replay(events, false, () => pick() < 0.3);
      const counted = (invoice: Invoice) => new Set(invoice.payments.filter((p) => p.counted).map((p) => p.txid));
      for (const txid of counted(rare.invoice)) expect(counted(dense.invoice).has(txid), where).toBe(true);
      expect(listed(rare.invoice).map((p) => [p.txid, p.amount]), where).toEqual(listed(dense.invoice).map((p) => [p.txid, p.amount]));
      expect(rare.invoice.paidAmount + rare.invoice.uncountedAmount, where).toBe(rare.chain.paidTo(ADDRESS));
    }
  });
});
