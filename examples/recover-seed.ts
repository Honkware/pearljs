/**
 * Why a restored wallet shows zero: diagnoseSeed scans every derivation
 * Pearl's wallets have used, deeper than a restore does, and says where the
 * coins are. A watch-only wallet then follows the account it recommends,
 * with a gap limit wide enough to reach every used address.
 *
 * The chain is pearljs/testing's SimulatedChain. Against a node, pass
 * pearldBackend or filterBackend from connectPearld instead.
 */
import { PearlWallet, createMemoryStore, deriveAccountFromSeed, diagnoseSeed, formatPearl, mnemonicToSeed, parsePearl } from 'pearljs';
import { SimulatedChain } from 'pearljs/testing';

const chain = new SimulatedChain();
const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

// Coins a restore misses: one address 300 past the last used one, and an
// account made with Oyster's createnewaccount.
const seed = mnemonicToSeed(phrase);
const account0 = deriveAccountFromSeed(seed, chain.network, 0);
chain.pay(account0.deriveAddress(0), parsePearl('1'));
chain.pay(account0.deriveAddress(300), parsePearl('25'));
chain.pay(deriveAccountFromSeed(seed, chain.network, 1).deriveAddress(0), parsePearl('4'));
chain.mine();

const report = await diagnoseSeed(phrase, chain, { gap: 400, accounts: 2, otherCoinType: false });
for (const found of report.variants) {
  const used = found.receive.used.length + found.change.used.length;
  console.log(found.variant.id, `${used} used`, formatPearl(found.balance.confirmed), 'PRL');
}
for (const reason of report.reasons) console.log(reason.code, reason.message);

const best = report.recommended!;
const wallet = await PearlWallet.create({
  store: createMemoryStore(),
  backend: chain,
  watchOnly: best.accountKey!,
  watchOnlyOrigin: best.origin!,
  gapLimit: best.requiredGap,
});
await wallet.sync();
console.log('watch-only wallet:', formatPearl(wallet.balance().confirmed), 'PRL with gap limit', best.requiredGap);
