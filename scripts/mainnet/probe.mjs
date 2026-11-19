// What the node offers: getinfo, chain tip, and whether the address index
// and compact filters answer.
import { rpc, closeRpc } from './lib.mjs';

const info = await rpc('getinfo');
console.log('getinfo', JSON.stringify(info));
const best = await rpc('getbestblockhash');
console.log('best', best, 'count', await rpc('getblockcount'));
for (const [name, call] of [
  ['searchrawtransactions', () => rpc('searchrawtransactions', 'prl1pqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqzr5qy0', 1, 0, 1)],
  ['getcfilter', () => rpc('getcfilter', best, 0)],
  ['getcfilterheader', () => rpc('getcfilterheader', best, 0)],
  ['getrawtransaction(non-wallet, no txindex)', async () => {
    const block = await rpc('getblock', best, 1);
    return rpc('getrawtransaction', block.tx[block.tx.length - 1], 0);
  }],
  ['estimatefee', () => rpc('estimatefee', 6)],
]) {
  try {
    const r = await call();
    console.log(name, 'ok', JSON.stringify(r).slice(0, 120));
  } catch (error) {
    console.log(name, 'error', String(error.message).slice(0, 200));
  }
}
closeRpc();
