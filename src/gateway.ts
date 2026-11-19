// The protocol between a miner and pearl-gateway, Pearl's bridge from a
// miner to pearld (miner/pearl-gateway). One JSON-RPC 2.0 object per line,
// over a Unix socket or loopback TCP. A miner asks getMiningInfo for a job
// (the 76-byte header without its proof commitment, the target, the
// certificate version and, from the FP8 fork, the recent ancestor headers)
// and sends submitPlainProof with its solution and the job it solved. The
// gateway answers "submitted" at once and turns the solution into a ZK
// certificate and a block on its own; the miner never hears whether pearld
// took it. This module encodes and decodes those lines. It is not a gateway.

/**
 * Messages of pearl-gateway's miner protocol: getMiningInfo and
 * submitPlainProof, their replies and errors, as typed values and the lines
 * the gateway and its miners write.
 *
 * @module
 */

import { serializeBlockHeader } from './blockheader.js';
import { PearlError } from './errors.js';
import { toHex } from './internal/bytes.js';
import type { BlockSkeleton } from './mining.js';
import { incompleteHeader, INCOMPLETE_HEADER_SIZE } from './mining.js';

/** The error codes pearl-gateway answers with. */
export const GATEWAY_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  /** Anything else the handler threw, with its text. */
  INTERNAL: -32000,
  /** No block template yet; the message is "mining_paused: ...". */
  MINING_PAUSED: -32001,
} as const;

/**
 * A JSON-RPC id. The gateway's miners count up from 1. An integer id beyond
 * 2^53 - 1 is a bigint, so it is echoed exactly, as the gateway's Python
 * echoes it.
 */
export type GatewayId = string | number | bigint | null;

/** A job as getMiningInfo hands it out (pearl-gateway's MiningJob). */
export interface MiningJob {
  /** The block header without its proof commitment, 76 bytes. */
  readonly incompleteHeader: Uint8Array;
  /** The target from the header's bits, before the miner scales it for its configuration. */
  readonly target: bigint;
  /** The certificate version the block needs. */
  readonly certVersion: number;
  /**
   * The full 108-byte headers of the most recent ancestors, parent first,
   * that a V4 proof may be keyed by. A gateway from Pearl's fp8-scheme branch
   * always sends the list, empty before V4; an older one never does, which
   * is what undefined means.
   */
  readonly ancestorHeaders?: readonly Uint8Array[];
}

/** A line a miner sends. */
export type GatewayRequest =
  | { readonly id: GatewayId; readonly method: 'getMiningInfo' }
  | {
      readonly id: GatewayId;
      readonly method: 'submitPlainProof';
      /** The miner's solution, pearl_mining's PlainProof (V1 to V3) or PlainProofV4 serialized; opaque here. */
      readonly plainProof: Uint8Array;
      /** The job it solves, as getMiningInfo gave it. */
      readonly job: MiningJob;
    };

/** The error member of a reply. */
export interface GatewayError {
  readonly code: number;
  readonly message: string;
  /** The validator's or parser's text, for invalid requests. */
  readonly data?: string;
}

/** A line the gateway sends back. */
export type GatewayResponse =
  | { readonly id: GatewayId; readonly result: MiningJob }
  | { readonly id: GatewayId; readonly result: 'submitted' }
  | { readonly id: GatewayId; readonly error: GatewayError };

function invalid(message: string): never {
  throw new PearlError('GATEWAY_MESSAGE_INVALID', message);
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text: unknown, field: string): Uint8Array {
  if (typeof text !== 'string' || !BASE64.test(text) || text.length % 4 !== 0) invalid(`${field} is not base64`);
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

// Python's json.dumps with its default separators and ensure_ascii, the
// encoding of every line the gateway and its miners write.
function dumps(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    // Python writes a float its own way; only integers round-trip, and only safe ones as numbers.
    if (!Number.isSafeInteger(value)) invalid(`${value} is not a safe integer; give a larger integer as a bigint`);
    return String(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  }
  if (Array.isArray(value)) return `[${value.map(dumps).join(', ')}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
  return `{${entries.map(([k, v]) => `${dumps(k)}: ${dumps(v)}`).join(', ')}}`;
}

function jobFields(job: MiningJob): Record<string, unknown> {
  if (job.incompleteHeader.length !== INCOMPLETE_HEADER_SIZE) throw new RangeError(`incompleteHeader must be ${INCOMPLETE_HEADER_SIZE} bytes`);
  if (job.target < 0n) throw new RangeError('target must not be negative');
  if (!Number.isInteger(job.certVersion) || job.certVersion < 1) throw new RangeError('certVersion must be 1 or more');
  return {
    incomplete_header_bytes: toBase64(job.incompleteHeader),
    target: job.target,
    cert_version: job.certVersion,
    ancestor_headers: job.ancestorHeaders?.map((header) => {
      if (header.length !== 108) throw new RangeError('an ancestor header is 108 bytes');
      return toBase64(header);
    }),
  };
}

function readJob(value: unknown): MiningJob {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid('the job is not an object');
  const job = value as Record<string, unknown>;
  const incomplete = fromBase64(job.incomplete_header_bytes, 'incomplete_header_bytes');
  if (incomplete.length !== INCOMPLETE_HEADER_SIZE) invalid(`incomplete_header_bytes is ${incomplete.length} bytes, not ${INCOMPLETE_HEADER_SIZE}`);
  const target = job.target instanceof RawNumber ? job.target.integer(true) : undefined;
  if (target === undefined || target < 0n) invalid('target is not a non-negative integer');
  const certVersion = job.cert_version;
  if (typeof certVersion !== 'number' || !Number.isInteger(certVersion) || certVersion < 1) invalid('cert_version is not a positive integer');
  const ancestors = job.ancestor_headers;
  if (ancestors !== undefined && !Array.isArray(ancestors)) invalid('ancestor_headers is not a list');
  const ancestorHeaders = ancestors?.map((text: unknown, i: number) => {
    const header = fromBase64(text, `ancestor_headers[${i}]`);
    if (header.length !== 108) invalid(`ancestor_headers[${i}] is ${header.length} bytes, not 108`);
    return header;
  });
  return ancestorHeaders === undefined
    ? { incompleteHeader: incomplete, target, certVersion }
    : { incompleteHeader: incomplete, target, certVersion, ancestorHeaders };
}

function checkId(id: unknown): GatewayId {
  if (id === null || typeof id === 'string') return id;
  if (id instanceof RawNumber) {
    const value = id.integer(false);
    if (value === undefined) invalid(`id ${id.text} is not an integer; ids are kept exactly, so only integer ids are read`);
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
  }
  return invalid('id is not a string, number or null');
}

// A number under "id" or "target", as written.
class RawNumber {
  constructor(readonly text: string) {}

  // The integer it is, or undefined. With floats, a number written as a float
  // counts when its double is an integer, as fastjsonschema's "integer" lets
  // Python's float through, and is the integer that double holds.
  integer(floats: boolean): bigint | undefined {
    if (/^-?\d+$/.test(this.text)) return BigInt(this.text);
    const value = Number(this.text);
    return floats && Number.isInteger(value) ? BigInt(value) : undefined;
  }
}

const NUMBER = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

// JSON.parse, with each number under an "id" or "target" key, the key's
// escapes decoded as Python decodes them, kept as written in a RawNumber.
function parseRaw(text: string): unknown {
  const raw: string[] = [];
  const marker = `\u0000${toHex(globalThis.crypto.getRandomValues(new Uint8Array(12)))}:`;
  let out = '';
  let copied = 0;
  let lastString = '';
  let key: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      lastString = text.slice(i + 1, j);
      key = null;
      i = j;
    } else if (c === ':') {
      try {
        key = JSON.parse(`"${lastString}"`) as string;
      } catch {
        key = null;
      }
    } else if (c === '-' || (c >= '0' && c <= '9')) {
      NUMBER.lastIndex = i;
      const match = NUMBER.exec(text);
      if (match === null) break;
      if (key === 'id' || key === 'target') {
        out += `${text.slice(copied, i)}"\\u0000${marker.slice(1)}${raw.length}"`;
        raw.push(match[0]);
        copied = i + match[0].length;
      }
      key = null;
      i += match[0].length - 1;
    } else if (c !== ' ' && c !== '\n' && c !== '\r' && c !== '\t') {
      key = null;
    }
  }
  return JSON.parse(out + text.slice(copied), (_key, value: unknown) => {
    if (typeof value !== 'string' || !value.startsWith(marker)) return value;
    const slot = Number(value.slice(marker.length));
    // A string the sender wrote that only looks like a slot stays a string.
    return Number.isInteger(slot) && slot < raw.length && value === `${marker}${slot}` ? new RawNumber(raw[slot]!) : value;
  });
}

function parseLine(line: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = parseRaw(line.trim());
  } catch {
    invalid('the line is not JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid('the line is not a JSON object');
  const message = value as Record<string, unknown>;
  if (message.jsonrpc !== '2.0') invalid('jsonrpc is not "2.0"');
  return message;
}

/** The line a miner writes for a request, as pearl-gateway's JSONRPCClient writes it, newline included. */
export function encodeGatewayRequest(request: GatewayRequest): string {
  const params = request.method === 'getMiningInfo'
    ? {}
    : { plain_proof: toBase64(request.plainProof), mining_job: jobFields(request.job) };
  return `${dumps({ jsonrpc: '2.0', method: request.method, id: request.id, params })}\n`;
}

/**
 * Reads a miner's line. Refuses (GATEWAY_MESSAGE_INVALID) what the gateway
 * refuses with Invalid Request or Invalid params, and methods it does not
 * have; the gateway's own error text is not reproduced. A target written as
 * a float whose value is an integer (1e3, 123.0) is read as that integer, as
 * the gateway's schema reads it. An id written as a float is refused, though
 * the gateway takes one, since it could not be echoed as written.
 */
export function decodeGatewayRequest(line: string): GatewayRequest {
  const message = parseLine(line);
  for (const key of Object.keys(message)) {
    if (!['jsonrpc', 'method', 'params', 'id'].includes(key)) invalid(`unexpected member ${key}`);
  }
  if (!('id' in message)) invalid('the request has no id');
  const id = checkId(message.id);
  // The gateway's schema wants an object when params is present; null is not one.
  const params = 'params' in message ? message.params : {};
  if (typeof params !== 'object' || params === null || Array.isArray(params)) invalid('params is not an object');
  const fields = params as Record<string, unknown>;
  if (message.method === 'getMiningInfo') {
    if (Object.keys(fields).length > 0) invalid('getMiningInfo takes no params');
    return { id, method: 'getMiningInfo' };
  }
  if (message.method === 'submitPlainProof') {
    for (const key of Object.keys(fields)) {
      if (key !== 'plain_proof' && key !== 'mining_job') invalid(`unexpected param ${key}`);
    }
    return { id, method: 'submitPlainProof', plainProof: fromBase64(fields.plain_proof, 'plain_proof'), job: readJob(fields.mining_job) };
  }
  return invalid(`unknown method ${String(message.method)}`);
}

/** The line the gateway writes for a reply, as its server writes it, newline included. */
export function encodeGatewayResponse(response: GatewayResponse): string {
  if ('error' in response) {
    const { code, message, data } = response.error;
    return `${dumps({ jsonrpc: '2.0', error: { code, message, data }, id: response.id })}\n`;
  }
  const result = response.result === 'submitted' ? 'submitted' : jobFields(response.result);
  return `${dumps({ jsonrpc: '2.0', result, id: response.id })}\n`;
}

/**
 * Reads the gateway's reply to a request of `method`: a job for
 * getMiningInfo, "submitted" for submitPlainProof, or the error.
 */
export function decodeGatewayResponse(line: string, method: GatewayRequest['method']): GatewayResponse {
  const message = parseLine(line);
  const id = checkId(message.id);
  if ('error' in message) {
    const error = message.error as Record<string, unknown> | null;
    if (typeof error !== 'object' || error === null) invalid('error is not an object');
    if (typeof error.code !== 'number' || typeof error.message !== 'string') invalid('error has no code and message');
    if (error.data !== undefined && typeof error.data !== 'string') invalid('error data is not a string');
    const data = error.data as string | undefined;
    return { id, error: data === undefined ? { code: error.code, message: error.message } : { code: error.code, message: error.message, data } };
  }
  if (!('result' in message)) invalid('the reply has neither result nor error');
  if (method === 'getMiningInfo') return { id, result: readJob(message.result) };
  if (message.result !== 'submitted') invalid('submitPlainProof was answered with something other than "submitted"');
  return { id, result: 'submitted' };
}

/**
 * The target pearl-gateway puts in a job (its bits_to_target): the
 * mantissa, sign bit included, shifted by the exponent, without the 256-bit
 * wrap. It equals bitsToTarget for any bits pearld issues.
 */
export function gatewayTarget(bits: number): bigint {
  if (!Number.isInteger(bits) || bits < 0 || bits > 0xffffffff) throw new RangeError('bits must be an unsigned 32-bit integer');
  const exponent = bits >>> 24;
  if (exponent < 3) throw new RangeError('pearl-gateway cannot read bits with an exponent below 3');
  return BigInt(bits & 0xffffff) << BigInt(8 * (exponent - 3));
}

/**
 * The job pearl-gateway (fp8-scheme) would hand out for a block skeleton:
 * its incomplete header, the target of its bits, its certificate version and
 * its ancestor headers.
 */
export function miningJob(skeleton: BlockSkeleton): MiningJob {
  return {
    incompleteHeader: incompleteHeader(skeleton.header),
    target: gatewayTarget(skeleton.header.bits),
    certVersion: skeleton.certVersion,
    ancestorHeaders: skeleton.ancestorHeaders.map((header) => serializeBlockHeader(header)),
  };
}

/**
 * The headers a V4 certificate for `job` must carry when its proof is keyed
 * by `ancestor`, parent first, the ancestor itself left out
 * (MiningJob.ancestor_chain_to); null when the ancestor is not among the
 * job's first four headers, so the proof can no longer be used.
 */
export function ancestorChain(job: MiningJob, ancestor: Uint8Array): Uint8Array[] | null {
  const window = (job.ancestorHeaders ?? []).slice(0, 4);
  const at = window.findIndex((header) => header.length === ancestor.length && header.every((b, i) => b === ancestor[i]));
  return at < 0 ? null : window.slice(0, at).map((header) => header.slice());
}
