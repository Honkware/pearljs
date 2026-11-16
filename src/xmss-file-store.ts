// A file-backed XmssIndexStore for Node. It is a module of its own, outside
// the main entry point, so browser bundles never import node:fs.
//
// One state file belongs to one XMSS key and records the next unused index:
//
//   {"version":1,"publicKey":"<128 hex chars>","next":3}
//
// Beside it, each index that has been handed out has a marker file,
// <path>.index-00 to <path>.index-30. reserve creates the marker of the next
// index exclusively and fsyncs it and the directory, and only then returns
// the index: a marker can be created once, so of any number of stores or
// processes on one state file, with or without the lock, at most one is
// ever given a particular index, and the others fail. The state file is
// then rewritten through a temporary file and a rename. A crash after the
// marker wastes the index; nothing hands it out again, because a store that
// opens takes the higher of the state file and the markers. Markers are
// never deleted.
//
// A lock file next to the state file (internal/node-files.ts), held until
// close, keeps a second store or a second process from opening the same
// state file at all, and reserve checks the lock and the state file on disk
// before it creates a marker.

/// <reference types="node" />

/**
 * A file-backed XMSS index store for Node. Not re-exported by the main entry,
 * because it imports node:fs.
 *
 * @module
 */

import { existsSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { XMSS_LAST_INDEX, XMSS_MAX_SIGNATURES, XMSS_PUBLIC_KEY_LENGTH } from './xmss.js';
import type { XmssIndexStore } from './xmss.js';
import { toHex } from './internal/bytes.js';
import { LockHeldError, acquireLock, errnoOf, removeQuietly, syncDirectory, writeDurably } from './internal/node-files.js';
import type { FileLockOptions, HeldLock } from './internal/node-files.js';

export type { FileLockOptions } from './internal/node-files.js';
import { XmssError } from './errors.js';

const STATE_VERSION = 1;

/** Options for createFileXmssIndexStore. */
export interface FileXmssIndexStoreOptions extends FileLockOptions {
  /**
   * Start a new state file at index 0. The file must not exist yet, and no
   * index markers may be left beside it. Without this the file must exist,
   * so a mistyped or lost path fails instead of quietly starting again at
   * index 0.
   */
  create?: boolean;
}

export interface FileXmssIndexStore extends XmssIndexStore {
  /**
   * Reserves the next index for the key this file belongs to; synchronous and
   * durable. Throws XMSS_INDEX_EXHAUSTED, writing nothing, once index 30 has
   * been handed out, XMSS_STORE_LOCKED when the store no longer holds its
   * lock, and XMSS_INDEX_REUSE when another writer has used the state file;
   * after either of the last two the store refuses every call.
   */
  reserve(publicKey: Uint8Array): number;
  /** The index reserve would return next. The key may be left out; given, it must be the file's. */
  peek(publicKey?: Uint8Array): number;
  /** Releases the lock file. The store cannot be used afterwards. */
  close(): void;
}

interface State {
  version: number;
  publicKey: string | null;
  next: number;
}

function isMissing(error: unknown): boolean {
  return errnoOf(error) === 'ENOENT';
}

const markerPath = (path: string, index: number): string => `${path}.index-${String(index).padStart(2, '0')}`;

// One past the highest index that has a marker, or 0.
function markedNext(path: string): number {
  const prefix = `${basename(path)}.index-`;
  let next = 0;
  for (const name of readdirSync(dirname(path))) {
    if (!name.startsWith(prefix) || !/^[0-9]{2}$/.test(name.slice(prefix.length))) continue;
    next = Math.max(next, Number(name.slice(prefix.length)) + 1);
  }
  return next;
}

function readState(path: string): State {
  const text = readFileSync(path, 'utf8');
  let state: Partial<State> | null = null;
  try {
    state = JSON.parse(text) as Partial<State> | null;
  } catch {
    // Reported below with every other malformed state.
  }
  if (
    state === null ||
    typeof state !== 'object' ||
    state.version !== STATE_VERSION ||
    !Number.isSafeInteger(state.next) ||
    state.next! < 0 ||
    !(state.publicKey === null || (typeof state.publicKey === 'string' && /^[0-9a-f]{128}$/.test(state.publicKey)))
  ) {
    throw new XmssError('XMSS_STORE_INVALID', `XMSS index state file ${path} is not valid; refusing to guess the next index`);
  }
  // An index with a marker has been handed out, whatever the state file had time to say.
  return { version: STATE_VERSION, publicKey: state.publicKey!, next: Math.max(state.next!, markedNext(path)) };
}

/** What an XMSS index state file holds, as readXmssIndexFile reports it. */
export interface XmssIndexFileState {
  /** The key the file belongs to as 128 hex characters, or null before its first signature. */
  publicKey: string | null;
  /** The next unused index: how many signatures the key has made. */
  next: number;
  /** Signatures the key has left. */
  remaining: number;
  /** Whether a store holds the file's lock right now, or a process died holding it. */
  locked: boolean;
}

/**
 * Reads an XMSS index state file without locking or changing it, so it works
 * while a signer has the file open. Throws XMSS_STORE_INVALID when the file is
 * missing or damaged.
 */
export function readXmssIndexFile(path: string): XmssIndexFileState {
  let state: State;
  try {
    state = readState(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
    throw new XmssError('XMSS_STORE_INVALID', `XMSS index state file ${path} does not exist`);
  }
  return {
    publicKey: state.publicKey,
    next: state.next,
    remaining: Math.max(0, XMSS_MAX_SIGNATURES - state.next),
    locked: existsSync(`${path}.lock`),
  };
}

/**
 * Opens the XMSS index state file at path and locks it. Use one file per
 * key, never copy or restore it from a backup, and call close when done. The
 * lock is also released when the process exits normally.
 *
 * Throws when the file is locked by another store, when it does not exist and
 * create is not set, when it exists and create is set, and when it cannot be
 * parsed. reserve throws for a key other than the one the file belongs to.
 */
export function createFileXmssIndexStore(path: string, options: FileXmssIndexStoreOptions = {}): FileXmssIndexStore {
  if (typeof path !== 'string' || path.length === 0) {
    throw new TypeError('XMSS index state file path must be a non-empty string');
  }
  let lock: HeldLock;
  try {
    lock = acquireLock(`${path}.lock`, options);
  } catch (error) {
    if (error instanceof LockHeldError) {
      throw new XmssError('XMSS_STORE_LOCKED', `XMSS index state file ${path} ${error.describe()}. Two signers must never share a key`);
    }
    throw error;
  }

  let open = true;
  let failure: XmssError | null = null;
  const fail = (error: XmssError): XmssError => {
    failure = error;
    return error;
  };
  const write = (state: State, flags: 'w' | 'wx'): void => {
    const text = `${JSON.stringify(state)}\n`;
    if (flags === 'wx') {
      writeDurably(path, text, 'wx');
    } else {
      const temporary = `${path}.tmp`;
      try {
        writeDurably(temporary, text, 'w');
        renameSync(temporary, path);
      } catch (error) {
        removeQuietly(temporary);
        throw error;
      }
    }
    syncDirectory(dirname(path));
  };

  let state: State;
  try {
    if (options.create === true) {
      if (markedNext(path) > 0) {
        throw new XmssError('XMSS_STORE_INVALID', `index markers ${path}.index-* of an earlier key are present; a new key needs a path of its own`);
      }
      state = { version: STATE_VERSION, publicKey: null, next: 0 };
      // 'wx' fails when the file exists, so an existing key's state is never reset.
      write(state, 'wx');
    } else {
      state = readState(path);
    }
  } catch (error) {
    lock.release();
    if (errnoOf(error) === 'EEXIST') {
      throw new XmssError('XMSS_STORE_INVALID', `XMSS index state file ${path} already exists; open it without create`);
    }
    if (isMissing(error)) {
      throw new XmssError('XMSS_STORE_INVALID',
        `XMSS index state file ${path} does not exist; pass create: true only for a key that has never signed`,
      );
    }
    throw error;
  }

  const ensureUsable = (): void => {
    if (!open) throw new XmssError('XMSS_STORE_INVALID', 'this XMSS index store is closed');
    if (failure !== null) throw failure;
  };
  const checked = (publicKey: Uint8Array): string => {
    ensureUsable();
    if (!(publicKey instanceof Uint8Array) || publicKey.length !== XMSS_PUBLIC_KEY_LENGTH) {
      throw new Error(`XMSS public key must be ${XMSS_PUBLIC_KEY_LENGTH} bytes`);
    }
    const key = toHex(publicKey);
    if (state.publicKey !== null && state.publicKey !== key) {
      throw new XmssError('XMSS_STORE_INVALID', `XMSS index state file ${path} belongs to a different key`);
    }
    return key;
  };

  return {
    reserve(publicKey: Uint8Array): number {
      const key = checked(publicKey);
      if (!lock.owned()) {
        throw fail(new XmssError('XMSS_STORE_LOCKED', `XMSS index state file ${path} is no longer locked by this store: its lock was removed or taken over. No index was reserved; reopen the store`));
      }
      let durable: State;
      try {
        durable = readState(path);
      } catch (error) {
        throw fail(new XmssError('XMSS_STORE_INVALID', `XMSS index state file ${path} can no longer be read; no index was reserved`, { cause: error }));
      }
      if (durable.next !== state.next || durable.publicKey !== state.publicKey) {
        throw fail(new XmssError('XMSS_INDEX_REUSE', `XMSS index state file ${path} is not as this store left it: another signer is using the key. No index was reserved; reopen the store`));
      }
      const index = state.next;
      if (index > XMSS_LAST_INDEX) {
        throw new XmssError('XMSS_INDEX_EXHAUSTED', `this XMSS key has used all ${XMSS_MAX_SIGNATURES} of its signatures`);
      }
      try {
        // The reservation: only one writer can ever create this file.
        writeDurably(markerPath(path, index), `${key}\n`, 'wx');
      } catch (error) {
        // Created, even if not written whole, the marker stands: the index is spent, and this store did not get it.
        if (errnoOf(error) === 'EEXIST') {
          throw fail(new XmssError('XMSS_INDEX_REUSE', `XMSS index ${index} of ${path} has been reserved by another signer. Nothing was signed with it here; reopen the store`));
        }
        throw fail(new XmssError('XMSS_STORE_INVALID', `could not record XMSS index ${index} of ${path} as used; nothing was signed with it. Reopen the store: ${(error as Error).message}`, { cause: error }));
      }
      syncDirectory(dirname(path));
      const advanced: State = { version: STATE_VERSION, publicKey: key, next: index + 1 };
      state = advanced;
      try {
        write(advanced, 'w');
      } catch {
        // The marker already holds the index; the next open reads it.
      }
      return index;
    },
    peek(publicKey?: Uint8Array): number {
      if (publicKey !== undefined) checked(publicKey);
      else ensureUsable();
      return state.next;
    },
    close(): void {
      if (!open) return;
      open = false;
      lock.release();
    },
  };
}
