// What the Node file stores share: writes that are whole and on disk before
// they count, and a lock file that knows its owner. Imports node:fs, so only
// store-file.ts and xmss-file-store.ts import it. Not a subpath export.
//
// The lock is a file holding a random id, written whole and linked into
// place, so it is taken by exactly one of any number of takers. Its holder
// touches it every heartbeat and checks that the id in it is still its own
// before every write; it removes the file only while that holds. A lock is
// called stale when it was made on this host, its process is not running as
// seen from here, and it has not been touched for the stale interval: a
// process id alone says nothing across PID namespaces, where a live holder
// in another container looks gone, and a live holder keeps touching. Taking
// a lock over renames the new lock over the old one, which replaces it in
// one step, and then reads it back, so of two takers one finds the other's
// id and stops.
//
// A lock keeps honest writers apart. It cannot stop a process that ignores
// it or an operator who breaks it while its holder lives, so neither store
// relies on it for what must never happen twice: each commits through an
// exclusive create that only one writer can win.

/// <reference types="node" />

import { closeSync, fstatSync, fsyncSync, linkSync, openSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';

/** A lock is not stale until it has gone untouched this long, unless the opener says otherwise. */
export const DEFAULT_STALE_LOCK_MS = 10_000;

/** How the file stores take their lock. */
export interface FileLockOptions {
  /**
   * Take over a lock that is stale: made on this host, by a process that is
   * no longer running, and not touched for staleLockAfter. Off unless given. A
   * lock from another host, or one its holder still touches, is never stale.
   */
  breakStaleLock?: boolean;
  /**
   * Take the lock over whatever it says. For an operator who knows the
   * holder is gone when the library cannot tell, as with a lock made on
   * another host. A holder that is in fact alive has its next write refused.
   */
  breakLock?: boolean;
  /** How long a lock must go untouched before it can be stale, in milliseconds. DEFAULT_STALE_LOCK_MS unless given. */
  staleLockAfter?: number;
}

/** Who holds a lock, as its file says. */
export interface LockOwner {
  id: string;
  pid: number;
  host: string;
  heartbeatMs: number;
}

/** Thrown by acquireLock when another holder has the lock; the stores turn it into their own error. */
export class LockHeldError extends Error {
  constructor(
    readonly owner: LockOwner | null,
    /** Whether breakStaleLock would take it. */
    readonly stale: boolean,
  ) {
    super('lock held');
  }

  /** Who holds it and what the caller can do, without advice that could let two writers in. */
  describe(): string {
    const who = this.owner === null ? 'another store' : `process ${this.owner.pid} on ${this.owner.host}`;
    const next = this.stale
      ? 'that process is no longer running and has stopped touching the lock, so open with breakStaleLock: true to take it over'
      : 'if you are certain its holder is gone, open with breakLock: true; a holder that is still alive will have its writes refused';
    return `is locked by ${who}; ${next}`;
  }
}

/** A lock this process took. */
export interface HeldLock {
  /** Whether the lock file still holds this lock's id. */
  owned(): boolean;
  /** Removes the lock file if it is still this lock's, and stops the heartbeat. */
  release(): void;
}

export function errnoOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

/**
 * Writes text to a new or truncated file and fsyncs it. write(2) may take
 * fewer bytes than it was given without failing, on a nearly full disk for
 * one, so this writes until every byte is taken and then checks the size.
 * Throws, leaving a partial file, when the bytes cannot all be written.
 */
export function writeDurably(path: string, text: string, flags: string): void {
  const bytes = Buffer.from(text, 'utf8');
  const fd = openSync(path, flags, 0o600);
  try {
    for (let written = 0; written < bytes.length; ) {
      const count = writeSync(fd, bytes.subarray(written));
      if (!Number.isSafeInteger(count) || count <= 0) throw new Error(`wrote ${written} of ${bytes.length} bytes to ${path}`);
      written += count;
    }
    fsyncSync(fd);
    const size = fstatSync(fd).size;
    if (size !== bytes.length) throw new Error(`${path} holds ${size} bytes after a write of ${bytes.length}`);
  } finally {
    closeSync(fd);
  }
}

/** Makes a rename, link or unlink in the directory of path durable, where the platform can. */
export function syncDirectory(directory: string): void {
  let fd: number;
  try {
    fd = openSync(directory, 'r');
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

// Windows refuses to replace a file another process has open, for as long as it is open.
const WINDOWS_IN_USE = ['EPERM', 'EACCES', 'EBUSY'];
const pause = new Int32Array(new SharedArrayBuffer(4));

/** Whether a rename failed because Windows found the file in use, after renameSteady's retries. */
export function inUse(error: unknown): boolean {
  return process.platform === 'win32' && WINDOWS_IN_USE.includes(errnoOf(error) ?? '');
}

/**
 * renameSync, tried again for a quarter of a second while Windows reports
 * either file in use: a reader holds a file for the moment it reads it.
 */
export function renameSteady(from: string, to: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      if (!inUse(error) || attempt === 9) throw error;
      Atomics.wait(pause, 0, 0, 5 * (attempt + 1));
    }
  }
}

/**
 * What the file store's link of revision `linked` means once the revision it was built on
 * is gone. Pruning at revision R deletes everything under R - 1, so the base
 * went because some writer reached `linked + 1`. If that is still the newest,
 * nothing can have pruned `linked` before this link was made, so the writer
 * read this link as its base and the write stands. Further on, a writer far
 * behind that linked a long-deleted name looks the same.
 */
export function linkOutcome(linked: number, newest: number): 'written' | 'unknown' {
  return newest === linked + 1 ? 'written' : 'unknown';
}

export function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone.
  }
}

/** 16 random bytes as hex: the id of a lock or of one committed state. */
export function randomId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function readOwner(lockPath: string): LockOwner | null {
  try {
    const owner = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<LockOwner> | null;
    if (owner === null || typeof owner !== 'object' || typeof owner.id !== 'string' || typeof owner.pid !== 'number' || typeof owner.host !== 'string') return null;
    return { id: owner.id, pid: owner.pid, host: owner.host, heartbeatMs: typeof owner.heartbeatMs === 'number' ? owner.heartbeatMs : 0 };
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

/**
 * Takes the lock at lockPath or throws LockHeldError. The caller releases it;
 * it is also released when the process exits normally.
 */
export function acquireLock(lockPath: string, options: FileLockOptions = {}): HeldLock {
  const staleMs = options.staleLockAfter ?? DEFAULT_STALE_LOCK_MS;
  if (!Number.isFinite(staleMs) || staleMs <= 0) throw new RangeError('staleLockAfter must be a positive number');
  const heartbeatMs = Math.max(10, Math.floor(staleMs / 5));
  const id = randomId();
  const mine = `${JSON.stringify({ id, pid: process.pid, host: hostname(), heartbeatMs })}\n`;
  const candidate = `${lockPath}.${id}.tmp`;
  writeDurably(candidate, mine, 'wx');
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        // A link either puts the whole lock in place or fails because one is there.
        linkSync(candidate, lockPath);
        break;
      } catch (error) {
        if (errnoOf(error) !== 'EEXIST') {
          // No hard links here: an exclusive create is as exclusive, though a reader may catch it half written and see an unknown holder.
          try {
            writeDurably(lockPath, mine, 'wx');
            break;
          } catch (second) {
            if (errnoOf(second) !== 'EEXIST') throw second;
          }
        }
      }
      const owner = readOwner(lockPath);
      let age: number;
      try {
        // The candidate was written a moment ago by the same file system, so its time is that clock's now.
        age = statSync(candidate).mtimeMs - statSync(lockPath).mtimeMs;
      } catch (error) {
        // The lock went away between the two looks: try for it again.
        if (errnoOf(error) === 'ENOENT' && attempt < 3) continue;
        throw new LockHeldError(owner, false);
      }
      const stale =
        owner !== null &&
        owner.host === hostname() &&
        owner.pid !== process.pid &&
        !isRunning(owner.pid) &&
        age > Math.max(staleMs, 5 * owner.heartbeatMs);
      if (options.breakLock !== true && !(stale && options.breakStaleLock === true)) throw new LockHeldError(owner, stale);
      // One step replaces the old lock; of two takers the later rename stands, and the other reads its id below.
      try {
        renameSteady(candidate, lockPath);
      } catch (error) {
        // Still in use: another taker is at the same lock, and this one does not have it.
        if (inUse(error)) throw new LockHeldError(readOwner(lockPath), false);
        throw error;
      }
      if (readOwner(lockPath)?.id !== id) throw new LockHeldError(readOwner(lockPath), false);
      break;
    }
  } finally {
    removeQuietly(candidate);
  }
  syncDirectory(dirname(lockPath));

  let held = true;
  const owned = (): boolean => held && readOwner(lockPath)?.id === id;
  const timer = setInterval(() => {
    if (!owned()) return;
    const now = new Date();
    try {
      utimesSync(lockPath, now, now);
    } catch {
      // Gone since the look above; the next write finds out.
    }
  }, heartbeatMs);
  timer.unref();
  const release = (): void => {
    if (!held) return;
    held = false;
    clearInterval(timer);
    process.removeListener('exit', release);
    // A lock that already names someone else is left where it is: moving it would leave its holder without one for a moment.
    const current = readOwner(lockPath);
    if (current !== null && current.id !== id) return;
    // Moved aside in one step and only then read, so a look and a removal cannot straddle a takeover;
    // a lock someone took over is theirs now and goes back, unless a newer one is already in its place.
    const aside = `${lockPath}.${randomId()}.tmp`;
    try {
      renameSteady(lockPath, aside);
    } catch {
      return;
    }
    if (readOwner(aside)?.id !== id) {
      try {
        linkSync(aside, lockPath);
      } catch (error) {
        // EEXIST: taken again meanwhile. Otherwise no hard links here, and an exclusive create puts it back.
        if (errnoOf(error) !== 'EEXIST') {
          try {
            writeDurably(lockPath, readFileSync(aside, 'utf8'), 'wx');
          } catch {
            // Taken again meanwhile.
          }
        }
      }
    }
    removeQuietly(aside);
  };
  process.once('exit', release);
  return { owned, release };
}
