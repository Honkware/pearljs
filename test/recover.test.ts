// Seed recovery: pearljs derives the addresses Oyster's own wallet code hands
// out (vectors.recovery, from Oyster's loader and address manager), reads
// seeds as the desktop wallet does (its parseSeedInput, run as shipped), and
// diagnoseSeed finds coins on every variant on a simulated chain.

import { BIP32Factory } from 'bip32';
import * as ecc from 'tiny-secp256k1';
import { describe, expect, it } from 'vitest';
import {
  createMemoryStore,
  deriveAccountFromSeed,
  diagnoseAccount,
  diagnoseSeed,
  mnemonicToSeed,
  networks,
  normalizeMnemonic,
  oysterPqAddress,
  OYSTER_RECOVERY_WINDOW,
  parsePearl,
  parseSeedInput,
  keyPathAddress,
  sweepKey,
  PearlError,
  PearlWallet,
  seedFromInput,
} from '../src/index.js';
import type { PearlNetwork, WalletBackend } from '../src/index.js';
import { SimulatedChain } from '../src/testing.js';
import vectors from '../vectors/pearl-go.json' with { type: 'json' };
import desktop from './fixtures/desktop-seed-input.json' with { type: 'json' };
import { bytesToHex, hexToBytes } from './vector-helpers.js';

const bip32 = BIP32Factory(ecc);
const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const byName = (name: string): PearlNetwork => networks[name as keyof typeof networks];

describe("Oyster's derivations", () => {
  it('restores with the recovery window Oyster creates its loader with', () => {
    expect(vectors.recovery.recoveryWindow).toBe(OYSTER_RECOVERY_WINDOW);
  });

  for (const expected of vectors.recovery.wallets) {
    it(`derives the first addresses Oyster hands out for ${expected.name} on ${expected.network}`, () => {
      const network = byName(expected.network);
      if (expected.input.trim() === normalizeMnemonic(expected.input) || expected.kind === 'hex') {
        expect(bytesToHex(seedFromInput(expected.input))).toBe(expected.seed);
      } else {
        // Oyster hashed the phrase with its odd whitespace; the desktop wallet would not.
        expect(bytesToHex(seedFromInput(expected.input))).not.toBe(expected.seed);
      }
      const account = deriveAccountFromSeed(hexToBytes(expected.seed), network, expected.account);
      expect(account.path).toBe(expected.accountPath);
      if (expected.network === 'simnet') {
        // Oyster writes every test network's account key with vpub's version
        // bytes (cloneKeyWithVersion), simnet's included, whose chain
        // parameters say spub; the key itself is the same.
        const oysters = bip32.fromBase58(expected.accountXpub, { wif: 0, bip32: { public: networks.testnet.hdPublicKeyId, private: networks.testnet.hdPrivateKeyId } });
        expect(account.extendedPublicKey().startsWith('spub')).toBe(true);
        expect(bytesToHex(oysters.publicKey)).toBe(bytesToHex(account.node.publicKey));
        expect(bytesToHex(oysters.chainCode)).toBe(bytesToHex(account.node.chainCode));
      } else {
        expect(account.extendedPublicKey()).toBe(expected.accountXpub);
      }
      expect(expected.receive.map((_, i) => account.deriveAddress(i))).toEqual(expected.receive);
      expect(expected.change.map((_, i) => account.deriveAddress(i, true))).toEqual(expected.change);
    });
  }

  it('reads seed input as the desktop wallet does before handing it to Oyster', () => {
    for (const { input, result } of desktop.cases) {
      const ours = parseSeedInput(input);
      expect(ours.kind).toBe(result.kind);
      if (result.kind === 'mnemonic') expect(normalizeMnemonic(input)).toBe((result as { normalized: string }).normalized);
      if (result.kind === 'hex') expect(bytesToHex(seedFromInput(input))).toBe((result as { normalized: string }).normalized);
    }
    const restored = vectors.recovery.wallets.find((item) => item.name === 'abandon' && item.network === 'mainnet')!;
    for (const { input, result } of desktop.cases) {
      if (result.kind === 'mnemonic' && (result as { normalized: string }).normalized === ABANDON) {
        expect(bytesToHex(seedFromInput(input))).toBe(restored.seed);
      }
    }
  });

  for (const expected of vectors.recovery.pqAddresses) {
    it(`derives Oyster's pq=true address at ${expected.path} on ${expected.network}`, () => {
      const [, , , , branch, index] = expected.path.split('/');
      const network = byName(expected.network);
      expect(oysterPqAddress(mnemonicToSeed(expected.mnemonic), network, Number(index), branch === '1')).toBe(expected.address);
      expect(expected.address).not.toBe(expected.plainAddress);
    });
  }
});

function chainWithFunds(): { chain: SimulatedChain; network: PearlNetwork } {
  const chain = new SimulatedChain();
  return { chain, network: chain.network };
}

describe('diagnoseSeed', () => {
  it('finds coins past the recovery window, on other accounts, coin types and as-typed phrases, and says why', async () => {
    const { chain, network } = chainWithFunds();
    const seed = mnemonicToSeed(ABANDON);
    const main = deriveAccountFromSeed(seed, network, 0);
    chain.pay(main.deriveAddress(0), parsePearl('1'));
    chain.pay(main.deriveAddress(300), parsePearl('2'));
    chain.pay(main.deriveAddress(4, true), parsePearl('3'));
    chain.pay(deriveAccountFromSeed(seed, network, 1).deriveAddress(0), parsePearl('4'));
    const typed = ABANDON.replace(' about', '\nabout');
    const typedSeed = hexToBytes(vectors.recovery.wallets.find((item) => item.name === 'abandon-newlines')!.seed);
    chain.pay(deriveAccountFromSeed(typedSeed, network, 0).deriveAddress(2), parsePearl('5'));
    chain.pay(deriveAccountFromSeed(seed, { ...network, coinType: 808276 }, 0).deriveAddress(0), parsePearl('6'));
    chain.mine();

    const report = await diagnoseSeed(typed, chain, { gap: 400, accounts: 2 });
    const byId = new Map(report.variants.map((v) => [v.variant.id, v]));
    expect([...byId.keys()]).toEqual([
      "oyster m/86'/1'/0'",
      "oyster m/86'/1'/1'",
      "oyster m/86'/808276'/0'",
      "oyster m/86'/808276'/1'",
      "as-typed m/86'/1'/0'",
      "as-typed m/86'/1'/1'",
      "as-typed m/86'/808276'/0'",
      "as-typed m/86'/808276'/1'",
    ]);
    const primary = byId.get("oyster m/86'/1'/0'")!;
    expect(primary.balance.confirmed).toBe(parsePearl('6'));
    expect(primary.receive.used.map((child) => child.index)).toEqual([0, 300]);
    expect(primary.receive.nextIndex).toBe(301);
    expect(primary.change.used.map((child) => child.index)).toEqual([4]);
    expect(primary.requiredGap).toBe(300);
    expect(primary.accountKey).toBe(main.extendedPublicKey());
    expect(primary.origin).toEqual({ masterFingerprint: main.masterFingerprint, path: "m/86'/1'/0'" });
    expect(byId.get("oyster m/86'/1'/1'")!.balance.confirmed).toBe(parsePearl('4'));
    expect(byId.get("as-typed m/86'/1'/0'")!.balance.confirmed).toBe(parsePearl('5'));
    expect(byId.get("oyster m/86'/808276'/0'")!.balance.confirmed).toBe(parsePearl('6'));
    expect(report.balance.confirmed).toBe(parsePearl('21'));
    expect(report.recommended).toBe(primary);

    const codes = report.reasons.map((reason) => [reason.code, reason.variant]);
    expect(codes).toEqual([
      ['BEYOND_RECOVERY_WINDOW', "oyster m/86'/1'/0'"],
      ['OTHER_DERIVATION', "oyster m/86'/1'/1'"],
      ['OTHER_DERIVATION', "oyster m/86'/808276'/0'"],
      ['OTHER_DERIVATION', "as-typed m/86'/1'/0'"],
    ]);
    expect(report.reasons[0]!.addresses).toEqual([main.deriveAddress(300)]);
    expect(report.reasons[0]!.message).toContain('they hold 2 PRL');
    expect(report.reasons[3]!.message).toContain("typed into Oyster's command line");
  });

  it('stops a chain after gap unused addresses, so a shallower scan misses what lies beyond', async () => {
    const { chain, network } = chainWithFunds();
    const main = deriveAccountFromSeed(mnemonicToSeed(ABANDON), network, 0);
    chain.pay(main.deriveAddress(30), parsePearl('1'));
    chain.mine();
    const shallow = await diagnoseSeed(ABANDON, chain, { gap: 30, accounts: 1, otherCoinType: false });
    expect(shallow.variants).toHaveLength(1);
    expect(shallow.reasons.map((reason) => reason.code)).toEqual(['NO_ACTIVITY']);
    expect(shallow.recommended).toBeNull();
    const deep = await diagnoseSeed(ABANDON, chain, { gap: 31, accounts: 1, otherCoinType: false });
    expect(deep.balance.confirmed).toBe(parsePearl('1'));
    expect(deep.reasons).toEqual([]);
  });

  it('reports immature coinbases, mempool payments and spent addresses', async () => {
    const { chain, network } = chainWithFunds();
    const main = deriveAccountFromSeed(mnemonicToSeed(ABANDON), network, 0);
    chain.mine(1, { coinbaseTo: main.deriveAddress(0), value: parsePearl('7') });
    chain.pay(main.deriveAddress(1), parsePearl('2'));
    const report = await diagnoseSeed(ABANDON, chain, { gap: 20, accounts: 1, otherCoinType: false });
    expect(report.balance).toEqual({ confirmed: 0n, unconfirmed: parsePearl('2'), immature: parsePearl('7') });
    expect(report.reasons.map((reason) => reason.code)).toEqual(['IMMATURE_COINBASE', 'UNCONFIRMED']);

    expect((await diagnoseSeed(ABANDON, new SimulatedChain(), { gap: 5, accounts: 1, otherCoinType: false })).reasons.map((reason) => reason.code)).toEqual([
      'NO_ACTIVITY',
    ]);

    const spent = new SimulatedChain();
    const key = bip32.fromSeed(mnemonicToSeed(ABANDON)).derivePath("m/86'/1'/0'/0/0").privateKey!;
    spent.pay(keyPathAddress(key, spent.network), parsePearl('1'));
    spent.mine();
    const sweep = sweepKey(key, {
      network: spent.network,
      utxos: await spent.getUtxos([keyPathAddress(key, spent.network)]),
      destination: spent.faucet.address,
      feeRate: 2000n,
    });
    spent.accept(sweep.transaction);
    spent.mine();
    const after = await diagnoseSeed(ABANDON, spent, { gap: 5, accounts: 1, otherCoinType: false });
    expect(after.recommended!.receive.used.map((child) => child.index)).toEqual([0]);
    expect(after.reasons.map((reason) => reason.code)).toEqual(['SPENT']);
  });

  it('tries BIP39 passphrases only when asked', async () => {
    const { chain, network } = chainWithFunds();
    chain.pay(deriveAccountFromSeed(mnemonicToSeed(ABANDON, 'TREZOR'), network, 0).deriveAddress(0), parsePearl('1'));
    chain.mine();
    const without = await diagnoseSeed(ABANDON, chain, { gap: 5, accounts: 1, otherCoinType: false });
    expect(without.balance.confirmed).toBe(0n);
    const withIt = await diagnoseSeed(ABANDON, chain, { gap: 5, accounts: 1, otherCoinType: false, passphrases: ['TREZOR'] });
    expect(withIt.recommended!.variant).toMatchObject({ source: 'passphrase', oysterScans: false });
    expect(withIt.reasons[0]!.message).toContain('BIP39 passphrase');
  });

  it('names each passphrase variant by its place in the list, never by the passphrase', async () => {
    const { chain, network } = chainWithFunds();
    chain.pay(deriveAccountFromSeed(mnemonicToSeed(ABANDON, 'second'), network, 0).deriveAddress(0), parsePearl('1'));
    chain.mine();
    const report = await diagnoseSeed(ABANDON, chain, { gap: 2, accounts: 1, otherCoinType: false, passphrases: ['first', '', 'second'] });
    expect(report.variants.map((v) => [v.variant.id, v.variant.passphraseIndex])).toEqual([
      ["oyster m/86'/1'/0'", null],
      ["passphrase[0] m/86'/1'/0'", 0],
      ["passphrase[2] m/86'/1'/0'", 2],
    ]);
    expect(report.recommended!.variant.id).toBe("passphrase[2] m/86'/1'/0'");
    expect(report.reasons.map((reason) => reason.variant)).toEqual(["passphrase[2] m/86'/1'/0'"]);
    expect(JSON.stringify(report, (_, value: unknown) => (typeof value === 'bigint' ? String(value) : value))).not.toContain('second');
  });

  it('finds Oyster pq=true addresses when asked to look at them', async () => {
    const { chain, network } = chainWithFunds();
    const seed = mnemonicToSeed(ABANDON);
    chain.pay(oysterPqAddress(seed, network, 0, true), parsePearl('3'));
    chain.mine();
    const report = await diagnoseSeed(seed, chain, { gap: 5, accounts: 1, otherCoinType: false, pqAddresses: 1 });
    const pq = report.variants.find((v) => v.variant.pq)!;
    expect(pq.change.used.map((child) => child.index)).toEqual([0]);
    expect(pq.accountKey).toBeNull();
    expect(report.reasons.map((reason) => reason.code)).toEqual(['OTHER_DERIVATION']);
    expect(report.reasons[0]!.message).toContain('pq=true');
  });

  it('reads hex seeds and refuses what is neither a phrase nor a seed', async () => {
    const { chain, network } = chainWithFunds();
    const hex = vectors.recovery.wallets.find((item) => item.name === 'hex-seed')!;
    chain.pay(deriveAccountFromSeed(hexToBytes(hex.seed), network, 0).deriveAddress(0), parsePearl('1'));
    chain.mine();
    const report = await diagnoseSeed(`0x${hex.input}`, chain, { gap: 5, accounts: 1, otherCoinType: false });
    expect(report.recommended!.variant).toMatchObject({ source: 'hex', oysterScans: true });
    await expect(diagnoseSeed('abandon abandon', chain)).rejects.toMatchObject({ code: 'SEED_INVALID' });
    await expect(diagnoseSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandn', chain)).rejects.toThrow(
      'a word is not in the BIP39 list',
    );
  });

  it('names P2MR addresses the backend cannot answer for', async () => {
    const { chain } = chainWithFunds();
    const p2mr = vectors.addresses.find((item) => item.network === 'regtest' && item.kind === 'p2mr')!.address;
    const blind: Pick<WalletBackend, 'getAddressActivity' | 'getUtxos' | 'getBalance' | 'network'> = {
      network: chain.network,
      getAddressActivity: (address) => chain.getAddressActivity(address),
      getUtxos: (watched) => chain.getUtxos(watched),
      getBalance: async () => {
        throw new PearlError('BACKEND_UNSUPPORTED', 'no P2MR here');
      },
    };
    const report = await diagnoseSeed(ABANDON, blind, { gap: 3, accounts: 1, otherCoinType: false, p2mrAddresses: [p2mr] });
    expect(report.reasons.map((reason) => reason.code)).toEqual(['P2MR_NOT_SEEN', 'NO_ACTIVITY']);
    expect(report.reasons[0]!.addresses).toEqual([p2mr]);
  });

  it('counts coins on the P2MR addresses it is given before deciding there is no activity', async () => {
    const { chain } = chainWithFunds();
    const p2mr = vectors.addresses.find((item) => item.network === 'regtest' && item.kind === 'p2mr')!.address;
    chain.pay(p2mr, parsePearl('5'));
    chain.mine();
    const report = await diagnoseSeed(ABANDON, chain, { gap: 5, accounts: 1, otherCoinType: false, p2mrAddresses: [p2mr] });
    expect(report.balance.confirmed).toBe(parsePearl('5'));
    expect(report.reasons).toEqual([]);

    const spent = new SimulatedChain();
    const main = deriveAccountFromSeed(mnemonicToSeed(ABANDON), spent.network, 0);
    spent.pay(main.deriveAddress(0), parsePearl('1'));
    spent.mine();
    spent.pay(p2mr, parsePearl('2'));
    const key = bip32.fromSeed(mnemonicToSeed(ABANDON)).derivePath("m/86'/1'/0'/0/0").privateKey!;
    const sweep = sweepKey(key, { network: spent.network, utxos: await spent.getUtxos([main.deriveAddress(0)]), destination: spent.faucet.address, feeRate: 2000n });
    spent.accept(sweep.transaction);
    spent.mine();
    const after = await diagnoseSeed(ABANDON, spent, { gap: 5, accounts: 1, otherCoinType: false, p2mrAddresses: [p2mr] });
    expect(after.balance.confirmed).toBe(parsePearl('2'));
    expect(after.reasons.map((reason) => reason.code)).toEqual([]);
  });

  it('sends only addresses to the backend', async () => {
    const { chain } = chainWithFunds();
    const asked: string[] = [];
    const watching: Pick<WalletBackend, 'getAddressActivity' | 'getUtxos' | 'getBalance' | 'network'> = {
      network: chain.network,
      getAddressActivity: (address) => {
        asked.push(address);
        return chain.getAddressActivity(address);
      },
      getUtxos: (watched) => chain.getUtxos(watched),
      getBalance: (watched) => chain.getBalance(watched),
    };
    await diagnoseSeed(ABANDON, watching, { gap: 3, accounts: 1 });
    expect(asked.length).toBe(12);
    expect(asked.every((address) => address.startsWith('rprl1p'))).toBe(true);
  });
});

describe('account keys and the backend', () => {
  const recording = (network: PearlNetwork, calls: unknown[][]): Pick<WalletBackend, 'getAddressActivity' | 'getUtxos' | 'getBalance' | 'network' | 'findUsed'> => ({
    network,
    getAddressActivity: async () => [],
    getUtxos: async () => [],
    getBalance: async () => ({ confirmed: 0n, unconfirmed: 0n, immature: 0n }),
    findUsed: async (...args: unknown[]) => {
      calls.push(args);
      return [];
    },
  });

  it('gives findUsed only addresses unless shareAccountKeys is set for the call', async () => {
    const network = networks.regtest;
    const calls: unknown[][] = [];
    await diagnoseSeed(ABANDON, recording(network, calls), { gap: 3, passphrases: ['secret one', 'secret two'] });
    const main = deriveAccountFromSeed(mnemonicToSeed(ABANDON), network, 0);
    await diagnoseAccount(main.extendedPublicKey(), recording(network, calls), { gap: 3 });
    await diagnoseAccount(main, recording(network, calls), { gap: 3 });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((args) => args.length === 1)).toBe(true);

    const shared: unknown[][] = [];
    await diagnoseSeed(ABANDON, recording(network, shared), { gap: 3, accounts: 1, otherCoinType: false, shareAccountKeys: true });
    await diagnoseAccount(main.extendedPublicKey(), recording(network, shared), { gap: 3, shareAccountKeys: true });
    const xpubs = new Set(shared.flatMap(([, accounts]) => (accounts as { xpub: string }[]).map((account) => account.xpub)));
    expect([...xpubs]).toEqual([main.extendedPublicKey()]);
  });
});

describe('diagnoseAccount and a watch-only wallet', () => {
  it('scans an account key without the seed, and a watch-only wallet from it holds what the report found', async () => {
    const { chain, network } = chainWithFunds();
    const main = deriveAccountFromSeed(mnemonicToSeed(ABANDON), network, 0);
    chain.pay(main.deriveAddress(0), parsePearl('1'));
    chain.pay(main.deriveAddress(280), parsePearl('2'));
    chain.pay(main.deriveAddress(3, true), parsePearl('3'));
    chain.mine();

    const seedReport = await diagnoseSeed(ABANDON, chain, { gap: 300, accounts: 1, otherCoinType: false });
    const best = seedReport.recommended!;
    const keyless = await diagnoseAccount(best.accountKey!, chain, { gap: 300, origin: best.origin! });
    expect(keyless.balance).toEqual(best.balance);
    expect(keyless.variants[0]!.receive.used.map((child) => child.address)).toEqual(best.receive.used.map((child) => child.address));
    expect(keyless.reasons.map((reason) => reason.code)).toEqual(['BEYOND_RECOVERY_WINDOW']);
    const bare = await diagnoseAccount(best.accountKey!, chain, { gap: 300 });
    expect(bare.variants[0]!.origin).toBeNull();
    expect(bare.reasons.map((reason) => reason.code)).toEqual(['BEYOND_RECOVERY_WINDOW']);

    const wallet = await PearlWallet.create({
      store: createMemoryStore(),
      backend: chain,
      watchOnly: best.accountKey!,
      watchOnlyOrigin: best.origin!,
      gapLimit: best.requiredGap,
    });
    await wallet.sync();
    expect(wallet.balance().confirmed).toBe(best.balance.confirmed);
    expect(wallet.balance().confirmed).toBe(parsePearl('6'));

    const shallow = await PearlWallet.create({ store: createMemoryStore(), backend: chain, watchOnly: best.accountKey! });
    await shallow.sync();
    expect(shallow.balance().confirmed).toBe(parsePearl('4'));
  });
});
