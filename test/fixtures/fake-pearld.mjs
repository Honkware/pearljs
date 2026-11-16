// Stands in for the pearld and oyster binaries in test/testing-regtest.test.ts:
// reads the flags startRegtest passes, writes the certificate where
// --rpccert says, and answers the few RPC calls the launcher makes over TLS.
// FAKE_CERT and FAKE_KEY name a certificate pair the test made.
import { Buffer } from 'node:buffer';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import process from 'node:process';
import { setTimeout } from 'node:timers';

const flags = Object.fromEntries(process.argv.slice(2).map((arg) => arg.replace(/^--/, '').split(/=(.*)/s, 2)));
writeFileSync(process.env.FAKE_ARGS, `${JSON.stringify(process.argv.slice(2))}\n`, { flag: 'a' });
if ('createfromfile' in flags) {
  // Oyster's wallet creation run: read the seed file and leave.
  JSON.parse(readFileSync(flags.createfromfile, 'utf8'));
  process.exit(0);
}
if (process.env.FAKE_CRASH === '1') {
  process.stderr.write('fake pearld: refusing to start\n');
  process.exit(3);
}
const cert = readFileSync(process.env.FAKE_CERT);
writeFileSync(flags.rpccert, cert);
const user = flags.rpcuser ?? flags.username;
const pass = flags.rpcpass ?? flags.password;
let height = 0;
let busy = Number(process.env.FAKE_BUSY ?? 0);
const server = createServer({ cert, key: readFileSync(process.env.FAKE_KEY) }, (req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    if (req.headers.authorization !== `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`) {
      res.writeHead(401).end();
      return;
    }
    const { id, method, params } = JSON.parse(body);
    const reply = (result, error = null) => res.end(JSON.stringify({ jsonrpc: '1.0', result, error, id }));
    if (method === 'getblockcount') return reply(height);
    if (method === 'getinfo') return reply({ blocks: height });
    if (method === 'generate') {
      if (busy-- > 0) return reply(null, { code: -1, message: 'Server is already CPU mining. Please call `setgenerate 0` before calling discrete `generate` commands.' });
      return reply(Array.from({ length: params[0] }, () => (++height).toString(16).padStart(64, '0')));
    }
    if (method === 'stop') {
      reply('stopping.');
      return setTimeout(() => process.exit(0), 20);
    }
    return reply(null, { code: -32601, message: 'Method not found' });
  });
});
server.listen(Number(flags.rpclisten.split(':')[1]), '127.0.0.1');
