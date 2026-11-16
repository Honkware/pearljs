// pearld's JSON-RPC over a simulated chain: the methods the SDK's backends,
// follower and clients call, answered with the fields, codes and messages
// of node/rpcserver.go. A reply is written as JSON text and read back the
// way the clients read a server's, so amounts and options behave the same.

import { decodeAddress, fromOutputScript, toOutputScript } from '../address.js';
import { serializeBlock, serializeCertificate } from '../block.js';
import { blockStrippedSize, blockVsize } from '../block.js';
import { serializeBlockHeader } from '../blockheader.js';
import { difficultyForBits } from '../consensus.js';
import { hash256 } from '../crypto.js';
import { PearlRpcError } from '../errors.js';
import { encodeFilter, filterHeaderHex } from '../gcs.js';
import { concat, toHex } from '../internal/bytes.js';
import { PrlAmount, encodeJson, readReply } from '../internal/rpc-wire.js';
import { PearldRpc } from '../rpc.js';
import type { CallOptions } from '../rpc.js';
import { classifyOutputScript } from '../script.js';
import { scriptToAsm } from '../scripttools.js';
import { parseTransaction } from '../transaction.js';
import type { Transaction } from '../transaction.js';
import { SimulatedRefusal } from './chain.js';
import type { SimulatedBlock, SimulatedChain } from './chain.js';

// btcjson's codes for what the handlers here refuse.
const MISC = -1;
const INVALID_ADDRESS_OR_KEY = -5;
const INVALID_PARAMETER = -8;
const DESERIALIZATION = -22;
const INVALID_PARAMS = -32602;
const METHOD_NOT_FOUND = -32601;
const INTERNAL = -32603;
const MAX_SEARCH_COUNT = 10000;
const MAX_HEADERS = 100;
const ZERO_HASH = '00'.repeat(32);
const SCRIPT_TYPES = { p2tr: 'witness_v1_taproot', p2mr: 'witness_v2_merkleroot', nulldata: 'nulldata', nonstandard: 'nonstandard' } as const;

const prevTxid = (input: Transaction['ins'][number]): string => toHex(Uint8Array.from(input.hash).reverse());

// wire.MsgTx.WitnessHash: of the whole serialization, for a coinbase too.
const witnessHash = (tx: Transaction): string => toHex(hash256(tx.toBuffer()).reverse());

function str(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new SimulatedRefusal(INVALID_PARAMS, `${name} must be a string`);
  return value;
}

function int(value: unknown, name: string, fallback?: number): number {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback;
    throw new SimulatedRefusal(INVALID_PARAMS, `${name} is required`);
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new SimulatedRefusal(INVALID_PARAMS, `${name} must be an integer`);
  return value;
}

function scriptPubKey(script: Uint8Array, chain: SimulatedChain, withHex = true): Record<string, unknown> {
  const type = classifyOutputScript(script);
  const address = type === 'p2tr' || type === 'p2mr' ? fromOutputScript(script, chain.network) : undefined;
  return {
    asm: scriptToAsm(script),
    ...(withHex ? { hex: toHex(script) } : {}),
    ...(address === undefined ? {} : { reqSigs: 1 }),
    type: SCRIPT_TYPES[type],
    ...(address === undefined ? {} : { address, addresses: [address] }),
  };
}

function vout(tx: Transaction, chain: SimulatedChain): unknown[] {
  return tx.outs.map((out, n) => ({ value: new PrlAmount(out.value), n, scriptPubKey: scriptPubKey(out.script, chain) }));
}

function vin(tx: Transaction, chain: SimulatedChain, vinExtra = false): unknown[] {
  if (tx.isCoinbase()) {
    const input = tx.ins[0]!;
    return [{ coinbase: toHex(input.script), sequence: input.sequence, ...(input.witness.length > 0 ? { witness: input.witness.map(toHex) } : {}) }];
  }
  return tx.ins.map((input) => {
    const spent = vinExtra ? chain.output(prevTxid(input), input.index) : null;
    const type = spent === null ? 'nonstandard' : classifyOutputScript(spent.script);
    return {
      txid: prevTxid(input),
      vout: input.index,
      scriptSig: { asm: scriptToAsm(input.script), hex: toHex(input.script) },
      ...(input.witness.length > 0 ? { txinwitness: input.witness.map(toHex) } : {}),
      ...(spent === null
        ? {}
        : { prevOut: { addresses: type === 'p2tr' || type === 'p2mr' ? [fromOutputScript(spent.script, chain.network)] : [], value: new PrlAmount(spent.value) } }),
      sequence: input.sequence,
    };
  });
}

// createTxRawResult: block fields only for a mined transaction.
function rawResult(tx: Transaction, block: SimulatedBlock | null, chain: SimulatedChain): Record<string, unknown> {
  return {
    hex: tx.toHex(),
    txid: tx.getId(),
    hash: witnessHash(tx),
    size: tx.byteLength(),
    vsize: tx.virtualSize(),
    version: tx.version,
    locktime: tx.locktime,
    vin: vin(tx, chain),
    vout: vout(tx, chain),
    ...(block === null ? {} : { blockhash: block.hash, confirmations: chain.height - block.height + 1, time: block.time, blocktime: block.time }),
  };
}

function blockOf(chain: SimulatedChain, hash: unknown): SimulatedBlock {
  const block = chain.block(str(hash, 'hash'));
  if (block === null) throw new SimulatedRefusal(INVALID_ADDRESS_OR_KEY, 'Block not found');
  return block;
}

function headerFields(block: SimulatedBlock, chain: SimulatedChain): Record<string, unknown> {
  const { header } = block.block;
  const active = chain.isActive(block);
  const next = active ? chain.blocks[block.height + 1] : undefined;
  return {
    hash: block.hash,
    confirmations: active ? chain.height - block.height + 1 : -1,
    height: block.height,
    version: header.version,
    versionHex: header.version.toString(16).padStart(8, '0'),
    merkleroot: toHex(Uint8Array.from(header.merkleRoot).reverse()),
    time: header.timestamp,
    bits: header.bits.toString(16).padStart(8, '0'),
    difficulty: difficultyForBits(header.bits, chain.network),
    previousblockhash: block.parent,
    ...(next === undefined ? {} : { nextblockhash: next.hash }),
    proofcommitment: toHex(Uint8Array.from(header.proofCommitment).reverse()),
  };
}

function address(chain: SimulatedChain, value: unknown): string {
  const text = str(value, 'address');
  try {
    toOutputScript(text, chain.network);
  } catch (err) {
    throw new SimulatedRefusal(INVALID_ADDRESS_OR_KEY, `Invalid address or key: ${(err as Error).message}`);
  }
  return text;
}

function needTxIndex(chain: SimulatedChain): void {
  if (!chain.txindex) throw new SimulatedRefusal(INVALID_ADDRESS_OR_KEY, 'The transaction index must be enabled to query the blockchain (specify --txindex)');
}

type Handler = (chain: SimulatedChain, params: readonly unknown[]) => unknown;

const handlers: Record<string, Handler> = {
  getblockcount: (chain) => chain.height,
  getbestblockhash: (chain) => chain.tip.hash,
  getbestblock: (chain) => ({ hash: chain.tip.hash, height: chain.height }),
  getdifficulty: (chain) => difficultyForBits(chain.tip.block.header.bits, chain.network),
  getconnectioncount: () => 0,
  getpeerinfo: () => [],

  getblockhash(chain, [height]) {
    const block = chain.blocks[int(height, 'index')];
    if (block === undefined) throw new SimulatedRefusal(MISC, 'Block number out of range');
    return block.hash;
  },

  getblock(chain, [hash, verbosity]) {
    const block = blockOf(chain, hash);
    const level = int(verbosity, 'verbosity', 1);
    if (level === 0) return toHex(serializeBlock(block.block));
    const { previousblockhash, nextblockhash, proofcommitment, time, bits, difficulty, merkleroot, ...head } = headerFields(block, chain);
    return {
      ...head,
      size: serializeBlock(block.block).length,
      strippedsize: blockStrippedSize(block.block),
      vsize: blockVsize(block.block),
      merkleroot,
      ...(level === 1 ? { tx: block.txs.map((tx) => tx.getId()) } : {}),
      time,
      bits,
      difficulty,
      previousblockhash,
      ...(nextblockhash === undefined ? {} : { nextblockhash }),
      proofcommitment,
      ...(level === 1 ? {} : { rawtx: block.txs.map((tx) => rawResult(tx, block, chain)) }),
    };
  },

  getblockheader(chain, [hash, verbose]) {
    const block = blockOf(chain, hash);
    return verbose === false || verbose === 0 ? toHex(serializeBlockHeader(block.block.header)) : headerFields(block, chain);
  },

  getheaders(chain, [locators, stop]) {
    if (!Array.isArray(locators)) throw new SimulatedRefusal(INVALID_PARAMS, 'blocklocators must be an array');
    const known = locators.map((hash) => chain.block(String(hash))).find((block) => block !== null && chain.isActive(block));
    const from = known === undefined || known === null ? 1 : known.height + 1;
    const headers: string[] = [];
    for (const block of chain.blocks.slice(from, from + MAX_HEADERS)) {
      headers.push(toHex(concat([serializeCertificate(block.block.certificate), serializeBlockHeader(block.block.header)])));
      if (block.hash === stop) break;
    }
    return headers;
  },

  getchaintips: (chain) =>
    chain.chainTips().map((tip) => {
      let fork = tip;
      while (!chain.isActive(fork)) fork = chain.block(fork.parent)!;
      const status = tip === chain.tip ? 'active' : chain.isInvalid(tip) ? 'invalid' : 'valid-fork';
      return { height: tip.height, hash: tip.hash, branchlen: tip.height - fork.height, status };
    }),

  getblockchaininfo: (chain) => ({
    chain: chain.network.name,
    blocks: chain.height,
    headers: chain.height,
    bestblockhash: chain.tip.hash,
    difficulty: difficultyForBits(chain.tip.block.header.bits, chain.network),
    mediantime: chain.medianTimePast(),
    pruned: false,
  }),

  getinfo: (chain) => ({
    version: 0,
    protocolversion: 0,
    blocks: chain.height,
    timeoffset: 0,
    connections: 0,
    proxy: '',
    difficulty: difficultyForBits(chain.tip.block.header.bits, chain.network),
    testnet: chain.network.name === 'testnet' || chain.network.name === 'testnet2',
    relayfee: new PrlAmount(chain.relayFeeRate),
    errors: '',
  }),

  getrawtransaction(chain, [txid, verbose]) {
    const id = str(txid, 'txid');
    const found = chain.transaction(id);
    // pearld looks in the mempool first and only then asks for its index.
    if (found === null || found.block !== null) needTxIndex(chain);
    if (found === null) throw new SimulatedRefusal(INVALID_ADDRESS_OR_KEY, `No information available about transaction ${id}`);
    return int(verbose, 'verbose', 0) === 0 ? found.tx.toHex() : rawResult(found.tx, found.block, chain);
  },

  decoderawtransaction(chain, [hex]) {
    let tx: Transaction;
    try {
      tx = parseTransaction(str(hex, 'hextx'));
    } catch (err) {
      throw new SimulatedRefusal(DESERIALIZATION, `TX decode failed: ${(err as Error).message}`);
    }
    return { txid: tx.getId(), version: tx.version, locktime: tx.locktime, vin: vin(tx, chain), vout: vout(tx, chain) };
  },

  validateaddress(chain, [value]) {
    try {
      const text = str(value, 'address');
      const { version, program } = decodeAddress(text, chain.network);
      return { isvalid: true, address: text, iswitness: true, witness_version: version, witness_program: toHex(program) };
    } catch {
      return { isvalid: false };
    }
  },

  sendrawtransaction: (chain, [hex]) => chain.submit(str(hex, 'hextx')).txid,

  testmempoolaccept(chain, [txs, maxFeeRate]) {
    if (!Array.isArray(txs)) throw new SimulatedRefusal(INVALID_PARAMS, 'rawtxns must be an array');
    if (maxFeeRate === undefined) throw new SimulatedRefusal(INVALID_PARAMS, 'maxfeerate is required');
    // 0 stands for pearld's default of 0.1 PRL per 1000 vbytes.
    const limit = typeof maxFeeRate === 'number' && maxFeeRate > 0 ? BigInt(Math.round(maxFeeRate * 1e8)) : 10_000_000n;
    return txs.map((hex) => {
      let tx: Transaction;
      try {
        tx = parseTransaction(str(hex, 'rawtx'));
      } catch (err) {
        throw new SimulatedRefusal(DESERIALIZATION, `TX decode failed: ${(err as Error).message}`);
      }
      const ids = { txid: tx.getId(), wtxid: witnessHash(tx), 'package-error': '' };
      try {
        const { fee, vsize } = chain.submit(tx, true);
        const rate = (fee * 1000n) / BigInt(vsize);
        if (rate > limit) return { ...ids, 'reject-reason': 'max-fee-exceeded' };
        return { ...ids, allowed: true, vsize, fees: { base: new PrlAmount(fee), 'effective-feerate': new PrlAmount(rate), 'effective-includes': null } };
      } catch (err) {
        if (!(err instanceof SimulatedRefusal)) throw err;
        return { ...ids, 'reject-reason': err.message };
      }
    });
  },

  estimatefee(chain, [blocks]) {
    int(blocks, 'numblocks');
    if (chain.feeRate === null) throw new SimulatedRefusal(MISC, 'not enough blocks have been observed');
    return new PrlAmount(chain.feeRate);
  },

  getmempoolinfo: (chain) => ({
    size: chain.mempool.size,
    bytes: [...chain.mempool.values()].reduce((sum, entry) => sum + entry.tx.byteLength(), 0),
    cap: 300_000_000,
  }),

  getrawmempool(chain, [verbose]) {
    if (verbose !== true) return [...chain.mempool.keys()];
    return Object.fromEntries(
      [...chain.mempool].map(([txid, entry]) => [
        txid,
        {
          size: entry.tx.byteLength(),
          vsize: entry.vsize,
          fee: new PrlAmount(entry.fee),
          time: entry.time,
          height: entry.height,
          depends: [...new Set(entry.tx.ins.map(prevTxid))].filter((parent) => chain.mempool.has(parent)),
        },
      ]),
    );
  },

  gettxout(chain, [txid, index, includeMempool]) {
    const id = str(txid, 'txid');
    const n = int(index, 'vout');
    const coin = chain.coin(id, n);
    if (coin !== null) {
      return {
        bestblock: chain.tip.hash,
        confirmations: chain.height - coin.height + 1,
        value: new PrlAmount(coin.value),
        scriptPubKey: scriptPubKey(coin.script, chain),
        coinbase: coin.coinbase,
      };
    }
    const pooled = includeMempool === false ? undefined : chain.mempool.get(id)?.tx.outs[n];
    if (pooled === undefined) return null;
    return { bestblock: chain.tip.hash, confirmations: 0, value: new PrlAmount(pooled.value), scriptPubKey: scriptPubKey(pooled.script, chain), coinbase: false };
  },

  gettxspendingprevout(chain, [outputs]) {
    if (!Array.isArray(outputs)) throw new SimulatedRefusal(INVALID_PARAMS, 'outputs must be an array');
    return (outputs as { txid?: unknown; vout?: unknown }[]).map((output) => {
      const id = str(output?.txid, 'txid');
      const n = int(output?.vout, 'vout');
      const spender = chain.spender(id, n);
      return { txid: id, vout: n, ...(spender !== null && !spender.confirmed ? { spendingtxid: spender.txid } : {}) };
    });
  },

  searchrawtransactions(chain, [target, verbose, skip, count, vinExtra, reverse]) {
    const wanted = int(count, 'count', 100);
    if (wanted > MAX_SEARCH_COUNT) throw new SimulatedRefusal(INVALID_PARAMETER, `Count exceeds maximum allowed (${MAX_SEARCH_COUNT})`);
    if (!chain.addrindex) throw new SimulatedRefusal(MISC, 'Address index must be enabled (--addrindex)');
    const script = toOutputScript(address(chain, target), chain.network);
    // The index keys on Taproot keys alone (addrToKey in indexers/addrindex.go).
    if (classifyOutputScript(script) !== 'p2tr') throw new SimulatedRefusal(INTERNAL, 'address type is not supported by the address index');
    if (wanted === 0) return null;
    const all = chain.touching(script);
    const ordered = reverse === true ? [...all].reverse() : all;
    const page = ordered.slice(Math.max(0, int(skip, 'skip', 0)), Math.max(0, int(skip, 'skip', 0)) + (wanted < 0 ? 1 : wanted));
    if (page.length === 0) throw new SimulatedRefusal(INVALID_ADDRESS_OR_KEY, 'No information available about address');
    if (int(verbose, 'verbose', 1) === 0) return page.map(({ tx }) => tx.toHex());
    return page.map(({ tx, block }) => ({
      hex: tx.toHex(),
      txid: tx.getId(),
      hash: '',
      size: '',
      vsize: '',
      version: tx.version,
      locktime: tx.locktime,
      vin: vin(tx, chain, int(vinExtra, 'vinextra', 0) !== 0),
      vout: vout(tx, chain),
      ...(block === null ? {} : { blockhash: block.hash, confirmations: chain.height - block.height + 1, time: block.time, blocktime: block.time }),
    }));
  },

  getcfilter: (chain, [hash]) => toHex(encodeFilter(chain.filter(blockOf(chain, hash)).filter)),
  getcfilterheader: (chain, [hash]) => filterHeaderHex(chain.filter(blockOf(chain, hash)).header),

  generate(chain, [blocks]) {
    const count = int(blocks, 'numblocks');
    if (count <= 0) throw new SimulatedRefusal(INTERNAL, 'Please request a nonzero number of blocks to generate.');
    return chain.mine(count).map((ref) => ref.hash);
  },

  invalidateblock(chain, [hash]) {
    const block = blockOf(chain, hash);
    if (block.parent === ZERO_HASH) throw new SimulatedRefusal(MISC, 'the genesis block cannot be invalidated');
    chain.invalidate(block.hash);
    return null;
  },

  reconsiderblock(chain, [hash]) {
    chain.reconsider(blockOf(chain, hash).hash);
    return null;
  },
};

/** The JSON text pearld would send for a call: a result, or an error with its code. */
export function simulatedReply(chain: SimulatedChain, method: string, params: readonly unknown[], id: number | null): string {
  try {
    const handler = Object.hasOwn(handlers, method) ? handlers[method]! : undefined;
    if (handler === undefined) throw new SimulatedRefusal(METHOD_NOT_FOUND, 'Method not found');
    // Params arrive as a client wrote them: PrlAmount and bigint become the numbers the server would parse.
    const plain = JSON.parse(encodeJson(params)) as unknown[];
    return encodeJson({ jsonrpc: '1.0', result: handler(chain, plain) ?? null, error: null, id });
  } catch (err) {
    if (!(err instanceof SimulatedRefusal)) throw err;
    const message = method === 'sendrawtransaction' ? err.clientMessage : err.message;
    return encodeJson({ jsonrpc: '1.0', result: null, error: { code: err.rpcCode, message }, id });
  }
}

/** pearld's typed methods over a simulated chain. Every call is counted in `chain.calls` and can be failed with `chain.failNext`. */
export function simulatedRpc(chain: SimulatedChain): PearldRpc {
  let id = 0;
  return new PearldRpc({
    async call<T = unknown>(method: string, params: readonly unknown[] = [], options: CallOptions = {}): Promise<T> {
      if (options.signal?.aborted === true) throw new PearlRpcError('network', method, 'request to the simulated node was aborted', { cause: options.signal.reason });
      chain.enter(method);
      id += 1;
      return readReply<T>(simulatedReply(chain, method, params, id), method, id, options, 'the simulated node');
    },
  });
}
