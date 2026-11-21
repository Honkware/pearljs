// A fetch for Pearl's public Blockbook that counts every request it sends
// in a file shared by every process of the session, refuses once the budget
// is spent, and keeps at most two requests in flight in this process.
//
//   node scripts/network/blockbook-budget.mjs /api/v2   prints one reply
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { nodeDir } from './node.mjs';

// The server the run is pointed at, so the budget covers a mainnet run as well.
export const BLOCKBOOK_URL = (process.env.PEARL_TESTNET_BLOCKBOOK || 'https://blockbook.testnet2.pearlnetwork.net').replace(/\/$/, '');
export const COUNTER = process.env.PEARL_TESTNET_BLOCKBOOK_COUNTER ?? join(nodeDir, 'blockbook-requests');
const LIMIT = Number(process.env.PEARL_TESTNET_BLOCKBOOK_BUDGET ?? 300);
const IN_FLIGHT = 2;

// One O_EXCL lock file serialises the read-increment-write across processes.
async function take() {
  const lock = `${COUNTER}.lock`;
  for (;;) {
    try {
      closeSync(openSync(lock, 'wx'));
      break;
    } catch {
      await sleep(5);
    }
  }
  try {
    const used = requestsUsed();
    if (used >= LIMIT) throw new Error(`the Blockbook budget of ${LIMIT} requests is spent (${COUNTER})`);
    writeFileSync(COUNTER, String(used + 1));
    appendLog(used + 1);
    return used + 1;
  } finally {
    unlinkSync(lock);
  }
}

let pendingUrl = '';
const appendLog = (n) => writeFileSync(`${COUNTER}.log`, `${n} ${new Date().toISOString()} ${pendingUrl}\n`, { flag: 'a' });

export function requestsUsed() {
  return existsSync(COUNTER) ? Number(readFileSync(COUNTER, 'utf8')) : 0;
}

/** @returns {typeof fetch} */
export function budgetFetch() {
  let active = 0;
  /** @type {(() => void)[]} */
  const waiting = [];
  return async (input, init) => {
    const url = input instanceof globalThis.Request ? input.url : String(input);
    if (!url.startsWith(BLOCKBOOK_URL)) throw new Error(`budgetFetch only talks to ${BLOCKBOOK_URL}, not ${url}`);
    while (active >= IN_FLIGHT) await new Promise((resolve) => waiting.push(resolve));
    active++;
    try {
      pendingUrl = url.slice(BLOCKBOOK_URL.length);
      await take();
      return await fetch(input, init);
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

if (process.argv[1]?.endsWith('blockbook-budget.mjs') && process.argv[2] !== undefined) {
  const reply = await budgetFetch()(`${BLOCKBOOK_URL}${process.argv[2]}`);
  console.log(reply.status, await reply.text());
}
