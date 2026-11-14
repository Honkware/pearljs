// A file-backed XmssIndexStore for Node. It is a module of its own, outside
// the main entry point, so browser bundles never import node:fs.
//
// One state file belongs to one XMSS key and records the next unused index:
//
//   {"version":1,"publicKey":"<128 hex chars>","next":3}
//
// reserve writes the advanced state to a temporary file, fsyncs it, renames
// it over the state file and fsyncs the directory before it returns the
// index, so an index is on disk as used before anything is signed with it. A
// crash after that wastes the index; nothing hands it out again.
//
// A lock file next to the state file, created exclusively and held until
// close, keeps a second store or a second process off the same state file.
// A process that dies without closing leaves the lock behind; it is never
// broken automatically, because doing so on a guess could let two signers
// share a key.

/// <reference types="node" />

import { closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { XMSS_PUBLIC_KEY_LENGTH } from './xmss.js';
import type { XmssIndexStore } from './xmss.js';

const STATE_VERSION = 1;

export interface FileXmssIndexStoreOptions {
  /**
   * Start a new state file at index 0. The file must not exist yet. Without
   * this the file must exist, so a mistyped or lost path fails instead of
   * quietly starting again at index 0.
   */
  create?: boolean;
}

export interface FileXmssIndexStore extends XmssIndexStore {
  /** Reserves the next index for the key this file belongs to; synchronous and durable. */
  reserve(publicKey: Uint8Array): number;
  /** Releases the lock file. The store cannot be used afterwards. */
  close(): void;
}

interface State {
  version: number;
  publicKey: string | null;
  next: number;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
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
    throw new Error(`XMSS index state file ${path} is not valid; refusing to guess the next index`);
  }
  return state as State;
}

/**
 * Opens the XMSS index state file at path and locks it. Use one file per
 * key, never copy or restore it from a backup, and call close when done. The
 * lock is also released when the process exits normally.
 */
export function createFileXmssIndexStore(path: string, options: FileXmssIndexStoreOptions = {}): FileXmssIndexStore {
  if (typeof path !== 'string' || path.length === 0) {
    throw new TypeError('XMSS index state file path must be a non-empty string');
  }
  const lockPath = `${path}.lock`;
  try {
    writeDurably(lockPath, `${process.pid}\n`, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let owner = 'another store';
    try {
      owner = `process ${readFileSync(lockPath, 'utf8').trim()}`;
    } catch {
      // The lock may vanish or be unreadable; the message stays generic.
    }
    throw new Error(
      `XMSS index state file ${path} is locked by ${owner}. Two signers must never share a key; ` +
        `if that process is gone, delete ${lockPath}`,
    );
  }

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

  let state: State;
  try {
    if (options.create === true) {
      state = { version: STATE_VERSION, publicKey: null, next: 0 };
      // 'wx' fails when the file exists, so an existing key's state is never reset.
      writeDurably(path, `${JSON.stringify(state)}\n`, 'wx');
      syncDirectory(path);
    } else {
      state = readState(path);
    }
  } catch (error) {
    release();
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      throw new Error(`XMSS index state file ${path} already exists; open it without create`);
    }
    if (isMissing(error)) {
      throw new Error(
        `XMSS index state file ${path} does not exist; pass create: true only for a key that has never signed`,
      );
    }
    throw error;
  }
  process.once('exit', release);

  return {
    reserve(publicKey: Uint8Array): number {
      if (!open) throw new Error('this XMSS index store is closed');
      if (!(publicKey instanceof Uint8Array) || publicKey.length !== XMSS_PUBLIC_KEY_LENGTH) {
        throw new Error(`XMSS public key must be ${XMSS_PUBLIC_KEY_LENGTH} bytes`);
      }
      const key = toHex(publicKey);
      if (state.publicKey !== null && state.publicKey !== key) {
        throw new Error(`XMSS index state file ${path} belongs to a different key`);
      }
      const index = state.next;
      const advanced: State = { version: STATE_VERSION, publicKey: key, next: index + 1 };
      const temporary = `${path}.tmp`;
      writeDurably(temporary, `${JSON.stringify(advanced)}\n`, 'w');
      renameSync(temporary, path);
      syncDirectory(path);
      state = advanced;
      return index;
    },
    close: release,
  };
}
