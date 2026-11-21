// Starts a browser headless and evaluates expressions in a page: Chrome over
// the DevTools protocol, Firefox over WebDriver BiDi, Safari over safaridriver.
// Each launch returns { name, version, open(url), evaluate(expression), close() }.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearTimeout } from 'node:timers';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket } from 'undici';

const first = (paths) => paths.filter(Boolean).find((p) => existsSync(p));

export const binaries = {
  chrome: () => first([process.env.CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe']),
  firefox: () => first([process.env.FIREFOX, '/Applications/Firefox.app/Contents/MacOS/firefox', '/usr/bin/firefox', 'C:\\Program Files\\Mozilla Firefox\\firefox.exe']),
  'firefox-private': () => binaries.firefox(),
  safari: () => first(['/usr/bin/safaridriver']),
};

async function openSocket(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error(`cannot connect to ${url}`));
  });
  let id = 0;
  const pending = new Map();
  const listeners = new Set();
  socket.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    const waiting = msg.id !== undefined && pending.get(msg.id);
    if (!waiting) {
      for (const listener of listeners) listener(msg);
      return;
    }
    pending.delete(msg.id);
    if (msg.error) waiting.reject(new Error(typeof msg.error === 'string' ? `${msg.error}: ${msg.message}` : msg.error.message));
    else waiting.resolve(msg.result);
  };
  const send = (method, params = {}, extra = {}) =>
    new Promise((resolve, reject) => {
      const mine = ++id;
      pending.set(mine, { resolve, reject });
      socket.send(JSON.stringify({ id: mine, method, params, ...extra }));
    });
  return { send, listen: (fn) => (listeners.add(fn), () => listeners.delete(fn)), close: () => socket.close() };
}

function stopper(proc, profile) {
  return async () => {
    if (proc.exitCode === null) {
      const exited = new Promise((resolve) => proc.once('exit', resolve));
      proc.kill();
      await exited;
    }
    if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  };
}

/** Chrome over the DevTools protocol. `args` are extra command-line flags. */
export async function launchChrome({ args = [], profile: given } = {}) {
  const profile = given ?? mkdtempSync(join(tmpdir(), 'pearljs-chrome-'));
  const proc = spawn(binaries.chrome(), ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, ...args, 'about:blank'], { stdio: 'ignore' });
  const deadline = Date.now() + 30_000;
  let port;
  while (!port) {
    if (Date.now() > deadline) throw new Error('Chrome did not open its DevTools port');
    await sleep(100);
    try {
      port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
    } catch {
      // Not written yet.
    }
  }
  const info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const cdp = await openSocket(info.webSocketDebuggerUrl);
  const page = (sessionId) => ({
    sessionId,
    send: (method, params) => cdp.send(method, params, { sessionId }),
    listen: (fn) => cdp.listen((msg) => msg.sessionId === sessionId && fn(msg)),
    async evaluate(expression) {
      const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, { sessionId });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    },
  });
  let current;
  return {
    name: 'chrome',
    version: info.Browser,
    cdp,
    profile,
    /** Opens url in a new tab and returns that tab, which also becomes the one evaluate uses. */
    async open(url) {
      const { targetId } = await cdp.send('Target.createTarget', { url });
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      current = { ...page(sessionId), targetId };
      return current;
    },
    async attach(targetId) {
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      return { ...page(sessionId), targetId };
    },
    evaluate: (expression) => current.evaluate(expression),
    close: async () => {
      cdp.close();
      await stopper(proc, given ? null : profile)();
    },
  };
}

/** Firefox over WebDriver BiDi. `prefs` are written to the new profile's user.js. */
export async function launchFirefox({ prefs = {} } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'pearljs-firefox-'));
  writeFileSync(join(profile, 'user.js'), Object.entries(prefs).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});\n`).join(''));
  const proc = spawn(binaries.firefox(), ['--headless', '--no-remote', '--remote-debugging-port=0', '--profile', profile], { stdio: ['ignore', 'pipe', 'pipe'] });
  const stop = stopper(proc, profile);
  const endpoint = await new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(() => reject(new Error(`Firefox did not start WebDriver BiDi: ${text.slice(-300)}`)), 30_000);
    const read = (chunk) => {
      text += chunk;
      const m = /WebDriver BiDi listening on (ws:\/\/\S+)/.exec(text);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    };
    proc.stdout.on('data', read);
    proc.stderr.on('data', read);
  }).catch(async (error) => {
    await stop();
    throw error;
  });
  const bidi = await openSocket(`${endpoint}/session`);
  const session = await bidi.send('session.new', { capabilities: {} });
  const { contexts } = await bidi.send('browsingContext.getTree', {});
  const context = contexts[0].context;
  return {
    name: 'firefox',
    version: `Firefox/${session.capabilities.browserVersion}`,
    bidi,
    async open(url) {
      await bidi.send('browsingContext.navigate', { context, url, wait: 'complete' });
    },
    async evaluate(expression) {
      const r = await bidi.send('script.evaluate', { expression, target: { context }, awaitPromise: true, resultOwnership: 'none' });
      if (r.type === 'exception') throw new Error(r.exceptionDetails.text);
      return r.result.value;
    },
    close: async () => {
      await bidi.send('session.end').catch(() => undefined);
      bidi.close();
      await stop();
    },
  };
}

/**
 * Safari over safaridriver. Needs remote automation turned on once, with
 * `safaridriver --enable` (it asks for an administrator password).
 */
export async function launchSafari() {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const proc = spawn(binaries.safari(), ['-p', String(port)], { stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    const json = await response.json();
    if (json.value?.error) throw new Error(`${json.value.error}: ${json.value.message}`);
    return json.value;
  };
  let session;
  try {
    for (let i = 0; i < 40 && !session; i++) {
      await sleep(250);
      session = await call('POST', '/session', { capabilities: { alwaysMatch: { browserName: 'safari' } } }).catch((error) => {
        if (/Remote Automation/.test(error.message)) throw new Error('Safari refuses WebDriver: run `safaridriver --enable` once, or tick Allow Remote Automation in Safari\'s Develop menu, then run this again');
        return undefined;
      });
    }
  } catch (error) {
    await stopper(proc, null)();
    throw error;
  }
  if (!session) {
    await stopper(proc, null)();
    throw new Error('safaridriver did not start');
  }
  const id = session.sessionId;
  return {
    name: 'safari',
    version: `Safari/${session.capabilities.browserVersion}`,
    open: (url) => call('POST', `/session/${id}/url`, { url }),
    evaluate: (expression) => call('POST', `/session/${id}/execute/sync`, { script: `return (${expression});`, args: [] }),
    close: async () => {
      await call('DELETE', `/session/${id}`).catch(() => undefined);
      await stopper(proc, null)();
    },
  };
}

export const launchers = {
  chrome: launchChrome,
  firefox: launchFirefox,
  // Every window private, where Firefox keeps IndexedDB in memory for the session.
  'firefox-private': () => launchFirefox({ prefs: { 'browser.privatebrowsing.autostart': true } }),
  safari: launchSafari,
};

/** Polls expression in the browser's page until it yields something other than null or undefined. */
export async function waitFor(browser, expression, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await browser.evaluate(expression);
      if (value !== null && value !== undefined) return value;
    } catch (error) {
      last = error;
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${expression}${last ? ` (${last.message})` : ''}`);
}
