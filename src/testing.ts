// The test kit: a simulated chain and node, the keys to drive it, and
// nothing that needs Node. The regtest launcher is in testing-regtest.

/**
 * A test kit for applications built on pearljs: a simulated chain that is a
 * wallet backend, an RPC server and a websocket server at once, a faucet, and
 * fixed test keys. Runs anywhere pearljs runs; import it from test code only.
 * `pearljs/testing-regtest` starts a real pearld instead.
 *
 * @module
 */

export * from './testing/chain.js';
export * from './testing/keys.js';
export type { SimulatedSocket, SimulatedWebSocket } from './testing/socket.js';
