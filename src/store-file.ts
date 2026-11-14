// A wallet store in one JSON file, for Node. It is a module of its own,
// outside the main entry point, so browser bundles never import node:fs.
//
//   {"format":"pearljs-wallet-store","version":1,"entries":{"<key>":<value>,...}}
//
// Every write rewrites the whole file the way xmss-file-store does: the new
// content goes to <path>.tmp, which is fsynced and renamed over the file,
// and then the directory is fsynced. A crash leaves either the old file or
// the new one, never a mix, and a .tmp left behind is an unfinished write
// that is discarded on open. The writes are synchronous so that a batch is
// one step between which no other call of this process can run.
//
// <path>.lock, created exclusively and held until close, keeps a second
// store and a second process off the file. It names the process and host
// that hold it. A lock whose process is gone is only broken when the caller
// asks, and only on the host that made it: a wallet holding XMSS keys must
// never have two writers.

/// <reference types="node" />

/**
 * A wallet store kept in one file, written atomically and locked against a
 * second writer. Node only; not re-exported by the main entry.
 *
 * @module
 */

import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { StoreError } from './errors.js';
import { applyOperations, checkOperations, copyJson, listEntries } from './internal/store-ops.js';
import type { JsonValue, StoreOperation, WalletStore } from './store.js';

const FORMAT = 'pearljs-wallet-store';
const VERSION = 1;

/** Options for createFileStore. */
export interface FileStoreOptions {
  /** Start a new file. It must not exist. Without this the file must exist, so a mistyped path fails instead of starting an empty wallet. */
  create?: boolean;
  /**
   * Take over a lock left by a process that is no longer running on this
   * host. Off unless given; a lock from another host is never broken.
   */
  breakStaleLock?: boolean;
}

/** A file store; close releases its lock. */
export interface FileStore extends WalletStore {
  readonly path: string;
}

interface LockOwner {
  pid: number;
  host: string;
}

function writeDurably(path: string, text: string, flags: string): void {
  const fd = openSync(path, flags, 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function syncDirectory(path: string): void {
  let fd: number;
  try {
    fd = openSync(dirname(path), 'r');
  } catch {
    return; // Windows cannot open a directory; the rename is still atomic there.
  }
  try {
    fsyncSync(fd);
  } catch {
    // Not every file system can fsync a directory.
  } finally {
    closeSync(fd);
  }
}

function errnoOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function readOwner(lockPath: string): LockOwner | null {
  try {
    const owner = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<LockOwner>;
    return typeof owner.pid === 'number' && typeof owner.host === 'string' ? { pid: owner.pid, host: owner.host } : null;
  } catch {
    return null;
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists and belongs to someone else.
    return errnoOf(error) !== 'ESRCH';
  }
}

function takeLock(path: string, breakStale: boolean): void {
  const lockPath = `${path}.lock`;
  const mine = `${JSON.stringify({ pid: process.pid, host: hostname() })}\n`;
  try {
    writeDurably(lockPath, mine, 'wx');
    return;
  } catch (error) {
    if (errnoOf(error) !== 'EEXIST') throw error;
  }
  const owner = readOwner(lockPath);
  const stale = owner !== null && owner.host === hostname() && owner.pid !== process.pid && !isRunning(owner.pid);
  if (stale && breakStale) {
    unlinkSync(lockPath);
    writeDurably(lockPath, mine, 'wx');
    return;
  }
  const who = owner === null ? 'another store' : `process ${owner.pid} on ${owner.host}`;
  throw new StoreError(
    'STORE_LOCKED',
    `wallet store ${path} is locked by ${who}. Two writers must never share a wallet` +
      (stale ? `; that process is no longer running, so open with breakStaleLock: true to take the lock over` : `; if that process is gone, delete ${lockPath}`),
  );
}

function readEntries(path: string): Map<string, JsonValue> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') throw error;
    throw new StoreError('STORE_INVALID', `wallet store ${path} is not valid JSON; refusing to guess its contents`);
  }
  const file = parsed as { format?: unknown; version?: unknown; entries?: unknown } | null;
  if (file === null || typeof file !== 'object' || file.format !== FORMAT) throw new StoreError('STORE_INVALID', `${path} is not a pearljs wallet store`);
  if (file.version !== VERSION) throw new StoreError('STORE_INVALID', `wallet store ${path} has format version ${String(file.version)}; this pearljs reads version ${VERSION}`);
  if (file.entries === null || typeof file.entries !== 'object' || Array.isArray(file.entries)) throw new StoreError('STORE_INVALID', `wallet store ${path} has no entries`);
  return new Map(Object.entries(file.entries as Record<string, JsonValue>));
}

/**
 * Opens the wallet store at path and locks it. Throws StoreError:
 * STORE_LOCKED, STORE_NOT_FOUND without create, STORE_EXISTS with it, and
 * STORE_INVALID for a file that cannot be read as a store.
 */
export function createFileStore(path: string, options: FileStoreOptions = {}): FileStore {
  if (typeof path !== 'string' || path.length === 0) throw new TypeError('wallet store path must be a non-empty string');
  const lockPath = `${path}.lock`;
  const temporary = `${path}.tmp`;
  takeLock(path, options.breakStaleLock === true);

  let open = true;
  const release = (): void => {
    if (!open) return;
    open = false;
    process.removeListener('exit', release);
    try {
      unlinkSync(lockPath);
    } catch {
      // Already gone.
    }
  };

  const write = (entries: Map<string, JsonValue>, flags: string): void => {
    const text = `${JSON.stringify({ format: FORMAT, version: VERSION, entries: Object.fromEntries([...entries].sort(([a], [b]) => (a < b ? -1 : 1))) })}\n`;
    if (flags === 'wx') {
      writeDurably(path, text, 'wx');
    } else {
      writeDurably(temporary, text, 'w');
      renameSync(temporary, path);
    }
    syncDirectory(path);
  };

  let entries: Map<string, JsonValue>;
  try {
    // A .tmp is a write that never reached its rename: the file beside it is the last complete state.
    try {
      unlinkSync(temporary);
    } catch {
      // None left behind.
    }
    if (options.create === true) {
      entries = new Map();
      write(entries, 'wx');
    } else {
      entries = readEntries(path);
    }
  } catch (error) {
    release();
    if (errnoOf(error) === 'EEXIST') throw new StoreError('STORE_EXISTS', `wallet store ${path} already exists; open it without create`);
    if (errnoOf(error) === 'ENOENT') throw new StoreError('STORE_NOT_FOUND', `wallet store ${path} does not exist; pass create: true to start a new one`);
    throw error;
  }
  process.once('exit', release);

  const ensureOpen = (): void => {
    if (!open) throw new StoreError('STORE_CLOSED', 'this wallet store is closed');
  };
  const commit = (operations: readonly StoreOperation[]): void => {
    ensureOpen();
    const checked = checkOperations(operations);
    if (checked.length === 0) return;
    const next = new Map(entries);
    applyOperations(next, checked);
    write(next, 'w');
    entries = next;
  };

  return {
    path,
    async get(key) {
      ensureOpen();
      const value = entries.get(key);
      return value === undefined ? undefined : copyJson(value);
    },
    async set(key, value) {
      commit([{ type: 'set', key, value }]);
    },
    async delete(key) {
      commit([{ type: 'delete', key }]);
    },
    async list(prefix) {
      ensureOpen();
      return listEntries(entries, prefix);
    },
    async batch(operations) {
      commit(operations);
    },
    async close() {
      release();
    },
  };
}
