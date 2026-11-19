// Slots for requests in flight, shared by the RPC and Blockbook clients.

/** Why a call gave up its place in the queue. */
export type GaveUp = 'timeout' | 'aborted';

/**
 * At most `max` holders at once (0 for no limit), the rest waiting in call
 * order. A waiter leaves the queue when its signal aborts or its time runs
 * out, so a call's own limits hold while it waits. A slot passes straight
 * from the holder that releases it to the next waiter, and a release
 * function frees its slot once however often it is called.
 */
export class Limiter {
  readonly #max: number;
  #held = 0;
  readonly #waiting: (() => void)[] = [];

  constructor(max: number) {
    this.#max = max;
  }

  /** Resolves to the function that frees the slot, or rejects with `fail(reason)` once the call gives up waiting. */
  acquire(options: { signal?: AbortSignal | null | undefined; timeout?: number | undefined }, fail: (reason: GaveUp) => Error): Promise<() => void> {
    if (this.#max === 0 || this.#held < this.#max) {
      this.#held++;
      return Promise.resolve(this.#release());
    }
    const { signal, timeout = 0 } = options;
    if (signal?.aborted === true) return Promise.reject(fail('aborted'));
    return new Promise((resolve, reject) => {
      const grant = (): void => {
        stop();
        resolve(this.#release());
      };
      const giveUp = (reason: GaveUp): void => {
        const at = this.#waiting.indexOf(grant);
        if (at < 0) return;
        this.#waiting.splice(at, 1);
        stop();
        reject(fail(reason));
      };
      const onAbort = (): void => giveUp('aborted');
      const timer = timeout > 0 ? setTimeout(() => giveUp('timeout'), timeout) : undefined;
      const stop = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#waiting.push(grant);
    });
  }

  #release(): () => void {
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      const next = this.#waiting.shift();
      if (next === undefined) this.#held--;
      else next();
    };
  }
}
