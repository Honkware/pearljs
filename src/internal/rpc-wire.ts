// The JSON-RPC wire helpers the fetch and websocket clients share. Not a
// subpath export: nothing here is part of the public API, except PrlAmount,
// which rpc.ts re-exports.

import { formatPearl, parsePearl } from '../amount.js';
import { PearlError, PearlRpcError } from '../errors.js';
import type { CallOptions } from '../rpc.js';
import { toHex } from './bytes.js';

// Calls that are slow by design get no default timeout: generate proves every
// block, importprivkey and the websocket rescans walk the chain, and
// getblocktemplate can long-poll.
export const UNBOUNDED_METHODS: ReadonlySet<string> = new Set(['generate', 'importprivkey', 'getblocktemplate', 'rescan', 'rescanblocks']);

/** A PRL amount among the params of a call; see prlAmount. */
export class PrlAmount {
  constructor(readonly grain: bigint) {
    if (typeof grain !== 'bigint') throw new TypeError('a PRL amount is a bigint number of grains');
  }
}

/** JSON.stringify, with PrlAmount written as an exact PRL number and bigint as an exact integer. */
export function encodeJson(value: unknown): string {
  if (value instanceof PrlAmount) return formatPearl(value.grain);
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return `[${value.map((v) => encodeJson(v === undefined ? null : v)).join(',')}]`;
  if (value instanceof Uint8Array) return JSON.stringify(toHex(value));
  if (typeof value === 'object' && value !== null && !(value instanceof Date)) {
    const fields = Object.entries(value).filter(([, v]) => v !== undefined);
    return `{${fields.map(([k, v]) => `${JSON.stringify(k)}:${encodeJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The PearlRpcError for the "error" member of a reply. */
export function rpcError(method: string, error: { code?: unknown; message?: unknown }): PearlRpcError {
  // btcjson.RPCError tags both fields omitempty, so either can be missing.
  const code = typeof error.code === 'number' ? error.code : 0;
  const message = typeof error.message === 'string' && error.message !== '' ? error.message : 'unknown error';
  return new PearlRpcError('rpc', method, `${message} (code ${code})`, { rpcCode: code });
}

/**
 * The result in one reply's text, or the PearlRpcError the reply amounts to.
 * `id` is the request's; null skips the check, for transports that have
 * matched the reply already.
 */
export function readReply<T = unknown>(text: string, method: string, id: number | null, options: CallOptions = {}, origin = 'the server'): T {
  let reply: unknown;
  try {
    reply = parseJson(text, new Set(options.amounts), new Set(options.integers));
  } catch (err) {
    const reason = text.trim() === '' ? 'an empty body' : (err as Error).message;
    throw new PearlRpcError('response', method, `unreadable reply from ${origin}: ${reason}`, { cause: err });
  }
  if (isErrorReply(reply)) throw rpcError(method, reply.error);
  if (typeof reply !== 'object' || reply === null || !('result' in reply)) {
    throw new PearlRpcError('response', method, `expected a JSON-RPC reply, got ${JSON.stringify(text.slice(0, 120))}`);
  }
  const replyId = (reply as { id?: unknown }).id;
  if (id !== null && replyId !== id) {
    throw new PearlRpcError('response', method, `reply id ${JSON.stringify(replyId)} does not match request id ${id}`);
  }
  return (reply as { result: T }).result;
}

/** A server URL with its credentials split off. */
export interface RpcEndpoint {
  /** The URL without credentials. */
  readonly url: URL;
  readonly username: string;
  readonly password: string;
}

/**
 * Splits a server URL from its credentials and refuses to send them in the
 * clear to anything but loopback. Shared by the HTTP and websocket clients.
 */
export function rpcEndpoint(options: {
  readonly url: string | URL;
  readonly username?: string;
  readonly password?: string;
  readonly allowInsecureAuth?: boolean;
}): RpcEndpoint {
  let url: URL;
  try {
    url = new URL(options.url);
  } catch {
    // The URL constructor's error carries its input, which may hold the password.
    throw new TypeError('invalid RPC URL (not shown, since it may hold credentials)');
  }
  const username = options.username ?? decodeURIComponent(url.username);
  const password = options.password ?? decodeURIComponent(url.password);
  // fetch and WebSocket refuse URLs with credentials, so they travel apart.
  url.username = '';
  url.password = '';
  const plain = url.protocol === 'http:' || url.protocol === 'ws:';
  if (plain && (username || password) && options.allowInsecureAuth !== true && !isLoopback(url.hostname)) {
    throw new TypeError(
      `refusing to send the RPC password to ${url.host} over ${url.protocol}//, which is not encrypted; use TLS or set allowInsecureAuth`,
    );
  }
  return { url, username, password };
}

/** The value of an HTTP Basic Authorization header. */
export function basicAuth(username: string, password: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(`${username}:${password}`)) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

/** Whether a URL's hostname is this machine: localhost, a .localhost name, ::1 or 127.0.0.0/8. */
export function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
}

/** A block height from a reply, refused unless it is one: the invoice monitor and wallets do arithmetic on it. */
export function safeHeight(value: unknown, method: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new PearlRpcError('response', method, `expected a block height, got ${JSON.stringify(value)}`);
  }
  return value as number;
}

export function isErrorReply(reply: unknown): reply is { error: { code?: unknown; message?: unknown } } {
  const error = typeof reply === 'object' && reply !== null ? (reply as { error?: unknown }).error : undefined;
  return typeof error === 'object' && error !== null;
}

const NUMBER_RE = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const NO_KEYS: ReadonlySet<string> = new Set();

/**
 * JSON.parse, except that numbers under amountKeys become bigint grain and
 * numbers under integerKeys become bigint as written. Those numbers are
 * quoted in the text first, so their digits never pass through a float. The
 * amount key "*" takes every number inside the top-level "result".
 */
export function parseJson(text: string, amountKeys: ReadonlySet<string> = NO_KEYS, integerKeys: ReadonlySet<string> = NO_KEYS): unknown {
  if (amountKeys.size === 0 && integerKeys.size === 0) return JSON.parse(text);
  const everyAmount = amountKeys.has('*');
  const converted: bigint[] = [];
  const spans: [number, number][] = [];
  // Server strings that start with NUL, the only ones a tag could match.
  const nul: string[] = [];
  let lastString = '';
  let underKey: string | null = null;
  let depth = 0;
  let inResult = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      lastString = text.slice(i + 1, j);
      if (lastString.includes('\\u0000')) {
        try {
          nul.push(JSON.parse(`"${lastString}"`) as string);
        } catch {
          // The final parse reports the bad string.
        }
      }
      underKey = null;
      i = j;
    } else if (c === ':') {
      underKey = lastString;
      if (depth === 1) inResult = lastString === 'result';
    } else if (c === '-' || (c >= '0' && c <= '9')) {
      NUMBER_RE.lastIndex = i;
      const match = NUMBER_RE.exec(text);
      if (match === null) break;
      const kind =
        underKey !== null && integerKeys.has(underKey)
          ? 'i'
          : (everyAmount && inResult) || (underKey !== null && amountKeys.has(underKey))
            ? 'a'
            : null;
      if (kind !== null) {
        spans.push([i, i + match[0].length]);
        converted.push(kind === 'a' ? decimalToGrain(match[0]) : BigInt(match[0]));
      }
      underKey = null;
      i += match[0].length - 1;
    } else if (c !== ' ' && c !== '\n' && c !== '\r' && c !== '\t') {
      if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') depth--;
      underKey = null;
    }
  }
  if (converted.length === 0) return JSON.parse(text);
  // Each converted number becomes a string naming its slot under a random
  // tag that no string from the server starts with, so none can pass for one.
  let nonce: string;
  do nonce = randomTag();
  while (nul.some((value) => value.startsWith(`\u0000${nonce}:`)));
  const marker = `\u0000${nonce}:`;
  let out = '';
  let copied = 0;
  spans.forEach(([start, end], slot) => {
    out += `${text.slice(copied, start)}"\\u0000${nonce}:${slot}"`;
    copied = end;
  });
  out += text.slice(copied);
  return JSON.parse(out, (_key, value: unknown) => {
    if (typeof value !== 'string' || !value.startsWith(marker)) return value;
    const slot = value.slice(marker.length);
    return /^\d+$/.test(slot) && Number(slot) < converted.length ? converted[Number(slot)] : value;
  });
}

function randomTag(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return toHex(bytes);
}

const DECIMAL_RE = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

/**
 * A PRL JSON number as grains. Go writes float amounts in shortest form, so
 * "1e-8" and "12.345678" both occur; digits past the eighth decimal round half
 * away from zero, as btcutil.NewAmount does.
 */
export function decimalToGrain(text: string): bigint {
  const m = DECIMAL_RE.exec(text);
  if (m === null) throw new PearlError('AMOUNT_INVALID', `invalid PRL amount: ${JSON.stringify(text)}`);
  const [, sign, whole, frac = '', exp = '0'] = m;
  const shift = Number(exp);
  if (Math.abs(shift) > 40) throw new PearlError('AMOUNT_OUT_OF_RANGE', `PRL amount out of range: ${text}`);
  const digits = whole! + frac;
  const point = whole!.length + shift;
  const padded = point < 0 ? '0'.repeat(-point) + digits : digits.padEnd(point, '0');
  const at = Math.max(point, 0);
  // An exponent can leave zeros in front (0.5e1), which parsePearl refuses.
  const intPart = padded.slice(0, at).replace(/^0+(?=\d)/, '') || '0';
  const fracPart = padded.slice(at);
  const roundUp = fracPart.length > 8 && fracPart[8]! >= '5' ? 1n : 0n;
  const grain = parsePearl(fracPart === '' ? intPart : `${intPart}.${fracPart.slice(0, 8)}`) + roundUp;
  return sign === '-' ? -grain : grain;
}

// The body as text, refused once it passes `limit` bytes.
export async function readBounded(response: Response, limit: number, method: string, origin: string): Promise<string> {
  const tooLarge = () => new PearlRpcError('response', method, `the reply from ${origin} is larger than maxReplySize, ${limit} bytes`);
  const declared = Number(response.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > limit) {
    void response.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  const body = response.body;
  if (body === null || typeof body.getReader !== 'function') {
    const text = await response.text();
    // UTF-8 takes at most three bytes per UTF-16 unit, so short text needs no count.
    if (text.length * 3 > limit && new TextEncoder().encode(text).length > limit) throw tooLarge();
    return text;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      void reader.cancel().catch(() => {});
      throw tooLarge();
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}
