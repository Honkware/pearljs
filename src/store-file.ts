// A wallet store in a directory, for Node. It is a module of its own,
// outside the main entry point, so browser bundles never import node:fs.
//
//   <path>/
//     0000000000000042.json   the state, whole, at revision 42
//     0000000000000041.json   the one before, kept one commit longer
//     lock                    who has the store open
//
//   {"format":"pearljs-wallet-store","version":2,"revision":42,"id":"<32 hex>","entries":{"<key>":<value>,...}}
//
// Every write makes a new revision: the whole state goes to a temporary
// file, which is written to the last byte, fsynced, and then hard-linked to
// the name of the next revision. The link is the commit. It exists whole or
// not at all, and it fails if the name is taken, so of any number of writers
// holding revision 42 exactly one makes revision 43, whatever has happened
// to the lock. A crash leaves the last revision that was linked.
//
// Old revisions are deleted lowest first, down to the newest two. A writer
// far behind could therefore link a name that was deleted long ago, so after
// linking it reads the revision it built on and checks the random id in it:
// that file is deleted before any later one, and its id never comes back, so
// a writer that still finds it has built on the newest state. One that does
// not removes its link and fails.
//
// The lock (internal/node-files.ts) keeps a second store from opening at
// all. The store checks it still holds the lock before every write, and a
// store that finds another writer, by its lock or by a revision it did not
// make, refuses everything from then on: its memory is no longer the state.

/// <reference types="node" />

/**
 * A wallet store kept in a directory of whole-state revisions, committed by
 * an exclusive link and locked against a second writer. Node only; not
 * re-exported by the main entry.
 *
 * @module
 */

import { closeSync, linkSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { StoreError } from './errors.js';
import { LockHeldError, acquireLock, errnoOf, randomId, removeQuietly, syncDirectory, writeDurably } from './internal/node-files.js';
import type { FileLockOptions, HeldLock } from './internal/node-files.js';

export type { FileLockOptions } from './internal/node-files.js';
import { applyOperations, checkExpectations, checkOperations, copyJson, expectationsHold, listEntries } from './internal/store-ops.js';
import type { JsonValue, StoreExpectation, StoreOperation, WalletStore } from './store.js';

const FORMAT = 'pearljs-wallet-store';
const VERSION = 2;
const REVISION_FILE = /^([0-9]{16})\.json$/;
const TEMPORARY_FILE = /^[0-9a-f]{32}\.tmp$/;
const HEADER = /^\{"format":"pearljs-wallet-store","version":2,"revision":([0-9]+),"id":"([0-9a-f]{32})",/;
const HEADER_BYTES = 160;

/** Options for createFileStore. */
export interface FileStoreOptions extends FileLockOptions {
  /** Start a new store. The directory must not exist, or hold no store yet. Without this the store must exist, so a mistyped path fails instead of starting an empty wallet. */
  create?: boolean;
}

/** A file store; close releases its lock. */
export interface FileStore extends WalletStore {
  /** The directory the store is in. */
  readonly path: string;
  /** The revision this store last read or wrote; each write adds one. */
  readonly revision: number;
}

const revisionName = (revision: number): string => `${String(revision).padStart(16, '0')}.json`;

function revisionsIn(path: string): number[] {
  return readdirSync(path)
    .map((name) => REVISION_FILE.exec(name))
    .filter((match) => match !== null)
    .map((match) => Number(match[1]))
    .sort((a, b) => a - b);
}

// Milliseconds since a file was written, or 0 for one that is gone.
function ageOf(file: string): number {
  try {
    return Date.now() - statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

// The id a revision file carries, from its first bytes, or null when it is not there to be read.
function idOf(file: string): string | null {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const head = Buffer.alloc(HEADER_BYTES);
    const count = readSync(fd, head, 0, HEADER_BYTES, 0);
    return HEADER.exec(head.toString('utf8', 0, count))?.[2] ?? null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

function readRevision(file: string, revision: number): { id: string; entries: Map<string, JsonValue> } {
  let parsed: unknown;
  const text = readFileSync(file, 'utf8');
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new StoreError('STORE_INVALID', `wallet store revision ${file} is not valid JSON; refusing to guess its contents`);
  }
  const state = parsed as { format?: unknown; version?: unknown; revision?: unknown; id?: unknown; entries?: unknown } | null;
  if (state === null || typeof state !== 'object' || state.format !== FORMAT) throw new StoreError('STORE_INVALID', `${file} is not a pearljs wallet store revision`);
  if (state.version !== VERSION) throw new StoreError('STORE_INVALID', `wallet store revision ${file} has format version ${String(state.version)}; this pearljs reads version ${VERSION}`);
  if (state.revision !== revision || typeof state.id !== 'string' || !/^[0-9a-f]{32}$/.test(state.id)) throw new StoreError('STORE_INVALID', `wallet store revision ${file} does not say it is revision ${revision}`);
  if (state.entries === null || typeof state.entries !== 'object' || Array.isArray(state.entries)) throw new StoreError('STORE_INVALID', `wallet store revision ${file} has no entries`);
  return { id: state.id, entries: new Map(Object.entries(state.entries as Record<string, JsonValue>)) };
}

/**
 * Opens the wallet store in the directory at path and locks it. Throws
 * StoreError: STORE_LOCKED, STORE_NOT_FOUND without create, STORE_EXISTS with
 * it, and STORE_INVALID for a directory that cannot be read as a store. The
 * directory's file system must support hard links (STORE_UNAVAILABLE).
 *
 * Afterwards a write throws STORE_WRITE_FAILED when it could not reach the
 * disk whole, leaving the stored state as it was, and STORE_CONFLICT or
 * STORE_LOCKED when another writer has written the store or taken its lock,
 * after which the store refuses every call.
 */
export function createFileStore(path: string, options: FileStoreOptions = {}): FileStore {
  if (typeof path !== 'string' || path.length === 0) throw new TypeError('wallet store path must be a non-empty string');
  if (options.create === true) {
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if (errnoOf(error) !== 'EEXIST') throw error;
    }
  }
  let present: number[];
  try {
    present = revisionsIn(path);
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') throw new StoreError('STORE_NOT_FOUND', `wallet store ${path} does not exist; pass create: true to start a new one`);
    if (errnoOf(error) === 'ENOTDIR') throw new StoreError('STORE_INVALID', `${path} is a file, not a pearljs wallet store directory`);
    throw error;
  }
  if (options.create === true && present.length > 0) throw new StoreError('STORE_EXISTS', `wallet store ${path} already exists; open it without create`);
  if (options.create !== true && present.length === 0) throw new StoreError('STORE_NOT_FOUND', `${path} holds no wallet store; pass create: true to start a new one`);

  let lock: HeldLock;
  try {
    lock = acquireLock(join(path, 'lock'), options);
  } catch (error) {
    if (error instanceof LockHeldError) throw new StoreError('STORE_LOCKED', `wallet store ${path} ${error.describe()}. Two writers must never share a wallet`);
    throw error;
  }

  let open = true;
  let failure: StoreError | null = null;
  let entries = new Map<string, JsonValue>();
  let revision = -1;
  let id = '';

  const fail = (error: StoreError): StoreError => {
    failure = error;
    return error;
  };
  const ensureUsable = (): void => {
    if (!open) throw new StoreError('STORE_CLOSED', 'this wallet store is closed');
    if (failure !== null) throw failure;
  };

  // Deletes every revision under the newest two, lowest first and stopping at the first that will not go, so a revision is never left behind one above it that is gone.
  const prune = (): void => {
    try {
      for (const old of revisionsIn(path)) {
        if (old >= revision - 1) break;
        unlinkSync(join(path, revisionName(old)));
      }
    } catch {
      // Left for the next commit.
    }
  };

  const commit = (expected: readonly StoreExpectation[], operations: readonly StoreOperation[]): boolean => {
    ensureUsable();
    const conditions = checkExpectations(expected);
    const checked = checkOperations(operations);
    if (!lock.owned()) throw fail(new StoreError('STORE_LOCKED', `wallet store ${path} is no longer locked by this store: its lock was removed or taken over. Nothing was written; reopen the store`));
    if (!expectationsHold(entries, conditions)) return false;
    if (checked.length === 0 && revision >= 0) return true;
    const next = new Map(entries);
    applyOperations(next, checked);
    const nextId = randomId();
    const sorted = Object.fromEntries([...next].sort(([a], [b]) => (a < b ? -1 : 1)));
    const text = `${JSON.stringify({ format: FORMAT, version: VERSION, revision: revision + 1, id: nextId, entries: sorted })}\n`;
    const temporary = join(path, `${nextId}.tmp`);
    const target = join(path, revisionName(revision + 1));
    try {
      try {
        writeDurably(temporary, text, 'wx');
      } catch (error) {
        throw new StoreError('STORE_WRITE_FAILED', `wallet store ${path} could not write its next revision whole; the stored state is unchanged: ${(error as Error).message}`, { cause: error });
      }
      try {
        // The commit: whole, and only if no writer has made this revision.
        linkSync(temporary, target);
      } catch (error) {
        if (errnoOf(error) === 'EEXIST') {
          throw fail(new StoreError('STORE_CONFLICT', `wallet store ${path} already has revision ${revision + 1}, which this store did not write: another writer is using it. Nothing was written; reopen the store`));
        }
        if (['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EMLINK'].includes(errnoOf(error) ?? '')) {
          throw new StoreError('STORE_UNAVAILABLE', `the file system of ${path} cannot make hard links, which the file store commits with`, { cause: error });
        }
        throw new StoreError('STORE_WRITE_FAILED', `wallet store ${path} could not commit its next revision; the stored state is unchanged: ${(error as Error).message}`, { cause: error });
      }
    } finally {
      removeQuietly(temporary);
    }
    // The name was free. It is the next revision only if the one this store built on is still there: see the top of the file.
    if (revision >= 0 && idOf(join(path, revisionName(revision))) !== id) {
      removeQuietly(target);
      throw fail(new StoreError('STORE_CONFLICT', `wallet store ${path} has moved past revision ${revision}, which this store held: another writer is using it. Nothing was written; reopen the store`));
    }
    syncDirectory(path);
    entries = next;
    revision += 1;
    id = nextId;
    prune();
    return true;
  };

  try {
    for (const name of readdirSync(path)) {
      // A temporary file is a write that never reached its link, and this store holds the lock.
      if (TEMPORARY_FILE.test(name)) removeQuietly(join(path, name));
      else if (/^lock\.[0-9a-f]{32}\.tmp$/.test(name) && ageOf(join(path, name)) > 60_000) removeQuietly(join(path, name));
    }
    // Listed again under the lock: the last holder may have written since the look above.
    present = revisionsIn(path);
    if (options.create === true) {
      if (present.length > 0) throw new StoreError('STORE_EXISTS', `wallet store ${path} already exists; open it without create`);
      commit([], []);
    } else {
      for (let attempt = 0; ; attempt += 1) {
        revision = present[present.length - 1] ?? -1;
        try {
          ({ id, entries } = readRevision(join(path, revisionName(revision)), revision));
          break;
        } catch (error) {
          // Deleted since it was listed: a writer that ignores the lock has moved on, so look again.
          if (errnoOf(error) !== 'ENOENT' || attempt === 3) throw error;
          present = revisionsIn(path);
        }
      }
      prune();
    }
  } catch (error) {
    lock.release();
    throw error;
  }

  return {
    path,
    get revision() {
      return revision;
    },
    async get(key) {
      ensureUsable();
      const value = entries.get(key);
      return value === undefined ? undefined : copyJson(value);
    },
    async set(key, value) {
      commit([], [{ type: 'set', key, value }]);
    },
    async delete(key) {
      commit([], [{ type: 'delete', key }]);
    },
    async list(prefix) {
      ensureUsable();
      return listEntries(entries, prefix);
    },
    async batch(operations) {
      commit([], operations);
    },
    async compareAndSet(expected, operations) {
      return commit(expected, operations);
    },
    async close() {
      if (!open) return;
      open = false;
      lock.release();
    },
  };
}
