// Address discovery for a BIP86 account: which receive and change addresses
// have been used, where the next unused one is, and what the account holds.
//
// Oyster restores a wallet by scanning each chain until a run of unused
// addresses as long as its recovery window, 250 (wallet/btcwallet.go:79,
// wallet/walletsetup.go:133), not BIP44's gap of 20. An account that skipped
// more than 20 addresses is restored in full by Oyster and would lose funds
// under the BIP44 limit, so 250 is the default here.

/**
 * BIP86 account discovery through a wallet backend, with Oyster's recovery
 * window.
 *
 * @module
 */

import type { WalletBackend, WalletBalance, WalletUtxo } from './backend.js';
import { sumBalance } from './backend.js';
import type { AccountUtxo } from './builder.js';
import type { PearlAccount } from './keys.js';
import { PearlError } from './errors.js';

/** The recovery window Oyster restores with. */
export const OYSTER_RECOVERY_WINDOW = 250;

/** Options for discoverAccount. */
export interface DiscoveryOptions {
  /** Consecutive unused addresses that end the scan of a chain. Default OYSTER_RECOVERY_WINDOW; BIP44 wallets use 20. */
  gap?: number;
  /** Addresses checked per round. Default 25. */
  batchSize?: number;
  /** Stops the scan between rounds. */
  signal?: AbortSignal;
}

/** An address of the account and where it sits: its index, and whether it is on the change chain. */
export interface DiscoveredAddress {
  address: string;
  index: number;
  change: boolean;
}

/** What discovery found on one chain of an account, receive or change. */
export interface DiscoveredChain {
  /** Addresses that have been paid, in index order. */
  used: DiscoveredAddress[];
  /** The index after the last used one: the next address to hand out. */
  nextIndex: number;
}

/** The result of discoverAccount. */
export interface AccountDiscovery {
  receive: DiscoveredChain;
  change: DiscoveredChain;
  /** Unspent outputs of the used addresses, each naming its child, as payFromAccount takes them. */
  utxos: (AccountUtxo & WalletUtxo)[];
  balance: WalletBalance;
}

/**
 * Scans an account's receive and change chains through a backend. A
 * watch-only account works as well as a signing one, since only addresses
 * are derived. An address counts as used once anything has paid it,
 * confirmed or not.
 *
 * Rejects with whatever the backend rejects with, such as MissingIndexError from
 * pearldBackend without --addrindex, and with the signal's reason when aborted.
 */
export async function discoverAccount(
  account: Pick<PearlAccount, 'deriveAddress'> & Partial<Pick<PearlAccount, 'extendedPublicKey'>>,
  backend: Pick<WalletBackend, 'getAddressActivity' | 'getUtxos' | 'network' | 'findUsed'>,
  options: DiscoveryOptions = {},
): Promise<AccountDiscovery> {
  const { gap = OYSTER_RECOVERY_WINDOW, batchSize = 25, signal } = options;
  if (!Number.isInteger(gap) || gap < 1) throw new RangeError('gap must be a positive integer');
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new RangeError('batchSize must be a positive integer');

  const xpub = account.extendedPublicKey?.();
  const usedAmong = async (batch: DiscoveredAddress[]): Promise<Set<string>> => {
    const addresses = batch.map((child) => child.address);
    if (backend.findUsed !== undefined) {
      if (xpub === undefined) return new Set(await backend.findUsed(addresses));
      return new Set(await backend.findUsed(addresses, [{ xpub, children: new Map(batch.map(({ address, index, change }) => [address, { change, index }])), gap }]));
    }
    const activity = await Promise.all(addresses.map((address) => backend.getAddressActivity(address)));
    return new Set(addresses.filter((_, i) => activity[i]!.length > 0));
  };

  const scan = async (change: boolean): Promise<DiscoveredChain> => {
    const used: DiscoveredAddress[] = [];
    let nextIndex = 0;
    for (let start = 0; start < nextIndex + gap; ) {
      signal?.throwIfAborted();
      const count = Math.min(batchSize, nextIndex + gap - start);
      const batch = Array.from({ length: count }, (_, i) => ({ address: account.deriveAddress(start + i, change), index: start + i, change }));
      const paid = await usedAmong(batch);
      for (const child of batch) {
        if (!paid.has(child.address)) continue;
        used.push(child);
        nextIndex = child.index + 1;
      }
      start += count;
    }
    return { used, nextIndex };
  };

  const receive = await scan(false);
  const change = await scan(true);
  const children = new Map([...receive.used, ...change.used].map((child) => [child.address, child]));
  const found = children.size === 0 ? [] : await backend.getUtxos([...children.keys()]);
  const utxos = found.map((utxo) => {
    const child = children.get(utxo.address);
    if (child === undefined) throw new PearlError('BACKEND_RESPONSE', `the backend returned an output for ${utxo.address}, which was not asked for`);
    return { ...utxo, index: child.index, change: child.change };
  });
  return { receive, change, utxos, balance: sumBalance(utxos, backend.network.coinbaseMaturity) };
}
