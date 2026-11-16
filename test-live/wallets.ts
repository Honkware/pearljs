// What the wallet tests share: throwaway passphrases, connections to the
// node, the node's own account of a transaction, and event recording.

import { Agent, WebSocket } from 'undici';
import { expect } from 'vitest';
import {
  deriveSigningAccountFromSeed,
  inspectTransaction,
  mnemonicToSeed,
  parseTransaction,
  payFromAccount,
  pearldBackend,
  pearldTransactionSource,
  PearlWsClient,
  toOutputScript,
} from '../src/index.js';
import type { InspectedTransaction, PearlWallet, SendResult, WalletBackend, WalletConnection, WalletEvents, WalletStore } from '../src/index.js';
import { FEE_RATE, fund, live, network, nowhere, pearld, spentOutputs } from './chain.js';

/** Throwaway keystore passphrase; these wallets only ever hold regtest coins. */
export const PASSPHRASE = 'pearljs-live keystore passphrase';
/** scrypt at a cost that keeps the tests quick. One wallet uses the default. */
export const QUICK_KDF = { N: 2 ** 14 } as const;

export const nodeBackend = pearldBackend(pearld, { network });

/** A wallet connection to the suite's pearld over HTTPS. */
export function connection(store: WalletStore, backend: WalletBackend = nodeBackend): WalletConnection {
  return { store, backend, transactions: pearldTransactionSource(pearld) };
}

/** A websocket client for the suite's pearld, and what closes it. */
export function nodeSocket(): { ws: PearlWsClient; close(): Promise<void> } {
  const endpoint = live?.pearld ?? nowhere;
  const agent = new Agent({ connect: { ca: endpoint.ca } });
  const ws = new PearlWsClient({
    url: endpoint.url,
    username: endpoint.username,
    password: endpoint.password,
    WebSocket,
    webSocketInit: { dispatcher: agent },
  });
  return {
    ws,
    async close() {
      await ws.close();
      await agent.close();
    },
  };
}

/** A transaction as pearld holds it, with fee and addresses worked out from the outputs pearld says it spends. */
export async function nodeView(txid: string): Promise<InspectedTransaction> {
  const tx = parseTransaction(await pearld.getRawTransactionHex(txid));
  return inspectTransaction(tx, await spentOutputs(tx), network);
}

/** The wallet's balance as the node's address index gives it for every address the wallet has coins or history on. */
export async function nodeBalance(wallet: PearlWallet, extra: readonly string[] = []): Promise<{ confirmed: bigint; unconfirmed: bigint; immature: bigint }> {
  const addresses = new Set([...wallet.addresses().map((entry) => entry.address), ...wallet.coins().map((coin) => coin.address), ...extra]);
  return nodeBackend.getBalance([...addresses]);
}

/** Every value of a wallet event so far, and a wait for one that satisfies a test. */
export function recordEvents<K extends keyof WalletEvents>(wallet: PearlWallet, event: K) {
  const seen: WalletEvents[K][] = [];
  const waiting: (() => void)[] = [];
  const off = wallet.on(event, (value) => {
    seen.push(value);
    for (const wake of waiting.splice(0)) wake();
  });
  return {
    seen,
    off,
    async until(test: (value: WalletEvents[K]) => boolean, timeout = 60_000): Promise<WalletEvents[K]> {
      const deadline = Date.now() + timeout;
      for (;;) {
        const found = seen.find(test);
        if (found !== undefined) return found;
        if (Date.now() > deadline) throw new Error(`no ${event} event arrived`);
        await Promise.race([new Promise<void>((resolve) => waiting.push(resolve)), new Promise((resolve) => setTimeout(resolve, 500))]);
      }
    },
  };
}

/** A backend that answers as the given one does, with getHistory held while `hold` is set. */
export function holdable(backend: WalletBackend): WalletBackend & { hold: Promise<void> | null; held: number } {
  const wrapped: WalletBackend & { hold: Promise<void> | null; held: number } = {
    ...backend,
    hold: null,
    held: 0,
    async getHistory(watched) {
      if (wrapped.hold !== null) {
        wrapped.held += 1;
        await wrapped.hold;
      }
      return backend.getHistory(watched);
    },
  };
  return wrapped;
}

export const outpoint = (coin: { txid: string; vout: number }): string => `${coin.txid}:${coin.vout}`;
const total = (items: readonly { value: bigint }[]): bigint => items.reduce((sum, item) => sum + item.value, 0n);

/** Someone outside every wallet under test: an account that pays them, and addresses for them to pay. */
export function outsider(accountNumber: number) {
  const payer = deriveSigningAccountFromSeed(mnemonicToSeed('zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong'), network, accountNumber);
  let next = 0;
  return {
    /** Pays address from outside the wallet and leaves the payment in the mempool. */
    async payPending(address: string, amount: bigint): Promise<string> {
      const index = next++;
      const value = amount + 1_000_000n;
      const funding = await fund([{ script: toOutputScript(payer.deriveAddress(index), network), value }]);
      const payment = payFromAccount(payer, {
        network,
        utxos: [{ txid: funding.getId(), vout: 0, value, script: funding.outs[0]!.script, confirmations: 1, index }],
        recipients: [{ address, amount }],
        feeRate: FEE_RATE,
        changeAddress: payer.deriveAddress(index, true),
      });
      return pearld.sendRawTransaction(payment.hex);
    },
    /** The address the last payPending paid from. */
    lastPayer: (): string => payer.deriveAddress(next - 1),
    /** An address outside every wallet here. */
    elsewhere: (n: number): string => payer.deriveAddress(1000 + n),
  };
}

/** What the wallet and the node must agree on for a transaction the wallet sent. */
export async function expectSendMatchesNode(wallet: PearlWallet, sent: SendResult, recipients: { address: string; amount: bigint }[]): Promise<void> {
  const view = await nodeView(sent.txid);
  expect(sent.fee).toBe(view.fee);
  expect(sent.vsize).toBe(view.vsize);
  expect(view.inputs.map(outpoint)).toEqual(sent.inputs.map(outpoint));
  expect(total(view.inputs)).toBe(total(sent.inputs));
  const outputs = [...recipients.map((r) => ({ address: r.address, value: r.amount })), ...(sent.change > 0n ? [{ address: sent.changeAddress, value: sent.change }] : [])];
  expect(view.outputs.map(({ address, value }) => ({ address, value }))).toEqual(outputs);

  expect(wallet.transaction(sent.txid)).toMatchObject({
    direction: 'outgoing',
    fee: view.fee,
    counterparties: recipients.map((r) => r.address),
    sent: total(view.inputs),
    received: sent.change,
    amount: -(recipients.reduce((sum, r) => sum + r.amount, 0n) + view.fee),
    hex: sent.hex,
    broadcast: true,
    missing: false,
  });
}
