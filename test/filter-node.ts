// A pearld served from a FakeChain (test/wallet-chain.ts): real serialized
// blocks with merkle roots and hashes, Pearl's basic filter of each block
// built from the scripts its outputs pay and its inputs spend, the filter
// header chain, the mempool, and the address index for pearldBackend to
// compare with. Its switches drop the address and transaction indexes,
// refuse what pearld refuses its limited user, hide the mempool, or serve a
// filter or block other than the honest one.

import {
  PEARLD_LIMITED_METHODS,
  PearlRpcError,
  blockHash,
  blockHashHex,
  buildBasicFilter,
  buildFilter,
  calculateMerkleRoot,
  encodeFilter,
  filterHeader,
  filterHeaderHex,
  filterKey,
  fromOutputScript,
  networks,
  serializeBlock,
  type CompactFilter,
  type PearlBlock,
  type Rpc,
  type Transaction,
} from '../src/index.js';
import type { FakeChain } from './wallet-chain.js';

const network = networks.regtest;
const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const reversed = (bytes: Uint8Array): string => hex(Uint8Array.from(bytes).reverse());
const prevTxid = (input: Transaction['ins'][number]): string => reversed(input.hash);
const rpcError = (method: string, code: number, message: string) => new PearlRpcError('rpc', method, `${message} (code ${code})`, { rpcCode: code });

interface Served {
  height: number;
  hash: string;
  block: PearlBlock;
  filter: CompactFilter;
  header: string;
}

export interface FakeNodeOptions {
  /** searchrawtransactions works. Default true. */
  addrIndex?: boolean;
  /** getrawtransaction finds confirmed transactions. Default true. */
  txIndex?: boolean;
  /** Refuse every method off pearld's limited-user list. */
  limited?: boolean;
  /** Answer getrawmempool with "method not found", as a node that cannot list it. */
  noMempool?: boolean;
}

export class FakeNode implements Rpc {
  readonly calls: string[] = [];
  /** Bytes of every reply as JSON would carry them, a rough count of what a sync costs. */
  replyBytes = 0;
  /** Extra items to put in a height's filter: a false positive the block does not back. */
  readonly extraFilterItems = new Map<number, Uint8Array[]>();
  /** Serve this header from getcfilterheader at a hash, instead of the honest one. */
  readonly lyingHeaders = new Map<string, string>();
  /** Serve the block at this height for getblock of another hash. */
  swapBlock: { asked: number; served: number } | null = null;
  #cache = new Map<string, Served>();

  constructor(
    readonly chain: FakeChain,
    readonly options: FakeNodeOptions = {},
  ) {}

  /** Every block the chain holds, served as pearld would see it. */
  blocks(): Served[] {
    const served: Served[] = [];
    let prev: Uint8Array = new Uint8Array(32);
    let prevHeader = '00'.repeat(32);
    const outputs = new Map<string, Uint8Array>();
    for (const fake of this.chain.blocks) {
      const id = `${fake.hash}:${hex(prev)}:${(this.extraFilterItems.get(fake.height) ?? []).map(hex).join(',')}`;
      let entry = this.#cache.get(id);
      const spent = fake.txs.flatMap((tx) => (tx.isCoinbase() ? [] : tx.ins.map((input) => outputs.get(`${prevTxid(input)}:${input.index}`)).filter((s) => s !== undefined)));
      if (entry === undefined) {
        const block: PearlBlock = {
          certificate: null,
          header: {
            version: 1,
            prevBlock: prev,
            merkleRoot: calculateMerkleRoot(fake.txs),
            timestamp: 1767225600 + fake.height * 600,
            bits: 0x207fffff,
            proofCommitment: new Uint8Array(32),
          },
          transactions: fake.txs,
        };
        const hash = blockHashHex(block.header);
        const extra = this.extraFilterItems.get(fake.height);
        const honest = buildBasicFilter(block, spent);
        const filter = extra === undefined ? honest : withItems(block, spent, extra, hash);
        const header = filterHeaderHex(filterHeader(filter, prevHeader));
        entry = { height: fake.height, hash, block, filter, header };
        this.#cache.set(id, entry);
      }
      for (const tx of fake.txs) tx.outs.forEach((out, vout) => outputs.set(`${tx.getId()}:${vout}`, Uint8Array.from(out.script)));
      served.push(entry);
      prev = blockHash(entry.block.header);
      prevHeader = entry.header;
    }
    return served;
  }

  async call<T = unknown>(method: string, params: readonly unknown[] = []): Promise<T> {
    this.calls.push(method);
    const result = this.#answer(method, params);
    this.replyBytes += JSON.stringify(result, (_k, v: unknown) => (typeof v === 'bigint' ? Number(v) : v))?.length ?? 4;
    return result as T;
  }

  count(method: string): number {
    return this.calls.filter((call) => call === method).length;
  }

  #answer(method: string, params: readonly unknown[]): unknown {
    if (this.options.limited === true && !PEARLD_LIMITED_METHODS.has(method)) throw rpcError(method, -32603, 'limited user not authorized for this method');
    const blocks = this.blocks();
    const tip = blocks.at(-1)!;
    const byHash = (hash: unknown) => {
      const found = blocks.find((block) => block.hash === hash);
      if (found === undefined) throw rpcError(method, -5, 'Block not found');
      return found;
    };
    const located = (txid: unknown) => {
      for (const block of blocks) {
        const index = block.block.transactions.findIndex((tx) => tx.getId() === txid);
        if (index >= 0) return { tx: block.block.transactions[index]!, block };
      }
      const pooled = this.chain.mempool.get(txid as string);
      return pooled === undefined ? null : { tx: pooled, block: null };
    };
    const verbose = (tx: Transaction, block: Served | null) => ({
      txid: tx.getId(),
      hex: tx.toHex(),
      vin: tx.ins.map((input) =>
        tx.isCoinbase() ? { coinbase: hex(input.script), sequence: input.sequence } : { txid: prevTxid(input), vout: input.index, scriptSig: { asm: '', hex: '' }, sequence: input.sequence },
      ),
      vout: tx.outs.map((out, n) => ({ value: out.value, n, scriptPubKey: { asm: '', type: 'witness_v1_taproot', address: addressOf(out.script) } })),
      ...(block === null ? {} : { blockhash: block.hash, confirmations: tip.height - block.height + 1, blocktime: block.block.header.timestamp }),
    });
    switch (method) {
      case 'getbestblock':
        return { height: tip.height, hash: tip.hash };
      case 'getblockcount':
        return tip.height;
      case 'getblockhash': {
        const block = blocks[params[0] as number];
        if (block === undefined) throw rpcError(method, -1, 'Block number out of range');
        return block.hash;
      }
      case 'getblockheader': {
        const block = byHash(params[0]);
        return { hash: block.hash, height: block.height, confirmations: tip.height - block.height + 1 };
      }
      case 'getcfilter':
        return hex(encodeFilter(byHash(params[0]).filter));
      case 'getcfilterheader': {
        const block = byHash(params[0]);
        return this.lyingHeaders.get(block.hash) ?? block.header;
      }
      case 'getblock': {
        let block = byHash(params[0]);
        if (this.swapBlock !== null && block.height === this.swapBlock.asked) block = blocks[this.swapBlock.served]!;
        if (params[1] === 0) return hex(serializeBlock(block.block));
        return { hash: block.hash, height: block.height, tx: block.block.transactions.map((tx) => tx.getId()) };
      }
      case 'getrawmempool':
        if (this.options.noMempool === true) throw rpcError(method, -32601, 'Method not found');
        return [...this.chain.mempool.keys()];
      case 'getrawtransaction': {
        const found = located(params[0]);
        if (found === null || (found.block !== null && this.options.txIndex === false)) throw rpcError(method, -5, 'No information available about transaction');
        return params[1] === 0 ? found.tx.toHex() : verbose(found.tx, found.block);
      }
      case 'searchrawtransactions': {
        if (this.options.addrIndex === false) throw rpcError(method, -1, 'Address index must be enabled (--addrindex)');
        const address = params[0] as string;
        const all = [...blocks.flatMap((block) => block.block.transactions.map((tx) => ({ tx, block }))), ...[...this.chain.mempool.values()].map((tx) => ({ tx, block: null }))];
        const ownOutputs = new Set<string>();
        const list = all.filter(({ tx }) => {
          let touches = false;
          tx.outs.forEach((out, vout) => {
            if (addressOf(out.script) !== address) return;
            ownOutputs.add(`${tx.getId()}:${vout}`);
            touches = true;
          });
          return touches || tx.ins.some((input) => ownOutputs.has(`${prevTxid(input)}:${input.index}`));
        });
        const page = list.slice(params[2] as number, (params[2] as number) + (params[3] as number));
        if (page.length === 0) throw rpcError(method, -5, 'No information available about address');
        return page.map(({ tx, block }) => verbose(tx, block));
      }
      case 'gettxout': {
        const [txid, vout] = params as [string, number];
        const found = located(txid);
        const spent = [...blocks.flatMap((block) => block.block.transactions)].some((tx) => tx.ins.some((input) => prevTxid(input) === txid && input.index === vout));
        if (found === null || found.tx.outs[vout] === undefined || spent || (found.block === null && params[2] === false)) return null;
        const out = found.tx.outs[vout]!;
        return { bestblock: tip.hash, confirmations: found.block === null ? 0 : tip.height - found.block.height + 1, value: out.value, scriptPubKey: { address: addressOf(out.script) }, coinbase: found.tx.isCoinbase() };
      }
      case 'gettxspendingprevout':
        return (params[0] as { txid: string; vout: number }[]).map(({ txid, vout }) => {
          const spender = [...this.chain.mempool.values()].find((tx) => tx.ins.some((input) => prevTxid(input) === txid && input.index === vout));
          return spender === undefined ? { txid, vout } : { txid, vout, spendingtxid: spender.getId() };
        });
      case 'getinfo':
        return { relayfee: 1000n };
      case 'estimatefee':
        return 0n;
      case 'sendrawtransaction':
        return this.chain.broadcast(params[0] as string).catch((err: unknown) => {
          if (err instanceof PearlRpcError) throw err;
          throw rpcError(method, -22, `TX decode failed: ${(err as Error).message}`);
        });
      default:
        throw rpcError(method, -32601, 'Method not found');
    }
  }
}

function addressOf(script: Uint8Array): string | undefined {
  try {
    return fromOutputScript(Uint8Array.from(script), network);
  } catch {
    return undefined;
  }
}

// The basic filter with items the block does not hold.
function withItems(block: PearlBlock, spent: Uint8Array[], extra: Uint8Array[], hash: string): CompactFilter {
  const items = block.transactions.flatMap((tx) => tx.outs.map((out) => Uint8Array.from(out.script))).filter((s) => s.length > 0 && s[0] !== 0x6a);
  return buildFilter(filterKey(hash), [...items, ...spent, ...extra]);
}
