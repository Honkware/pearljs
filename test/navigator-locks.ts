import { afterAll, beforeAll } from 'vitest';

/** Puts `locks` at navigator.locks for the file's tests. Node 20 has no navigator global, so one is made. */
export function useNavigatorLocks(locks: unknown): void {
  let previous: PropertyDescriptor | undefined;
  let made = false;
  beforeAll(() => {
    if (globalThis.navigator === undefined) {
      Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
      made = true;
    }
    previous = Object.getOwnPropertyDescriptor(globalThis.navigator, 'locks');
    Object.defineProperty(globalThis.navigator, 'locks', { value: locks, configurable: true });
  });
  afterAll(() => {
    if (made) delete (globalThis as { navigator?: unknown }).navigator;
    else if (previous === undefined) delete (globalThis.navigator as { locks?: unknown }).locks;
    else Object.defineProperty(globalThis.navigator, 'locks', previous);
  });
}
